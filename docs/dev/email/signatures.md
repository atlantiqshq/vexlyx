# Email Signatures (F5.31)

> **Feature:** F5.31 — Email Signatures (basic and advanced)
> **Package:** `@vexlyx/api`, `@vexlyx/dashboard`, `@vexlyx/shared`, Postfix and Roundcube images, `system/python`
> **Depends on:** F4.1 (Postfix), F4.2 (Dovecot), F4.3 (mailboxes), F4.5 (webmail), F4.6 (DKIM)
> **Issue:** #23

---

## 1. What it does

A domain owner designs one signature template for the domain. Every mailbox fills it in from its own
profile (name, title, department, phone, mobile). On top of that the owner can:

- **Lock** the signature so users cannot change it.
- Pick **groups** (for example "Sales") with their own template, and assign mailboxes to them.
- Add a **legal footer** (disclaimer) that is added whatever signature a mailbox uses.
- Add dated **banners** (promotions) that appear between two dates, per domain or per group.
- Apply rules: external recipients only, new messages only (not replies), and a sender allow or
  deny list.
- **Enforce server-side**, so the signature is added to mail sent from any app (Outlook, a phone),
  not only webmail.
- Bulk-reset or bulk-assign mailboxes, export and import a setup, and restore earlier versions.

Access is **owner-only**: a user manages the domains and mailboxes they own. Resellers do not manage
their sub-accounts' signatures.

## 2. Architecture

```
Dashboard ──► Fastify API ──► Postgres (policy, mailbox settings, versions, groups, banners, assets)
                  │
                  └─► signature_manager.py ──► docker/mail-data/signatures/<address>.json
                                                         │                │
                                       (read-only)       ▼                ▼       (read-only)
                                            Roundcube plugin       Postfix signature filter
                                            vexlyx_signature       (submission port only)
```

The database is the source of truth. After every change the API renders the resolved result for the
affected mailboxes into one JSON file each (`SignatureFile` v1) and writes it through
`system/python/signature_manager.py`, the same pattern the other system helpers use. Roundcube and
Postfix only ever read those files and never touch the database.

`_global.json` is the emergency switch (Settings → Mail signatures). When it says off, the Postfix
filter adds nothing and Roundcube goes back to behaving as if no signature were managed.

### Resolution order

