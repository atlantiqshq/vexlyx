<?php
// Fail closed unless the development Compose configuration explicitly opts in.
$mailEnvironment = getenv('VEXLYX_ROUNDCUBE_ENV') ?: 'production';
$insecureTls = getenv('VEXLYX_ROUNDCUBE_ALLOW_INSECURE_TLS');
if (!in_array($mailEnvironment, ['production', 'development'], true)
    || !in_array($insecureTls, [false, 'false', 'true'], true)) {
    throw new RuntimeException('Invalid Roundcube TLS environment configuration.');
}
$insecureTls = $insecureTls === 'true';
if ($insecureTls && $mailEnvironment !== 'development') {
    throw new RuntimeException('Insecure Roundcube TLS is allowed only in development.');
}

// The TCP destinations remain dovecot/postfix. Their production certificate
// identifies the public mail hostname, which PHP must verify and use for SNI.
$mailPeerName = getenv('VEXLYX_MAIL_HOSTNAME');
if (!$insecureTls && ($mailPeerName === false || $mailPeerName === '')) {
    throw new RuntimeException('VEXLYX_MAIL_HOSTNAME is required for verified Roundcube TLS.');
}
if ($mailPeerName !== false && $mailPeerName !== ''
    && !filter_var($mailPeerName, FILTER_VALIDATE_DOMAIN, FILTER_FLAG_HOSTNAME)) {
    throw new RuntimeException('VEXLYX_MAIL_HOSTNAME must be a hostname without a scheme or port.');
}

$mailSslOptions = [
    'verify_peer' => !$insecureTls,
    'verify_peer_name' => !$insecureTls,
    'allow_self_signed' => $insecureTls,
];
if ($mailPeerName !== false && $mailPeerName !== '') {
    $mailSslOptions['peer_name'] = $mailPeerName;
    $mailSslOptions['SNI_enabled'] = true;
}
$config['imap_conn_options'] = ['ssl' => $mailSslOptions];
$config['smtp_conn_options'] = ['ssl' => $mailSslOptions];
