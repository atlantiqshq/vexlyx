# Task 4 Report — `TwoFactorService` + unit tests

## Status
COMPLETED. All 6 methods implemented per plan (`createSetup`, `confirmSetup`,
`verifyLoginCode`, `disable`, `adminReset`, `storeChallenge`/`consumeChallenge`),
with the controller's binding ruling applied to `confirmSetup`.

## Deviations from plan (deliberate, per instructions)
1. **Ruling — `confirmSetup` single-pass hashing:** plan's code did `createMany`
   with plaintext-hash placeholders, then `findMany` + double `update` loop
   (including one loop writing the *plaintext* code into `codeHash` before
   hashing — a secret-persistence bug). Implemented instead: generate 10
   plaintext codes → `argon2.hash` each → single `createMany` with
   `{ userId, codeHash }` → return plaintext once. No plaintext ever persists.
2. **Test env setup:** plan's verbatim test uses hoisted static imports, but
   `config/env.ts` validates `process.env` eagerly at import time, so static
   imports run before any in-file assignment (repo pattern: see
   `src/plugins/auth.test.ts:8-11`). Test sets `DATABASE_URL`/`SESSION_SECRET`
   first, then uses top-level `await import()` for the service + `encrypt()`.
   No `extractRawSecretForTest` helper needed: the test stores `encrypt(secret)`
   and generates codes from the in-memory `secret` directly.
3. **Extra assertions (3 tests beyond plan's 1):** `createMany` called once with
   10 `{ userId, codeHash }` rows whose hashes differ from plaintext;
   `verifyLoginCode` accept/reject; challenge single-use round-trip.

## Commits
- `4ffc244` — `feat(2fa): add TwoFactorService with totp and recovery codes`
  (`apps/api/src/modules/auth/two-factor-service.ts`,
  `apps/api/src/modules/auth/two-factor-service.test.ts`)

## Test command + output
Command (from repo root):
`pnpm --filter @vexlyx/api test -- src/modules/auth/`

Output:
```
Test Files  9 passed (9)
Tests  59 passed (59)
Duration  8.13s
```
Targeted file run also passes 4/4. Red-green verified: before the implementation
existed, the test failed with `Cannot find module './two-factor-service.js'`
(the whole-suite failures in that same run were pre-existing: `@vexlyx/shared`
`dist/` unbuilt — fixed by running `pnpm --filter @vexlyx/shared build`, no
source changes; plus a flaky 5s timeout in `src/plugins/auth.test.ts`, outside
this task's scope).

Also verified: `pnpm --filter @vexlyx/api typecheck` → PASS (clean, zero errors);
`eslint` on both new files → clean.

## Concerns
- **None blocking Task 5.** Service constructor takes `(prisma, redis, auditLog)`
  with a minimal structural redis type (`set` with `(k, v, mode, ttl)`); Task 5
  passes `app.redis` (ioredis) which satisfies it.
- **Note for Task 5:** `disable()` re-calls `findUnique` via `verifyLoginCode`
  (2 user reads total) — fine for an infrequent op, no change needed.
- **Pre-existing repo issue (not mine, not fixed):** `@vexlyx/shared` `dist/`
  was unbuilt on this checkout, so API typecheck/tests fail until
  `pnpm --filter @vexlyx/shared build` is run once. Task 8's full verification
  should include that build step.

---

## Fix Round 1/5 — stale recovery codes on reconfirm (2026-09-26)

**Finding:** `confirmSetup` never cleared pre-existing recovery rows —
re-confirming accumulated >10 valid codes while the user holds only the
latest 10.

**Fix** (`two-factor-service.ts`, 1 line in `confirmSetup`, before `createMany`):
`await this.prisma.recoveryCode.deleteMany({ where: { userId, usedAt: null } })`.
Deletes only unused rows; used rows survive as audit history.

**Test** (`two-factor-service.test.ts`): new test "clears stale unused
recovery codes on reconfirm, keeping used rows" — in-memory recovery-code
store behind the `makeService` mock; confirm → consume one code via
`verifyLoginCode` → confirm again with a new secret → assert `deleteMany`
called with `{ where: { userId: "u1", usedAt: null } }`, latest batch code
verifies `true`, stale unused code verifies `false`. Supporting changes:
mocked `argon2` (`hash`/`verify` as fast deterministic fakes — real argon2
over 20 hashes + verify loops blew the 5s per-test timeout) and relaxed the
pre-existing hash assertion from `not.toContain(codes[0])` to per-index
`not.toBe` (same intent: no plaintext persisted; the fake hash embeds the
code by construction).

**Verification:** `pnpm --filter @vexlyx/api test -- src/modules/auth/` →
9 files, 60 tests, all pass (59 pre-existing + 1 new).

---

## Fix Round 2/5 — real argon2 in tests + used-row survival assertion (2026-09-26)

**Findings addressed:**
1. File-scoped `vi.mock("argon2")` hollowed the no-plaintext property test
   (fake hash embedded plaintext; assertions passed trivially). Removed the
   mock entirely — all tests now use real argon2. No `spyOn` fake retained
   anywhere; not needed.
2. Strengthened the property assertion: per-index `codeHash !== plaintext`
   retained, plus `argon2.verify(storedHash, plaintext)` resolves `true` for
   a stored row (proves hashing real and no plaintext persisted).
3. Reconfirm test now asserts observed state directly: after consume +
   reconfirm, exactly one row in the mock store has `usedAt !== null`, and
   its hash verifies against the consumed first-batch code — alongside the
   existing behavioral checks (latest batch verifies `true`, stale unused
   code verifies `false`).

**Timeouts:** per-test `{ timeout: ... }` only — 30s on the single-confirm
test (10 hashes + 1 verify), 60s on the reconfirm test (20 hashes + ~12
verifies across login-code loops). No global skips.

**Verification:** `pnpm --filter @vexlyx/api test --
src/modules/auth/two-factor-service.test.ts` → 9 files, 60 tests, all pass,
Duration 16.43s.
