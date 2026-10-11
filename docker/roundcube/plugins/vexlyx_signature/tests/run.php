<?php
/**
 * Tests for Vexlyx_Signature_Policy (F5.31). No framework needed:
 *   php docker/roundcube/plugins/vexlyx_signature/tests/run.php
 * Exits 1 if anything fails.
 */
require_once __DIR__ . '/../signature_policy.php';

$failures = 0;
$checks = 0;

function check(string $name, bool $ok, string $detail = ''): void
{
    global $failures, $checks;
    $checks++;
    if (!$ok) {
        $failures++;
        echo "FAIL $name" . ($detail !== '' ? "  -> $detail" : '') . "\n";
    }
}

function same(string $name, $expected, $actual): void
{
    check($name, $expected === $actual, 'expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
}

$dir = sys_get_temp_dir() . '/vx-sig-' . bin2hex(random_bytes(4));
mkdir($dir, 0755, true);
$policy = new Vexlyx_Signature_Policy($dir);

function writeFileData(string $dir, string $address, array $data): void
{
    file_put_contents("$dir/$address.json", json_encode($data));
}

function fileData(array $overrides = []): array
{
    return array_merge([
        'v' => 1,
        'address' => 'ada@example.com',
        'locked' => false,
        'enforceServerSide' => false,
        'signature' => ['html' => '<div>Ada</div>', 'text' => 'Ada'],
        'compliance' => null,
        'banners' => [],
    ], $overrides);
}

$NOW = strtotime('2026-10-13T12:00:00Z');

// ---- reading ---------------------------------------------------------------
writeFileData($dir, 'ada@example.com', fileData());
same('reads a mailbox file', 'Ada', $policy->read('ada@example.com')['signature']['text']);
same('looks the address up case-insensitively', true, $policy->read('ADA@Example.COM') !== null);
same('returns null when there is no file', null, $policy->read('nobody@example.com'));

foreach (['../ada@example.com', 'a/b@example.com', 'a\\b@example.com', ".hidden@example.com", "ada@example.com\n", "ada@example.com\0", 'ada', '', 'ada@example.com/../x', 'ada@../example.com'] as $bad) {
    same('rejects the username ' . json_encode($bad), null, $policy->read($bad));
}

file_put_contents("$dir/broken@example.com.json", '{not json');
same('ignores malformed JSON', null, $policy->read('broken@example.com'));
writeFileData($dir, 'old@example.com', fileData(['v' => 2]));
same('ignores an unknown format version', null, $policy->read('old@example.com'));
file_put_contents("$dir/list@example.com.json", '[1,2,3]');
same('ignores JSON that is not an object with a version', null, $policy->read('list@example.com'));

// A file outside the directory must never be reachable through a crafted name.
file_put_contents(dirname($dir) . '/outside@example.com.json', json_encode(fileData()));
same('cannot reach a file outside the directory', null, $policy->read('../outside@example.com'));

// ---- global switch and modes ----------------------------------------------
same('enforcement is on when there is no global file', true, $policy->globalEnabled());
file_put_contents("$dir/_global.json", json_encode(['v' => 1, 'enabled' => false]));
same('the global file can switch it off', false, $policy->globalEnabled());
file_put_contents("$dir/_global.json", json_encode(['v' => 1, 'enabled' => true]));
same('and back on', true, $policy->globalEnabled());

$server = fileData(['enforceServerSide' => true]);
same('server-side needs the flag and the global switch', true, $policy->serverSide($server));
file_put_contents("$dir/_global.json", json_encode(['v' => 1, 'enabled' => false]));
same('server-side is off when the global switch is off', false, $policy->serverSide($server));
same('so webmail takes over again', 'Ada', strip_tags((string) $policy->desiredHtml($server, $NOW)));
unlink("$dir/_global.json");
same('with the flag on, webmail adds nothing itself', null, $policy->desiredHtml($server, $NOW));
same('no flag, no server-side', false, $policy->serverSide(fileData()));
same('a missing file is not server-side', false, $policy->serverSide(null));

// ---- composing -------------------------------------------------------------
$full = fileData([
    'compliance' => ['html' => '<p>Legal</p>', 'text' => 'Legal'],
    'banners' => [
        ['html' => '<p>Active</p>', 'text' => 'Active', 'startsAt' => '2026-10-13T00:00:00Z', 'endsAt' => '2026-10-14T00:00:00Z'],
        ['html' => '<p>Future</p>', 'text' => 'Future', 'startsAt' => '2026-12-01T00:00:00Z', 'endsAt' => '2026-12-25T00:00:00Z'],
        ['html' => '<p>Past</p>', 'text' => 'Past', 'startsAt' => '2026-01-01T00:00:00Z', 'endsAt' => '2026-02-01T00:00:00Z'],
    ],
]);
same('puts the signature, active banners and the legal footer in that order', '<div>Ada</div><p>Active</p><p>Legal</p>', $policy->composeHtml($full, $NOW));
same('a banner starts exactly at its start time', true, str_contains((string) $policy->composeHtml($full, strtotime('2026-10-13T00:00:00Z')), 'Active'));
same('and stops exactly at its end time', false, str_contains((string) $policy->composeHtml($full, strtotime('2026-10-14T00:00:00Z')), 'Active'));
same('shows a future banner once its time comes', true, str_contains((string) $policy->composeHtml($full, strtotime('2026-12-02T00:00:00Z')), 'Future'));
same('shows the legal footer even without a personal signature', '<p>Legal</p>', $policy->composeHtml(fileData(['signature' => null, 'compliance' => ['html' => '<p>Legal</p>', 'text' => 'Legal']]), $NOW));
same('has nothing to show for an empty file', null, $policy->composeHtml(fileData(['signature' => null]), $NOW));
same('and for no file', null, $policy->composeHtml(null, $NOW));
same('ignores a banner with a broken date', '<div>Ada</div>', $policy->composeHtml(fileData(['banners' => [['html' => '<p>X</p>', 'startsAt' => 'garbage', 'endsAt' => 'garbage']]]), $NOW));
same('ignores signature parts that are not strings', null, $policy->composeHtml(fileData(['signature' => ['html' => ['<script>']]]), $NOW));

// ---- forced fields ---------------------------------------------------------
same('an unlocked signature is not forced', null, $policy->forcedFields(fileData(), $NOW));
same('a locked one is', ['signature' => '<div>Ada</div>', 'html_signature' => 1], $policy->forcedFields(fileData(['locked' => true]), $NOW));
same('server-side forces it empty', ['signature' => '', 'html_signature' => 0], $policy->forcedFields($server, $NOW));
same('no file means no force', null, $policy->forcedFields(null, $NOW));

// ---- planning a login ------------------------------------------------------
$identity = fn (int $id, string $sig = '', int $html = 0, int $standard = 1) => ['identity_id' => $id, 'signature' => $sig, 'html_signature' => $html, 'standard' => $standard];
$desired = '<div>Ada</div>';
$hash = sha1($desired);

$plan = $policy->planLogin([$identity(1)], fileData(), [], $NOW);
same('first login: writes the signature into the default identity', [1 => ['signature' => $desired, 'html_signature' => 1]], $plan['updates']);
same('and remembers what it wrote', ['managed' => true, 'hash' => $hash], $plan['prefs']);

$plan = $policy->planLogin([$identity(1, $desired, 1)], fileData(), ['managed' => true, 'hash' => $hash], $NOW);
same('same content next time: nothing to do', [[], null], [$plan['updates'], $plan['prefs']]);

$plan = $policy->planLogin([$identity(1, '<p>my own words</p>', 1)], fileData(), ['managed' => true, 'hash' => $hash], $NOW);
same("an unlocked user's own edit survives while the panel's content is unchanged", [], $plan['updates']);

$changed = fileData(['signature' => ['html' => '<div>Ada v2</div>', 'text' => 'Ada v2']]);
$plan = $policy->planLogin([$identity(1, '<p>my own words</p>', 1)], $changed, ['managed' => true, 'hash' => $hash], $NOW);
same('new panel content replaces it', '<div>Ada v2</div>', $plan['updates'][1]['signature'] ?? null);

$two = [$identity(1, '', 0, 0), $identity(2, '', 0, 1)];
$plan = $policy->planLogin($two, fileData(), [], $NOW);
same('unlocked: only the default identity is touched', [2], array_keys($plan['updates']));

$locked = fileData(['locked' => true]);
$plan = $policy->planLogin($two, $locked, ['managed' => true, 'hash' => $hash], $NOW);
same('locked: every identity is set', [1, 2], array_keys($plan['updates']));
$plan = $policy->planLogin([$identity(1, '<p>edited</p>', 1)], $locked, ['managed' => true, 'hash' => $hash], $NOW);
same('locked: a user edit is put back at the next login', $desired, $plan['updates'][1]['signature'] ?? null);
$plan = $policy->planLogin([$identity(1, $desired, 1)], $locked, ['managed' => true, 'hash' => $hash], $NOW);
same('locked: an identity that is already right is left alone', [], $plan['updates']);
$plan = $policy->planLogin([$identity(1, $desired, 0)], $locked, ['managed' => true, 'hash' => $hash], $NOW);
same('locked: the HTML flag is corrected too', 1, $plan['updates'][1]['html_signature'] ?? null);

$plan = $policy->planLogin([$identity(1, $desired, 1)], null, ['managed' => true, 'hash' => $hash], $NOW);
same('signature removed in the panel: clears what it had written', [1 => ['signature' => '', 'html_signature' => 0]], $plan['updates']);
same('and stops managing', ['managed' => false, 'hash' => ''], $plan['prefs']);
$plan = $policy->planLogin([$identity(1, '<p>mine, not ours</p>', 1)], null, ['managed' => true, 'hash' => $hash], $NOW);
same("signature removed: never clears something the user wrote themselves", [], $plan['updates']);

$plan = $policy->planLogin([$identity(1, '<p>old personal</p>', 1)], $server, [], $NOW);
same('server-side: clears the identity so the signature is not added twice', [1 => ['signature' => '', 'html_signature' => 0]], $plan['updates']);

$plan = $policy->planLogin([$identity(1)], null, [], $NOW);
same('no file and never managed: nothing at all', [[], null], [$plan['updates'], $plan['prefs']]);

$plan = $policy->planLogin([], fileData(), [], $NOW);
same('a user with no identities yet: nothing to update', [], $plan['updates']);

// A banner starting changes the content, so the next login picks it up even though the file's version did not.
$withBanner = fileData(['banners' => [['html' => '<p>Sale</p>', 'text' => 'Sale', 'startsAt' => '2026-10-14T00:00:00Z', 'endsAt' => '2026-10-20T00:00:00Z']]]);
$before = $policy->planLogin([$identity(1)], $withBanner, [], $NOW);
$next = $policy->planLogin([$identity(1, $desired, 1)], $withBanner, $before['prefs'], strtotime('2026-10-15T00:00:00Z'));
same('a banner that starts later is added at the next login', '<div>Ada</div><p>Sale</p>', $next['updates'][1]['signature'] ?? null);

// ---- cleanup ---------------------------------------------------------------
array_map('unlink', glob("$dir/*.json"));
@unlink(dirname($dir) . '/outside@example.com.json');
rmdir($dir);

echo $failures === 0 ? "OK ($checks checks)\n" : "$failures of $checks checks FAILED\n";
exit($failures === 0 ? 0 : 1);