1. Domain signature disabled, or the sender excluded by the sender list → **no signature**.
2. Domain **locked** → the domain (or the mailbox's group) template, whatever the mailbox chose.
3. Otherwise mailbox **custom** template > group template > domain template; mailbox **none** → nothing.
4. Banners are only added to a mailbox that has a signature. The legal footer is independent of it.

Code: `apps/api/src/modules/mail-signatures/resolve.ts`.

## 3. Template language and security

Plain text with `{{name}}`, `{{title}}`, `{{department}}`, `{{phone}}`, `{{mobile}}`, `{{email}}`,
`{{company}}`, `{{website}}`, `**bold**` and `[label](https://link)`. A line whose variables are all
empty is dropped.

There is deliberately no rich HTML editor and no sanitizer dependency. The renderer
(`packages/shared/src/mailSignature/render.ts`) works so that untrusted text cannot become markup:

- The template is parsed first; variable **values** are substituted afterwards as literal text, so a
  profile value cannot inject `**`, a link or HTML.
- Everything is HTML-escaped.
- Link targets must be `https:`, `mailto:` or `tel:`. A logo must be `https:` (plain `http:` only for
  localhost, for development).
- Control, bidirectional-override and zero-width characters are removed.

The same renderer runs in the dashboard preview, the API and the files read by Postfix and Roundcube,
so what the owner previews is what is sent.

### Limits

| Item | Limit |
|---|---|
| Template | 4000 characters |
| Legal footer | 2000 characters |
| Banner text | 500 characters |
| Versions kept per mailbox and per domain | 20 |
| Logo upload | 200 KB, 10 per domain; PNG, JPEG, GIF or WebP |

Uploaded logos are checked by their first bytes (the declared type is not trusted) and stored as they
arrived, not re-encoded. They are served publicly from `/api/signature-assets/<file>`, because a
recipient's mail app has to fetch them.

## 4. Two ways a signature gets added

### Webmail (Roundcube plugin `vexlyx_signature`)

`docker/roundcube/plugins/vexlyx_signature/` hooks `login_after`, `identity_create`,
`identity_update` and `identity_form`. On sign-in it writes the managed signature into the mailbox's
identity. When the domain is locked or enforced server-side, the identity's signature field is hidden
and forced, so webmail does not add a second copy. When unlocked, a user's own edits are kept until
the panel's content changes (tracked by a content hash). The decision logic is plain PHP
(`signature_policy.php`) so it can be tested without Roundcube.

### Any mail app (Postfix filter, "Enforce server-side")

Mail from authenticated clients on the submission port is piped through
`docker/postfix/signature_filter.sh` → `signature_filter.py` and re-injected with `sendmail`.

- **DKIM stays valid.** The submission service has no milter of its own (`-o smtpd_milters=`).
  Re-injected mail goes through `non_smtpd_milters`, so OpenDKIM signs **after** the signature has
  been added. This was verified by cryptographically verifying the DKIM signature of delivered mail.
- **Identity** comes from the authenticated login (`${sasl_username}`), not from the From header, so a
  user cannot make the server sign as someone else.
- **It skips** signed (S/MIME, PGP, `multipart/signed`) and encrypted mail, calendar invitations,
  delivery reports, bounces, auto-replies, and mail already carrying the signature marker.
- **It fails open.** Any problem delivers the original bytes untouched; the shell wrapper also covers
  Python being missing or crashing. The wrapper only exits with a temporary failure (75) when Postfix
  itself refuses the re-injected message, so mail is retried rather than lost.
- The filter places the signature below the reply text for replies and at the end for new messages,
  for both plain-text and HTML parts.
- Counters (modified, skipped by reason, failed) are kept in `/var/lib/vexlyx/signature_stats.json` and shown in
  the Settings card.

Rules (external-only, new-messages-only, sender list) apply **only** to server-side enforcement. In
webmail the signature is placed by the identity and the user composes with it.

> **Limit:** a signature set in a user's own desktop or phone app cannot be controlled from the
> server. With **Enforce server-side** off, those apps keep their own signature. Turn it on to have the
> server add it, and tell users to clear the signature in their app.

## 5. API

All routes need a session; a user can only reach their own domains and mailboxes, except the
enforcement switch (admin only) and the asset route (public, read only).

| Method | Path | Purpose |
|---|---|---|
| GET / PUT / DELETE | `/api/mailboxes/:id/signature` | Read, save, reset a mailbox's profile and mode |
| GET | `/api/mailboxes/:id/signature/versions` | Earlier versions |
| POST | `/api/mailboxes/:id/signature/versions/:versionId/restore` | Restore one |
| POST | `/api/mailboxes/:id/signature/test` | Email the owner a preview |
| GET / PUT | `/api/domains/:id/mail-signature` | Domain policy |
| GET | `/api/domains/:id/mail-signature/versions` | Domain history |
| POST | `/api/domains/:id/mail-signature/versions/:versionId/restore` | Restore |
| POST / PUT / DELETE | `/api/domains/:id/mail-signature/groups[/:childId]` | Groups |
| POST / PUT / DELETE | `/api/domains/:id/mail-signature/banners[/:childId]` | Banners |
| POST | `/api/domains/:id/mail-signature/bulk` | Reset all to default or assign a group (supports `dryRun`) |
| GET / POST | `/api/domains/:id/mail-signature/export` / `import` | Copy a setup between domains |
| POST / DELETE | `/api/domains/:id/mail-signature/logo[/:childId]` | Logo upload and removal |
| GET | `/api/signature-assets/:fileName` | Serve an uploaded logo |
| GET / PUT | `/api/mail-signatures/enforcement` | Global switch and counters (admin) |

Responses include an optional `syncWarning` when the database was saved but the mail servers could
not be updated yet; the dashboard shows it as a warning rather than an error.

Import replaces the template, rules and banners and adds or updates groups by name. Mailboxes, sender
lists and logo uploads are not exported.

## 6. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SIGNATURES_DIR` | `./docker/mail-data/signatures` | Where per-mailbox files are written |
| `SIGNATURE_ASSETS_DIR` | `./workspaces/signature-assets` | Where uploaded logos are stored |

Server-side enforcement needs `python3` in the Postfix image. It is the only dependency this feature
added; the filter itself uses only the Python standard library.

## 7. How to test

| Layer | Command |
|---|---|
| Renderer, resolver, API routes | `pnpm --filter @vexlyx/api test` |
| Real database service tests | set `SIGNATURE_TEST_DATABASE_URL` to a throwaway Postgres (migrations applied), then run `pnpm exec vitest run src/modules/mail-signatures/service.integration.test.ts` in `apps/api` |
| Dashboard helpers | `pnpm --filter @vexlyx/dashboard test` |
| System helper | `python system/python/test_signature_manager.py` |
| Postfix filter | `python docker/postfix/test_signature_filter.py` |
| Roundcube policy | `php docker/roundcube/plugins/vexlyx_signature/tests/run.php` |

The filter was also run live in the Postfix container: mail sent over authenticated submission was
delivered with the signature, kept a valid DKIM signature (checked with `dkimpy`), and was delivered
unchanged when the filter was disabled, when Python was removed, or when the message was
signed/encrypted/auto-generated.

## 8. How to extend

- **New template variable:** add it to `SIGNATURE_VARIABLES` in the shared renderer, to the mailbox
  profile schema, the `toMailboxSettings` mapping in `sync.ts`, and the variable buttons in the
  dashboard.
- **New rule:** add it to the policy schema and Prisma model, to `resolve.ts`, to the `SignatureFile`
  `rules` object, and to the filter. Bump `v` only if the file format changes incompatibly.
- **Reseller access:** the ownership checks live in `MailSignatureService`; widening them also needs
  the dashboard to list sub-account domains.
