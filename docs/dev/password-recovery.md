# Password Recovery (F5.30)

> **Status:** 🟢 COMPLETED
> **Feature:** F5.30 — recover a forgotten password three ways: self-service by email, admin- or reseller-initiated link, and server-side recovery for admins. Also raises the password policy.

---

## Who recovers how

| Account | How it recovers |
|---|---|
| Regular user or reseller | **Forgot password?** on the sign-in page (emailed link), or a reset link from their admin or reseller |
| Reseller's sub-account | Same, and their own reseller can issue the link |
| **Admin** | From a shell on the server only. Email reset is off for admins unless `ALLOW_ADMIN_EMAIL_RESET=true`, and nobody can reset an admin from the panel |

The admin rule is deliberate. An admin is root-equivalent on the host (the API container has Docker access), so a compromised mailbox must not be enough to take one over. Shell access to the server is itself the proof of ownership, the same stance Plesk takes.

## How it works

One primitive sits under all three paths: a **reset token** (`PasswordResetToken`).

- 32 bytes from a CSPRNG; only the **SHA-256 hash** is stored, so reading the database gives no usable link. Raw tokens are never logged or written to the audit log.
- Single-use (claimed atomically), expiring, and a new link invalidates every earlier unused one for that user.
- `source` records who issued it: `SELF_SERVICE`, `ADMIN` or `CLI`. `createdById` records which admin or reseller.
- The link carries the token in the URL **fragment** (`/reset-password#token=…`), so it never reaches server logs or `Referer`. The page is served with `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- The link is built from `PANEL_DOMAIN` (trusted config), never from a request's `Host` header.

| Source | Lifetime | Who may use it on an admin |
|---|---|---|
| `SELF_SERVICE` | 30 minutes | Only if `ALLOW_ADMIN_EMAIL_RESET=true` |
| `ADMIN` | 24 hours (it is handed over out of band) | Never — a link issued for someone who has since become an admin stops working |
| `CLI` | 1 hour | Yes |

### After any reset

The password is set with Argon2id, **every session of that user ends**, the user is **not logged in automatically**, **two-factor stays enforced** (a reset never touches it), all other links for the user are deleted, the user gets a "your password was changed" email, and the reset is written to the audit log. Admin 2FA reset and a user turning their own 2FA off also end sessions (the caller keeps their current one).

## 1. Self-service (email)

- `POST /api/auth/forgot-password` `{ email }` always answers `202` with the same body. The lookup, token write and email run **after** the answer is sent, so response time doesn't reveal whether the email exists either.
- Limits: 5 requests per 15 minutes per IP (`429` after that), plus one email per account per minute. Requests never lock the account.
- `POST /api/auth/reset-password` `{ token, newPassword }`.

## 2. Admin- or reseller-initiated

`POST /api/users/:id/password-reset`

| Caller | May reset |
|---|---|
| ADMIN | Any non-admin user |
| RESELLER | Only their own sub-accounts |
| Anyone else | `403` |
| Nobody | An admin account (`403 ADMIN_NOT_RESETTABLE`) — use the shell script |

The caller never chooses or sees a password.

- **Email configured** (`EMAIL_ENABLED` and a real transport): the user is emailed the link and the response is `{ delivery: "email", expiresAt }` — the admin never sees the link.
- **No email**: the response is `{ delivery: "link", resetUrl, expiresAt }`. The link is shown once in the dashboard (**Users → Edit → Send reset link**) to hand over out of band.
- Audited as `user.password_reset_issued` (actor, target, delivery); the target is notified when email is on.

## 3. Server-side recovery (admins)

Run on the host through the same one-off container the installer uses for `create-admin`:

```bash
cd /opt/vexlyx
docker compose --env-file /etc/vexlyx/vexlyx.env -f docker-compose.yml -f docker-compose.prod.yml \
  run --rm --no-deps api pnpm exec tsx prisma/reset-password.ts --email admin@example.com
```

| Option | Effect |
|---|---|
| *(none)* / `--link` | Prints a single-use link, valid 1 hour. Changes nothing until it is opened, and no password lands in shell history. |
| `--password-stdin` | Sets the password read from stdin, for when the panel UI itself is unreachable. Pipe it in: `printf '%s' 'a long passphrase' \| … --password-stdin`. Ends the account's sessions. |
| `--disable-2fa` | Turns off two-factor for the account and ends its sessions. |

It works with no SMTP and no logged-in user. Every action is written to the audit log, attributed to the recovered account with source `cli`. The installer prints this command in its final summary.

## Password policy

New passwords (register, change, reset, sub-account creation, `create-admin`, the installer prompt) must be **12 to 128 characters** and not on a built-in common-password list. There are no composition rules, per NIST SP 800-63B. The list is matched after lower-casing, dropping punctuation and undoing `@`/`$`/`0` look-alikes, so `P@ssw0rd-1234` is caught; one to three characters repeated (`aaaaaaaaaaaa`, `abcabcabcabc`) is rejected too. It lives in `packages/shared/src/schemas/password.ts` and is shared by the API and the dashboard forms.

Login is **not** checked against the policy, so existing shorter passwords keep working until their owner changes them. To raise the minimum, change `MIN_PASSWORD_LENGTH` in that file.

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_RESET_TOKEN` | 400 | Unknown, used, expired, or not valid for this account |
| `ADMIN_NOT_RESETTABLE` | 403 | Tried to issue a panel reset for an admin |
| `FORBIDDEN` | 403 | A reseller tried to reset someone who isn't their sub-account |

## How to test

```bash
# API (Vitest)
cd apps/api && pnpm exec vitest run src/modules/auth src/modules/users

# Dashboard helpers and headers
cd apps/dashboard && pnpm exec vitest run
```

Manual check on a real stack: run the command above against an admin account, open the printed link, set a password, and confirm the old password and any old session no longer work and 2FA is still asked for.

## How to extend

- **A new way to issue a link:** add a value to the `PasswordResetSource` enum and a lifetime in `RESET_TTL_MINUTES` (`password-reset-token.ts`), and decide in `mayResetRole` (`password-reset-service.ts`) which roles it may reset.
- **A longer minimum or a bigger blocklist:** edit `schemas/password.ts`; no other file needs to change.
