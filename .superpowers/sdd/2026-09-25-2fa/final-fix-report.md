# Final Fix Wave Report — F5.17 2FA (2026-09-26)

One pass, 5 items from final review.

## 1. Prisma migration — BLOCKED (no live DB)

Offline generation is not possible here. Prisma requires a reachable
shadow database even for a pure diff:

- `prisma migrate diff --from-migrations ... --to-schema-datamodel ... --script`
  without `--shadow-database-url` → `Error: You must pass the
  --shadow-database-url if you want to diff a migrations directory.`
- With `--shadow-database-url "postgresql://user:pass@localhost:5432/vexlyx_shadow"` →
  `Error: P1001 — Can't reach database server at localhost:5432.`

No SQL was fabricated. **Follow-up (needs a live DB):** run
`pnpm db:migrate dev --name add_2fa` (or the offline `migrate diff` with a
shadow DB) so `totpSecretEncrypted`/`totpEnabled`/`totpVerifiedAt` on
`users` + the `recovery_codes` table get a migration dir
`apps/api/prisma/migrations/<timestamp>_add_2fa/`. Schema (`schema.prisma`)
already declares both models — the DB is the only missing piece.

## 2. Challenge retry-after-typo — DONE

- `TwoFactorService`: added `peekChallenge(token)` (read without delete)
  and `deleteChallenge(token)`; `consumeChallenge` kept as
  peek-then-delete for existing callers.
- `POST /2fa/challenge` now: peek → verify → on success delete + session;
  on wrong code returns 401 **without** deleting (5/15min rate limit
  bounds guessing; token requires password to obtain). Expired/missing →
  401 as before.
- Test: `two-factor-routes.test.ts` "survives a typo" (wrong code → 401,
  same token + right TOTP → 200 + user) plus service-level
  peek-twice/delete semantics in `two-factor-service.test.ts`.

## 3. createSetup guard — DONE

`createSetup` throws `AuthError("Two-factor already enabled — disable
first", "2FA_ALREADY_ENABLED", 409)` when `user.totpEnabled` is already
true, before any write (no more clobbering a live secret + recovery
codes). Route's existing `AuthError` catch maps it. Service test asserts
409 and that `prisma.user.update` was never called.

## 4. TOTP window — DONE

`authenticator.options = { window: 1 }` set once in
`two-factor-service.ts` with comment (±1 step for authenticator clock
skew, spec §3).

## 5. Doc one-liner — DONE

`docs/dev/two-factor-auth.md` no longer claims `PUBLIC_USER_SELECT` is
unchanged; now notes it exposes only `totpEnabled` (added in c091380).

## Verification

- `pnpm --filter @vexlyx/api test` (full suite): **64/64 pass**
  (one transient `plugins/auth.test.ts` timeout on first run — untouched
  by this wave, green on re-run).
- `pnpm --filter @vexlyx/api typecheck`: clean.
