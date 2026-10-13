# Roundcube mail TLS verification

Roundcube verifies the certificate chain and hostname for both mail connections.
The TCP destinations remain Docker service names; `peer_name` and SNI identify
`VEXLYX_MAIL_HOSTNAME`, which must match the certificate synchronized from Traefik
to Postfix and Dovecot. Roundcube uses its image's system CA trust store. It does
not mount the mail servers' private keys or automatically trust their leaf
certificates.

## Production

The production overlay explicitly sets:

```yaml
VEXLYX_ROUNDCUBE_ENV: production
VEXLYX_ROUNDCUBE_ALLOW_INSECURE_TLS: "false"
VEXLYX_MAIL_HOSTNAME: ${VEXLYX_MAIL_HOSTNAME:?Set the production mail certificate hostname}
ROUNDCUBEMAIL_DEFAULT_HOST: ssl://dovecot
ROUNDCUBEMAIL_DEFAULT_PORT: 993
ROUNDCUBEMAIL_SMTP_SERVER: ssl://postfix
ROUNDCUBEMAIL_SMTP_PORT: 465
```

PHP enables `verify_peer` and `verify_peer_name`, disables `allow_self_signed`,
and rejects an insecure flag in production. Missing/invalid hostnames and invalid
environment values fail closed with a configuration error. There is no fallback
to insecure verification on connection failure.

Both connections complete TLS before receiving mail protocol capabilities or
sending credentials. This also avoids the pinned Roundcube clients' optional
STARTTLS behavior when a peer omits the STARTTLS capability. Postfix's new `smtps`
listener on 465 requires TLS and authenticated submission. It is internal to the
container network: Compose adds no public port binding. Existing SMTP ports 25
and 587 and development STARTTLS remain available.

Untrusted, self-signed, expired, or wrong-host certificates prevent the affected
login/send operation. The installer's temporary self-signed certificate is not
accepted by production webmail; webmail becomes usable after the trusted mail
certificate is synchronized successfully. The webmail HTTPS certificate protects
the browser connection separately.

## Upgrade an existing installation

Confirm `/etc/vexlyx/vexlyx.env` defines the correct `VEXLYX_MAIL_HOSTNAME`, and
that the mail certificate is issued for that name. From the updated checkout:

```sh
sudo /usr/local/sbin/vexlyx-sync-mail-tls
docker compose --env-file /etc/vexlyx/vexlyx.env \
  -f docker-compose.yml -f docker-compose.prod.yml build postfix
docker compose --env-file /etc/vexlyx/vexlyx.env \
  -f docker-compose.yml -f docker-compose.prod.yml \
  up -d --force-recreate postfix roundcube
```

Recreation applies the new environment; restarting an old container alone does
not. Building Postfix supplies the internal 465 listener. This briefly interrupts
mail submission/webmail sessions. Validate login, sending, and receipt using a
legitimate mailbox. If verification fails, correct certificate issuance, the
hostname, chain, or certificate synchronization; keep verification enabled.
Normal certificate renewal still uses the existing synchronization timer.

## Local development

Base Compose explicitly sets both development flags. A self-signed certificate
is accepted only with `VEXLYX_ROUNDCUBE_ENV=development` and
`VEXLYX_ROUNDCUBE_ALLOW_INSECURE_TLS=true`. Neither a missing environment nor an
unrecognized boolean value enables this exception. These settings are for
disposable local development, not production deployments.

## Validation

```sh
docker pull roundcube/roundcubemail:1.6.18-apache
docker build -t vexlyx-dovecot:roundcube-tls-test docker/dovecot
docker build -t vexlyx-postfix:roundcube-tls-test docker/postfix
python -m unittest tests.test_roundcube_tls tests.test_roundcube_mail_tls -v
```

The tests use the actual Roundcube IMAP/SMTP classes and a disposable test CA.
They verify trusted matching certificates and SNI; rejection of wrong-host,
expired, untrusted-issuer, and self-signed certificates; no credentials sent to
invalid or plaintext peers; explicit development exceptions; and merged Compose
production settings. Real-service tests also validate authenticated delivery and
rejection of anonymous submission on the internal SMTPS listener. The
`roundcube-tls` CI job runs these checks.

For production-style browser checks, with Playwright and Chromium available:

```sh
docker build -t vexlyx-dovecot:roundcube-tls-test docker/dovecot
docker build -t vexlyx-postfix:roundcube-tls-test docker/postfix
python -m tests.roundcube_tls_stack --keep
node tests/roundcube-tls/browser.cjs
python -m tests.roundcube_tls_stack --cleanup
```

The browser stack uses isolated containers, a private test CA, a private mail
network, and a loopback-only webmail binding. Its CA is installed only in the disposable test container.
Set `VEXLYX_PLAYWRIGHT_MODULE`, `VEXLYX_BROWSER_EXECUTABLE`, and `VEXLYX_TEST_PYTHON`
if using external runtimes. Certificate variants can be selected for either mail
service using `python -m tests.roundcube_tls_stack --certificate <service> <variant>`.
