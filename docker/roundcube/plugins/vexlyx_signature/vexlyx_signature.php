<?php
/**
 * Vexlyx signature plugin (F5.31).
 *
 * Puts the signature managed in the Vexlyx panel into the user's Roundcube identity at login,
 * and, when the domain locks it (or the mail server adds it), stops the webmail user changing it.
 * The rules live in signature_policy.php; this file only connects them to Roundcube's hooks.
 *
 * Reads the per-mailbox JSON files the panel writes into the mounted signatures directory
 * (default /var/roundcube/signatures, override with $config['vexlyx_signature_dir']).
 * It never talks to the panel and never writes to anything but the user's own identities.
 */
require_once __DIR__ . '/signature_policy.php';

class vexlyx_signature extends rcube_plugin
{
    public $task = 'login|settings';

    private const PREF = 'vexlyx_signature';
    private const DEFAULT_DIR = '/var/roundcube/signatures';

    private ?Vexlyx_Signature_Policy $policy = null;

    public function init()
    {
        $this->add_hook('login_after', [$this, 'on_login']);
        $this->add_hook('identity_create', [$this, 'on_identity_create']);
        $this->add_hook('identity_update', [$this, 'on_identity_update']);
        $this->add_hook('identity_form', [$this, 'on_identity_form']);
    }

    /** Brings the user's identities in line with the panel right after they sign in. */
    public function on_login($args)
    {
        $rcmail = rcmail::get_instance();
        $user = $rcmail->user;
        if (!$user) {
            return $args;
        }

        $policy = $this->policy();
        $data = $policy->read($rcmail->get_user_name());
        $prefs = $user->get_prefs();
        $plan = $policy->planLogin(
            $user->list_identities(),
            $data,
            is_array($prefs[self::PREF] ?? null) ? $prefs[self::PREF] : [],
            time()
        );

        foreach ($plan['updates'] as $identityId => $fields) {
            $user->update_identity($identityId, $fields);
        }
        if ($plan['prefs'] !== null) {
            $user->save_prefs([self::PREF => $plan['prefs']]);
        }

        return $args;
    }

    /** A new identity (including the first one, created at the very first login) starts with the managed signature. */
    public function on_identity_create($args)
    {
        $record = $args['record'] ?? [];
        $username = rcmail::get_instance()->get_user_name() ?: ($record['email'] ?? '');
        $policy = $this->policy();
        $data = $policy->read((string) $username);

        $fields = $policy->forcedFields($data, time());
        if ($fields === null && !empty($args['login'])) {
            // First sign-in of a brand-new user: start unlocked users off with the default too.
            $html = $policy->desiredHtml($data, time());
            $fields = $html === null ? null : ['signature' => $html, 'html_signature' => 1];
        }
        if ($fields !== null) {
            $args['record'] = array_merge($record, $fields);
        }
        return $args;
    }

    /** Whatever the user submitted, a locked or server-side signature stays as the panel set it. */
    public function on_identity_update($args)
    {
        $fields = $this->policy()->forcedFields($this->current_data(), time());
        if ($fields !== null) {
            $args['record'] = array_merge($args['record'] ?? [], $fields);
        }
        return $args;
    }

    /** Takes the signature section out of the form when the user may not change it. */
    public function on_identity_form($args)
    {
        if ($this->policy()->managed($this->current_data())) {
            unset($args['form']['signature']);
        }
        return $args;
    }

    private function current_data(): ?array
    {
        return $this->policy()->read((string) rcmail::get_instance()->get_user_name());
    }

    private function policy(): Vexlyx_Signature_Policy
    {
        $this->policy ??= new Vexlyx_Signature_Policy(
            (string) rcmail::get_instance()->config->get('vexlyx_signature_dir', self::DEFAULT_DIR)
        );
        return $this->policy;
    }
}
