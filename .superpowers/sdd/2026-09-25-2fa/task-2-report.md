# Task 2 Report — Prisma schema: User 2FA columns + RecoveryCode model

status: DONE_WITH_CONCERNS

## Commits
- 0c3acbb — feat(2fa): add totp columns and recovery_codes table (schema.prisma only; no migration — see concerns)

## Changes
- `apps/api/prisma/schema.prisma`:
  - `User`: added `totpSecretEncrypted String?`, `totpEnabled Boolean @default(false)`, `totpVerifiedAt DateTime?` after `oversellingEnabled` (verbatim per plan).
  - `User`: added `recoveryCodes RecoveryCode[]` relation alongside `sessions`.
  - New `RecoveryCode` model after `Session`, verbatim per plan (`@@map("recovery_codes")`, `onDelete: Cascade`, `@@index([userId])`).

## Tests
- `pnpm --filter @vexlyx/api db:generate` — PASS. Prisma Client v6.19.3 generated in ~1s (note: deprecation warning about `package.json#prisma` config, pre-existing, unrelated).
- `pnpm --filter @vexlyx/api db:migrate -- --name add-2fa` — BLOCKED, no migration created. Exact error:
  `Error code: P1012 — error: Environment variable not found: DATABASE_URL. (prisma\schema.prisma:10, Context: getConfig)`

## Concerns
1. **Migrate BLOCKED — no live DB reachable.** `DATABASE_URL` is unset in this environment and `.env` files must never be touched, so `prisma migrate dev` cannot run. No migration SQL was faked. Task 4 can proceed (generated client validates the schema), but whoever has a DB must run `pnpm --filter @vexlyx/api db:migrate -- --name add-2fa` before Task 4's Prisma calls work at runtime.
2. **Commit contains schema only, no `apps/api/prisma/migrations/` changes** (deviation from plan's Step 5 paths — there is nothing to add since migrate never ran).
3. Did not verify `recoveryCode` delegate exists on the generated client beyond successful generation (generation proves schema valid; delegate check needs a TS consumer — Task 4 will exercise it).
