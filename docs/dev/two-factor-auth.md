# Two-Factor Authentication (F5.17)

TOTP second factor (authenticator-app compatible) layered on the existing
Argon2id + Redis session auth. Sessions are untouched — 2FA adds a
challenge step *before* session creation.

## How it works

1. `POST /api/auth/login` verifies email + password as before.
2. If the user has `totpEnabled`, the API does **not** create a session.
   Instead it stores a challenge (`2fa-challenge:<token>` → `{ userId }` in
   Redis, 32 random bytes, single-use, 5-min TTL) and returns
   `202 { requires2FA: true, challengeToken }`.
3. The frontend shows a code form. `POST /api/auth/2fa/challenge` with
   `{ challengeToken, code }` verifies the code (TOTP first, then unused
   recovery code, which is marked used) and only then calls
   `createSession()`. Failures return `401 2FA_INVALID_CODE` with no cookie.
4. Users without 2FA log in exactly as before (password → session).

Setup is a separate authenticated flow: `POST /api/auth/2fa/setup`
generates a secret (encrypted with AES-256-GCM via
`apps/api/src/utils/encryption.ts`, stored with `totpEnabled: false`),
returns `{ otpauthUrl, qrDataUrl, manualKey }`. `POST /api/auth/2fa/verify-setup`
with a valid 6-digit code flips `totpEnabled: true` and returns the
recovery codes once. Disable (`POST /api/auth/2fa/disable`) requires
`{ password, codeOrRecovery }` and wipes secret + codes.

Core logic lives in `apps/api/src/modules/auth/two-factor-service.ts`
(`TwoFactorService`); routes stay thin per CLAUDE.md §6. Challenge and
verify-setup endpoints are rate-limited at the login tier (5 per 15 min
per IP). Secrets, TOTP codes, and recovery codes are never logged;
`PUBLIC_USER_SELECT` exposes only `totpEnabled` (added in commit c091380);
no secret material (`totpSecretEncrypted`, recovery hashes) reaches `/me`.

## Env: `REQUIRE_ADMIN_2FA`

```bash
# Require TOTP 2FA for the ADMIN role at login. "false" = optional for everyone.
REQUIRE_ADMIN_2FA=false
```

Validated in `apps/api/src/config/env.ts` (boolean after transform) and
surfaced to the frontend via `GET /api/auth/config` as `requireAdmin2FA`.
When `true`, an ADMIN without 2FA gets `403 ADMIN_2FA_REQUIRED` at login
instead of a session — non-admin users are unaffected.

## Recovery model

- 10 codes generated at setup, shown **once** in the Settings UI (copy
  button, "I saved these" dismiss). Only argon2 hashes persist
  (`recovery_codes` table, `onDelete: Cascade`); plaintext never touches
  the DB.
- Each code is single-use: `verifyLoginCode()` marks the row `usedAt` on
  success, so reuse returns `401`.
- Lost authenticator + lost codes = ADMIN reset (below). There is no
  email-based recovery (out of scope until F5.23 transactional email).

## Admin reset + audit

`POST /api/users/:id/2fa/reset` (ADMIN only, `requireRole("ADMIN")`)
clears the target's secret + codes and forces `totpEnabled: false`.
Audit-logged with actor attribution:

| Event | Action string |
|---|---|
| User enables 2FA | `user.2fa_enabled` |
| User disables 2FA | `user.2fa_disabled` |
| ADMIN resets a user's 2FA | `user.2fa_reset` |

No secret material lands in audit metadata. Resetting your own 2FA via
this endpoint is allowed but logged like any other reset.

## Test checklist (from spec §8)

Per CLAUDE.md: happy + error + auth paths.

1. Enable → login requires code; valid TOTP → session; `/me` works.
2. Wrong/expired code → `401`, no cookie; reused recovery code → `401`.
3. No-2FA user → login unchanged (password → session).
4. `REQUIRE_ADMIN_2FA=true` → ADMIN without 2FA blocked with
   `ADMIN_2FA_REQUIRED`.
5. ADMIN reset → target's 2FA cleared, audit entry attributed to the admin.
6. Manual: two authenticator apps (Google Authenticator + 1Password) +
   QR and manual-key setup paths.

Unit/integration coverage: `two-factor-service.test.ts` (service +
challenge store) and `two-factor-routes.test.ts` (challenge shape),
run via `pnpm --filter @vexlyx/api test`.

## Note for future workers: shared package builds

`apps/api` imports 2FA Zod schemas from `@vexlyx/shared`. If typecheck
complains about unbuilt shared `dist`, run
`pnpm --filter @vexlyx/shared build` first, then re-run typecheck.
