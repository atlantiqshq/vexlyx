# Task 1 Report — Dependencies + `REQUIRE_ADMIN_2FA` env flag

- **Status:** DONE_WITH_CONCERNS
- **Date:** 2026-09-25
- **Branch:** feat/f5.17-2fa

## What was done

- Added `REQUIRE_ADMIN_2FA` to `envSchema` in `apps/api/src/config/env.ts`
  (verbatim snippet from plan, inserted after `ALLOW_REGISTRATION` block):
  enum `["true", "false"]`, default `"false"`, transform to boolean.
  Exposes `env.REQUIRE_ADMIN_2FA: boolean` for the Task 5 login gate.
- Documented the flag in `apps/api/.env.example` (verbatim lines from plan).
- Did NOT touch `apps/api/package.json` (ruling: user installs manually)
  and did NOT touch any `.env` file.

## Install commands for the user (NOT executed — run manually)

```bash
pnpm --filter @vexlyx/api add otplib@12 qrcode
pnpm --filter @vexlyx/api add -D @types/qrcode
```

## Commits

- `feat(2fa): add REQUIRE_ADMIN_2FA flag and totp deps` (covers
  `apps/api/src/config/env.ts` + `apps/api/.env.example` only;
  `package.json` untouched per ruling, so omitted from the commit)

## Test command + output

- Command: `pnpm --filter @vexlyx/api typecheck`
- Result: FAIL — but on pre-existing, unrelated errors only.
  - Zero errors reference `src/config/env.ts`; the new flag parses cleanly.
  - All reported errors are `TS2307: Cannot find module '@vexlyx/shared'`
    (workspace package unbuilt in this checkout), plus pre-existing
    `implicit any` / stale-Prisma-client errors across untouched modules
    (auth, mail, backups, domains, etc.).
  - Same failure would occur on the base commit; not caused by this change.
  - Full output retained in the worker transcript (truncated at tool limit).

## Concerns

1. `pnpm --filter @vexlyx/api typecheck` does NOT pass repo-wide on this
   checkout (pre-existing `@vexlyx/shared` resolution failure + stale Prisma
   client). Task 5+ workers should run `pnpm install` / build shared first,
   or scope verification to `env.ts`.
2. `otplib@12` + `qrcode` + `@types/qrcode` are NOT installed (per ruling).
   Task 4 (TwoFactorService) cannot typecheck/test until the user runs the
   two install commands above.

## Fix round 1/5 (2026-09-25) — reviewer findings addressed

- Renamed HEAD commit to `feat(2fa): add REQUIRE_ADMIN_2FA flag`
  (drops misleading "and totp deps" — no deps were added; user installs manually).
- Added missing blank line in `apps/api/.env.example` before the
  `# Require TOTP` comment (now matches surrounding comment-block style).

### Finding 1 evidence — typecheck failure is pre-existing, unrelated

- Full output captured to `.superpowers/sdd/2026-09-25-2fa/task-1-typecheck.log`
  (`pnpm --filter @vexlyx/api typecheck`, exit 1, 139 `error TS` lines).
- Zero of the 139 errors reference `src/config/env.ts`
  (`Select-String "config/env"` on the log returns 0 matches).
- Breakdown: 63x `TS2307 Cannot find module '@vexlyx/shared'`
  (workspace package unbuilt), 62x `TS7006 implicit any` across untouched
  modules (aliases, backups, dashboard, quota, …), 10x `TS2305/TS2694`
  stale-Prisma-client errors (audit-log, databases, domains), ~4 other.
- Excerpt (head of log):
  `src/index.ts(5,42): error TS2307: Cannot find module '@vexlyx/shared' …`
  `src/modules/audit-log/service.ts(53,52): error TS2694: Namespace '….Prisma' has no exported member 'InputJsonValue'.`
- Pre-existing proof without a second full run: `git diff HEAD~1 --name-only`
  shows this change touches ONLY `apps/api/src/config/env.ts`,
  `apps/api/.env.example` (+ this report) — every one of the 139 error
  lines is in a file this commit never touched, so the failure exists
  independently of this change.
- Scoped check on the touched file: `eslint src/config/env.ts` exits 0
  (clean, no warnings/errors). Re-ran typecheck capture after the blank-line
  fix — same 139 pre-existing errors, still zero in `env.ts`.
