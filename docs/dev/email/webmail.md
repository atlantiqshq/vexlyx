# Webmail (Roundcube) (F4.4)

> **Feature:** F4.4 — Webmail (Roundcube)
> **Status:** 🟢 COMPLETED
> **Package:** `@vexlyx/api`, `@vexlyx/dashboard`, `@vexlyx/shared`
> **Depends on:** F4.1 (Postfix SMTP), F4.2 (Dovecot IMAP), F4.3 (Mailbox Management UI)

---

## 1. Overview

F4.4 adds browser-based email access for mailboxes created in F4.3, so users who don't want to configure a desktop/mobile mail client can read and send mail directly from the Vexlyx dashboard.

- **Single shared Roundcube instance** — one container (`vexlyx-roundcube`), not a per-domain deployment. This mirrors how `adminer` is a single shared infra container rather than one-per-database.
- **No changes to Postfix/Dovecot config** — Roundcube authenticates over IMAP (`dovecot:143`, STARTTLS) and sends over SMTP (`postfix:587`, STARTTLS) using the mailbox's own address + password, the exact same Dovecot SASL path Postfix already uses for authenticated submission. **STARTTLS is mandatory, not optional** — Dovecot's `ssl = required` rejects auth on a plaintext connection, so Roundcube's `ROUNDCUBEMAIL_DEFAULT_HOST`/`ROUNDCUBEMAIL_SMTP_SERVER` use the `tls://` scheme (not a bare hostname) to force it. See §5.
- **Manual login only** — no SSO/autologin. Users type the mailbox address and password shown when the mailbox was created (or reset) in the Mailboxes tab. Vexlyx never stores or has access to a mailbox's plaintext password (only the Argon2id hash), so autologin isn't possible without a separate credential-recovery design.
- **SQLite persistence** — Roundcube's own state (address book, UI prefs, header cache) lives in a bind-mounted SQLite file, not a shared Postgres database.

---

## 2. Architecture & Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│                     Next.js Dashboard UI                      │
│  /mail → "Webmail" tab (WebmailPanel.tsx)                     │
│  status card + "Open Webmail" link (opens in new tab)         │
└──────────────────────────────┬───────────────────────────────┘
                                │ HTTP / JSON
                                ▼
┌──────────────────────────────────────────────────────────────┐
│                     Fastify API Server                        │
│  GET /api/mail/webmail/status   container + reachability check│
└───────────────────────────────┬───────────────────────────────┘
                                 ▼
                system/python/webmail_manager.py
                  status(host, port) → TCP probe + docker inspect
                                 │
                                 ▼
                     vexlyx-roundcube container
              (roundcube/roundcubemail:1.6.18-apache)
                                 │
                  ┌──────────────┴──────────────┐
                  ▼                              ▼
        dovecot:143 (IMAP, STARTTLS —           postfix:587 (SMTP,
        Dovecot's `ssl = required`               STARTTLS + Dovecot
        rejects plaintext auth)                  SASL auth — same path
                                                  as any mail client)
```

The user's browser talks directly to Roundcube (via Traefik at `webmail.vexlyx.localhost`, or the mapped host port `8089` in dev) — the Fastify API is only involved in the status check, not in serving webmail itself.

---

## 3. Files

**Infrastructure**
- `docker-compose.yml` — `roundcube` service: official image, no custom Dockerfile (unlike Postfix/Dovecot, which need custom config). Joins `default` (to reach `dovecot`/`postfix`, and to be reachable, by container name) and `traefik-net`. Also carries `traefik.enable=true` Docker labels for `webmail.vexlyx.localhost`, kept for portability to environments where Traefik's Docker provider works — see the routing note below.
- `docker/traefik/dynamic/webmail.yml` — the route that actually works in this dev environment: a Traefik **file-provider** static router for `webmail.vexlyx.localhost` → `http://vexlyx-roundcube:80`, the same mechanism `DomainService.syncTraefikRouter()` (F3.3/F3.4) uses for per-domain routing. See §5.
- `vexlyx_roundcube_data` named volume → `/var/roundcube/db` (SQLite file).
- `docker/roundcube/config/local.inc.php`, bind-mounted read-only to `/var/roundcube/config/` (the official image auto-includes any `*.php` dropped there) — sets `imap_conn_options`/`smtp_conn_options` to accept Dovecot/Postfix's self-signed certificate in local development during the mandatory STARTTLS handshake. Production mail services use the trusted certificate synchronized from Traefik. See §5.

**System layer**
- `system/python/webmail_manager.py` — `status` command: TCP-probes the mapped host port and runs `docker inspect vexlyx-roundcube`, mirroring `dovecot_manager.py::get_dovecot_status()`.

**API**
- `apps/api/src/config/env.ts` / `.env.example` — `WEBMAIL_URL`, `WEBMAIL_PORT`, `WEBMAIL_CONTAINER_NAME`.
- `apps/api/src/modules/mail/service.ts` — `runWebmailManager()` helper (same shape as `runPostfixManager`/`runDovecotManager`) and `MailService.getWebmailStatus()`.
- `apps/api/src/modules/mail/routes.ts` — `GET /api/mail/webmail/status` (auth required).

**Shared**
- `packages/shared/src/schemas/mail.ts` — `WebmailStatusSchema` / `WebmailStatusResponse`.

