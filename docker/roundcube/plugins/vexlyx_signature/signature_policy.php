<?php
/**
 * Decides what Roundcube should do about a mailbox's signature (F5.31).
 *
 * No Roundcube code in here, so it can be tested on its own: the plugin passes in
 * the user's identities and preferences and gets back the changes to make.
 *
 * The data comes from one JSON file per mailbox written by the panel
 * (see system/python/signature_manager.py); this class only reads it.
 */
class Vexlyx_Signature_Policy
{
    /** Matches the validation signature_manager.py applies before it writes a file. \z, not $, so a trailing newline can't slip through. */
    private const ADDRESS_PATTERN = '/^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,}\z/';

    private string $dir;

    public function __construct(string $dir)
    {
        $this->dir = rtrim($dir, '/');
    }

    /** The mailbox's data file, or null when there is none or it can't be trusted. */
    public function read(string $username): ?array
    {
        $address = strtolower($username);
        if (!preg_match(self::ADDRESS_PATTERN, $address)) {
            return null;
        }
        $data = $this->readJson($this->dir . '/' . $address . '.json');
        return ($data !== null && ($data['v'] ?? null) === 1) ? $data : null;
    }

    /** The panel's global kill switch for server-side enforcement. Missing file means on. */
    public function globalEnabled(): bool
    {
        $global = $this->readJson($this->dir . '/_global.json');
        return $global === null || ($global['enabled'] ?? true) !== false;
    }

    /** True when the mail server adds the signature itself, so webmail must not add one too. */
    public function serverSide(?array $data): bool
    {
        return $data !== null && ($data['enforceServerSide'] ?? false) === true && $this->globalEnabled();
    }

    public function locked(?array $data): bool
    {
        return $data !== null && ($data['locked'] ?? false) === true;
    }

    /** Webmail users may not edit the signature: the domain locks it, or the server owns it. */
    public function managed(?array $data): bool
    {
        return $this->locked($data) || $this->serverSide($data);
    }

    /**
     * The signature as HTML: the personal part, banners inside their dates, then the legal footer.
     * Mirrors composeSignature() in packages/shared. Null when there is nothing to show.
     */
    public function composeHtml(?array $data, int $now): ?string
    {
        if ($data === null) {
            return null;
        }
        $html = '';
        if (!empty($data['signature']['html']) && is_string($data['signature']['html'])) {
            $html .= $data['signature']['html'];
        }
        foreach (($data['banners'] ?? []) as $banner) {
            $from = isset($banner['startsAt']) ? strtotime((string) $banner['startsAt']) : false;
            $to = isset($banner['endsAt']) ? strtotime((string) $banner['endsAt']) : false;
            if ($from !== false && $to !== false && $from <= $now && $now < $to && !empty($banner['html']) && is_string($banner['html'])) {
                $html .= $banner['html'];
            }
        }
        if (!empty($data['compliance']['html']) && is_string($data['compliance']['html'])) {
            $html .= $data['compliance']['html'];
        }
        return $html === '' ? null : $html;
    }

    /** The HTML webmail should put in an identity, or null when webmail should not add one. */
    public function desiredHtml(?array $data, int $now): ?string
    {
        if ($data === null || $this->serverSide($data)) {
            return null;
        }
        return $this->composeHtml($data, $now);
    }

    /**
     * What an identity's signature fields must be, when webmail users may not choose them.
     * Null when they are free to edit their own.
     *
     * @return array{signature: string, html_signature: int}|null
     */
    public function forcedFields(?array $data, int $now): ?array
    {
        if (!$this->managed($data)) {
            return null;
        }
        $html = $this->desiredHtml($data, $now);
        return ['signature' => $html ?? '', 'html_signature' => $html === null ? 0 : 1];
    }

    /**
     * Works out what to change at login.
     *
     * @param array[] $identities rows with identity_id, standard, signature, html_signature
     * @param array   $prefs      what this plugin stored last time: ['managed' => bool, 'hash' => string]
     * @return array{updates: array<int, array{signature: string, html_signature: int}>, prefs: array|null}
     *         updates keyed by identity id; prefs is null when there is nothing to remember
     */
    public function planLogin(array $identities, ?array $data, array $prefs, int $now): array
    {
        $updates = [];
        $lastHash = (string) ($prefs['hash'] ?? '');
        $wasManaged = ($prefs['managed'] ?? false) === true;
        $desired = $this->desiredHtml($data, $now);

        if ($desired === null) {
            $everything = $this->serverSide($data);
            foreach ($identities as $identity) {
                $current = (string) ($identity['signature'] ?? '');
                $weWroteIt = $lastHash !== '' && sha1($current) === $lastHash;
                if ($current !== '' && ($everything || $weWroteIt)) {
                    $updates[(int) $identity['identity_id']] = ['signature' => '', 'html_signature' => 0];
                }
            }
            $newPrefs = ($wasManaged || $updates !== []) ? ['managed' => false, 'hash' => ''] : null;
            return ['updates' => $updates, 'prefs' => $newPrefs];
        }

        $hash = sha1($desired);
        $locked = $this->locked($data);
        $changed = false;

        foreach ($this->targets($identities, $locked) as $identity) {
            $differs = (string) ($identity['signature'] ?? '') !== $desired || empty($identity['html_signature']);
            // Locked: always put it back. Otherwise write only when the panel's content changed,
            // so a user's own edits survive until then.
            if ($locked ? $differs : ($hash !== $lastHash)) {
                $updates[(int) $identity['identity_id']] = ['signature' => $desired, 'html_signature' => 1];
                $changed = true;
            }
        }

        $newPrefs = ($changed || !$wasManaged || $hash !== $lastHash) ? ['managed' => true, 'hash' => $hash] : null;
        return ['updates' => $updates, 'prefs' => $newPrefs];
    }

    /** Locked signatures apply to every identity; otherwise just the default one. */
    private function targets(array $identities, bool $all): array
    {
        if ($all || count($identities) <= 1) {
            return $identities;
        }
        foreach ($identities as $identity) {
            if (!empty($identity['standard'])) {
                return [$identity];
            }
        }
        return [$identities[0]];
    }

    private function readJson(string $file): ?array
    {
        if (!is_file($file) || !is_readable($file)) {
            return null;
        }
        $raw = @file_get_contents($file);
        if ($raw === false) {
            return null;
        }
        $data = json_decode($raw, true);
        return is_array($data) ? $data : null;
    }
}
