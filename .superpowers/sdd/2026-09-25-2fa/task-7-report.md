# Task 7 Report — Settings Security card + Users reset button

## Status
COMPLETED (all 5 plan steps; Step 4 manual verify partially done — static checks + API tests pass, live browser flow not exercised).

## Commits
- `a8d35d7` feat(2fa): settings security card and admin reset (7 files, +499/−2)

## Changes
- Created `apps/dashboard/src/hooks/useTwoFactor.ts` — `setup` / `confirm` / `disable` / `adminReset` wrappers over Task 5 endpoints, exactly per plan.
- Created `apps/dashboard/src/components/settings/TwoFactorCard.tsx` — status Badge (Enabled/Not enabled from `useAuth().user.totpEnabled`), setup Dialog (QR via `<img src={qrDataUrl}>`, manual key + copy, 6-digit verify with client-side regex check), recovery-codes-once Dialog (copy-all, non-dismissable, "I saved these"), disable Dialog (password + code, destructive, no `confirm()`). All errors via inline form error + sonner toast; `refetch()` after confirm/disable so the badge flips without reload.
- Modified `SettingsPage.tsx` — renders `<TwoFactorCard />` below the change-password card.
- Modified `EditUserDialog.tsx` + `UsersPage.tsx` — ADMIN-only (and never self) "Reset 2FA" section in the edit dialog with a destructive confirm Dialog + toast; calls `POST /api/users/:id/2fa/reset`.
- `totpEnabled` plumbing (plan's follow-up edit): added `totpEnabled: true` to `PUBLIC_USER_SELECT` in `apps/api/src/modules/auth/service.ts` (covers `GET /me` and challenge `getCurrentUser`; `login()` already returns the full row minus password) and `totpEnabled: boolean` to shared `User` in `packages/shared/src/types/index.ts`. Rebuilt `@vexlyx/shared` dist (dashboard consumes `dist`, not `src`).
- Deviations from plan: reset lives in `EditUserDialog` (the F5.8 edit surface — there is no separate "New User dialog" file; create is `CreateSubAccountDialog`) rather than a users dialog file; used regex instead of zod for the 6-digit client check (no zod import needed dashboard-side); QR key copy state uses plain boolean flags. `useRefreshAnimation` not used — status is a static badge, no refresh spinner exists on this card.

## Verification
- `pnpm --filter @vexlyx/shared build` — PASS (required before dashboard typecheck; dashboard resolves shared via `dist`).
- `pnpm --filter @vexlyx/dashboard typecheck` — PASS (one fix needed mid-task: sibling Dialogs wrapped in fragment; `totpEnabled` missing until shared rebuild).
- `pnpm --filter @vexlyx/api typecheck` — PASS.
- `pnpm --filter @vexlyx/shared typecheck` — PASS.
- `pnpm --filter @vexlyx/dashboard lint` — PASS (no warnings/errors).
- `pnpm --filter @vexlyx/api test -- src/modules/auth/` — 10 files / 61 tests PASS (regression check on the select change).
- Manual browser flow (setup → QR scan → verify → 10 codes once → login challenge → recovery single-use → disable → ADMIN reset) NOT run — no dev API/DB up in this session. Recommended before Task 8 sign-off.

## Concerns
- `AuthService.login()` returns the whole Prisma row minus `password`, so responses include `totpSecretEncrypted` (AES-256-GCM ciphertext — not directly usable without `SESSION_SECRET`, but still broader than `PUBLIC_USER_SELECT`). Out of Task 7 scope; suggest narrowing `login()` to the select in a follow-up.
- `UserResponseSchema` (users list) still lacks `totpEnabled` — fine for now since the reset button is unconditional for ADMIN and reset is idempotent, but an admin-visible "2FA on/off" column later will need the schema + users select extended.
- Nested Dialog (edit + reset-confirm) works with shadcn but shares no focus trap issues in static check only — confirm visually in the manual pass.

## Fix round 1/3 (review findings)
- `fix(2fa): stop leaking totp secret in login response`
- OPEN (Important) fixed: `AuthService.login()` fetched the full user row and stripped only `password`, so `totpSecretEncrypted` (+ `totpVerifiedAt`) shipped in `POST /login` non-2FA responses. Now returns `this.getCurrentUser(user.id)` (PUBLIC_USER_SELECT incl. `totpEnabled`) after argon2 verification — one extra query per login, matching codebase style. No test asserted the secret in login output (verified via grep; no `service.login` unit tests exist), so no test updates needed.
- Minor fixed: `TwoFactorCard.tsx` `closeDialog` now also clears `qrDataUrl`/`manualKey`/`copiedKey`, so cancelling setup leaves no stale setup material (matches `handleDismissCodes` behavior).
- Verification: `pnpm --filter @vexlyx/api test -- src/modules/auth/` — 10 files / 61 tests PASS; `pnpm --filter @vexlyx/api typecheck` — PASS; `pnpm --filter @vexlyx/dashboard typecheck` — PASS (covers the TwoFactorCard edit).
