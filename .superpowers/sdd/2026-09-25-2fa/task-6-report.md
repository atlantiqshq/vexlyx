# Task 6 Report — Frontend two-step login + `useAuth`

Date: 2026-09-27 | Branch: `feat/f5.17-2fa` | Plan: `docs/superpowers/plans/2026-09-25-2fa.md` Task 6

## Status

DONE — all 4 steps complete (extend `useAuth`, code step in `LoginForm`, verification via static typecheck, commit).

## Commits

- `484728e` — `feat(2fa): two-step login with totp challenge` (2 files, +184/−64)

## Changes

- `apps/dashboard/src/hooks/useAuth.ts`
  - Added `LoginResult = { status: "done"; user } | { status: "needs2FA"; challengeToken }`.
  - `login()` now widens the `fetchAPI` generic to `{ user } | { requires2FA, challengeToken }` and narrows on `"requires2FA" in data`; `done` path keeps existing `queryClient.clear()` + state + `router.push("/dashboard")` behavior.
  - Added `confirm2FA(challengeToken, code)` → `POST /api/auth/2fa/challenge`, same session-establish behavior; exported alongside `login`.
- `apps/dashboard/src/components/auth/LoginForm.tsx`
  - `challengeToken` state; password submit stores the token on `needs2FA` instead of navigating.
  - Step-2 form: shadcn `Label`/`Input`/`Button` only, `cn()` for classes, no inline styles; `inputMode="numeric"`, `autoComplete="one-time-code"`, `maxLength={12}`, `autoFocus`.
  - Client-side `codeSchema` mirrors shared `TwoFactorChallengeSchema` code shape (`/^[0-9a-zA-Z-]{6,12}$`) so 6-digit TOTP and recovery codes both pass.
  - `handleCodeSubmit` / `handleBackToPassword` (returns to password step, clears errors); `ApiRequestError` → root error div + `toast.error`, matching existing lines 57-64 pattern. No `any`.

## fetchAPI / 202 finding (plan's call-out)

`fetchAPI` (`apps/dashboard/src/lib/api.ts:39`) throws only when `!response.ok`. HTTP 202 IS `ok` (200–299), so the Task 5 `202 { requires2FA: true, challengeToken }` resolves through the normal return path — **no adaptation needed**. Documented inline in `useAuth.ts` with a comment at the narrowing site.

## Manual verification (per report contract)

Dev servers were not started (no live API/DB in this environment), so the plan's live-login matrix could not be executed. Performed instead:

- `pnpm --filter @vexlyx/dashboard typecheck` → **PASS** (`tsc --noEmit`, zero errors).
- Grep for `login(` consumers under `apps/dashboard/src` → only `LoginForm.tsx` calls `login()`; the `User` → `LoginResult` return-type change affects no other component (other `useAuth` imports use `user`/`logout`/state only).
- Static trace of the matrix: no-2FA user → `200 { user }` → `done` → `/dashboard` (unchanged path); 2FA user → `202` → code step renders, `confirm2FA` → `200` → `/dashboard`; wrong code → `ApiRequestError` (401) → root error + toast, no navigation (state/token retained for retry).

Live check still owed when servers are up: no-2FA straight-through, code-step appearance, valid-code landing, wrong-code error without navigation.

## Concerns

- Minor: only the dashboard typecheck was run, not repo-wide `typecheck`/`lint` — Task 8 owns full verification; touched files are type-clean.
- `CardHeader className={cn("space-y-1 text-center")}` uses `cn()` with a single static string (constraint compliance); harmless.
- Step-2 keeps the email/password values only in the uncontrolled form (unmounted when code step shows); "Back to sign in" returns to an empty password form — acceptable, matches plan snippet which shows no credential retention.