**Dashboard**
- `apps/dashboard/src/hooks/useWebmail.ts` — fetches webmail status on mount.
- `apps/dashboard/src/components/mail/WebmailPanel.tsx` — status card + "Open Webmail" button (`window.open`, new tab) + a note on how to log in.
- `apps/dashboard/src/app/(panel)/mail/page.tsx` — third `TabsTrigger`/`TabsContent` ("Webmail") alongside "Domains & DKIM" and "Mailboxes".

---

## 4. How to Test

1. `docker compose up -d roundcube` → `docker ps` shows `vexlyx-roundcube` running and healthy.
2. `curl http://localhost:8089/` → Roundcube's login page returns `200`.
3. In the dashboard, open `/mail` → "Webmail" tab shows a "Running" badge and an "Open Webmail" button.
4. Log in to Roundcube with a mailbox address + password from the Mailboxes tab (create one first, or reset an existing one to get a fresh password) → inbox loads.
5. Compose and send an email to another local mailbox → delivered (validates `postfix:587` STARTTLS + Dovecot SASL auth).
6. Upload/download an attachment → round-trips.
7. Add a contact to the address book, restart the container (`docker compose restart roundcube`), confirm the contact persists (validates the SQLite volume).
8. `GET /api/mail/webmail/status` (authenticated) → returns `{ service: "roundcube", status: "active", containerRunning: true, url, lastChecked }`.

## 5. Fixed Bug — "Login failed" on Every Correct Password

**Symptom:** every Roundcube login attempt returned "Login failed", even with a password copied directly from the Mailboxes tab's one-time reveal dialog.

**Root cause:** `docker/dovecot/dovecot.conf` sets `ssl = required`, which makes Dovecot refuse the `AUTHENTICATE`/`LOGIN` command entirely on a connection that hasn't negotiated TLS. The initial compose config pointed Roundcube at a bare hostname (`ROUNDCUBEMAIL_DEFAULT_HOST: dovecot`, `ROUNDCUBEMAIL_SMTP_SERVER: postfix`) with no scheme — Roundcube's IMAP/SMTP client only attempts STARTTLS when the host is prefixed with `tls://` (or `ssl://` for implicit TLS), so it was authenticating in plaintext and getting silently rejected. `docker exec vexlyx-dovecot doveadm auth test ...` and the Dovecot log (`auth failed`) confirmed the passdb layer itself was fine — this was purely a transport-negotiation gap.

**Fix (`docker-compose.yml`):**
```yaml
ROUNDCUBEMAIL_DEFAULT_HOST: tls://dovecot   # was: dovecot
ROUNDCUBEMAIL_SMTP_SERVER: tls://postfix    # was: postfix
```
Forcing STARTTLS then hit a second, expected development problem: Dovecot/Postfix's local self-signed cert isn't trusted by PHP's default TLS verification, so the handshake failed again. `docker/roundcube/config/local.inc.php` (auto-included by the official image from `/var/roundcube/config/*.php`) sets `imap_conn_options`/`smtp_conn_options` → `ssl.verify_peer = false` for the internal container connection. External production clients do not need this exception because Postfix and Dovecot present the trusted certificate synchronized from Traefik.

**Verified independently of Roundcube's UI**, from inside the `vexlyx_default` network:
```
curl --url 'imap://dovecot:143/' --user 'user@domain:password' --ssl-reqd -k   # -> A004 OK Logged in
curl --url 'smtp://postfix:587/' --user 'user@domain:password' --ssl-reqd -k … # -> 235 Authentication successful
```

## 6. Routing Note — Why a File-Provider Route Instead of Just Docker Labels

Docker-label-based routing (what `adminer`'s `db.vexlyx.localhost` route relies on) turned out to be broken in this dev environment: Traefik 3.4.5's Docker provider fails to query the Docker socket at all, with an opaque `Error response from daemon: ` (empty). This reproduces with a bare vanilla `traefik:v3.4` container with no Vexlyx config involved — it's an upstream Traefik/Docker-Engine-29.x incompatibility, not something this feature (or Vexlyx) caused, and it identically breaks `adminer` today.

Rather than ship a webmail tab that 404s in this environment, `docker/traefik/dynamic/webmail.yml` routes `webmail.vexlyx.localhost` through Traefik's **file provider** instead — the same mechanism already relied on for per-domain SSL routing (F3.3/F3.4), which talks to Traefik's own config-reload API, not the Docker socket. The Docker labels stay on the `roundcube` compose service too, for portability to environments where the Docker provider isn't broken.

**Gotcha:** on this Windows Docker Desktop bind mount, the file provider's `watch: true` inotify reload did not pick up the new `webmail.yml` file on its own — a `docker restart vexlyx-traefik` was needed. If you add further static file-provider routes, restart Traefik afterward rather than assuming the live watch caught it.

The direct host port (`http://localhost:8089`, configurable via `WEBMAIL_PORT`) always works regardless of any of the above.

## 7. How to Extend

- **F4.5 (SPF/DKIM/DMARC)** — no changes needed here; Roundcube doesn't touch DNS/DKIM.
- **SSO/autologin** — would need a way to hand Roundcube a usable plaintext password (e.g. via its `autologin` plugin) at the moment a user clicks into Webmail from the dashboard. Today mailbox passwords are one-way Argon2id hashes shown only once at creation/reset, so this needs a deliberate credential-handling design, not just a UI change.
- **Per-domain webmail** (`webmail.<customer-domain>`) — reuse `DomainService.syncTraefikRouter()` / `SslService.provisionAutoSsl()` (F3.3/F3.4) instead of the static Docker-label route, if a per-tenant vanity URL is ever required.
