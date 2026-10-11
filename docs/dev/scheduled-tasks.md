# Scheduled Tasks (F5.28)

Users can run a command inside a project's container on a cron schedule — Laravel's `php artisan schedule:run`, WordPress's `wp-cron.php`, a nightly cleanup or report script — without an external cron service or shell access. Each task gets run history, a "Run now" button and failure emails, and runs never touch the host.

## Data model

One migration (`20261010000000_add_scheduled_tasks`):

- **`ScheduledTask`** — `projectId`/`userId` (both cascade on delete), `name`, `command`, `schedule` (5-field cron), `timeoutSeconds` (default 300, max 3600), `enabled`, `notifyOnFailure` (default true), `consecutiveFailures`, `lastRunAt`, `nextRunAt`.
- **`ScheduledTaskRun`** — `taskId` (cascade), `trigger` (`SCHEDULED` | `MANUAL`), `status` (`RUNNING` | `SUCCESS` | `FAILED` | `TIMEOUT` | `SKIPPED`), `exitCode`, `output` (capped at 64 KB), `startedAt`, `finishedAt`. Only the latest **50 runs per task** are kept; older rows are deleted after each new run.
- **`User.maxScheduledTasks`** — nullable quota, enforced through the same F5.20 machinery as every other quota (`assertUnderQuota` in `utils/quota.ts`, including the reseller pool/oversell checks) with F5.23 warning emails at 80% and 100% (`notifyQuotaThreshold`). It participates in reseller pooling exactly like projects/domains/databases/mailboxes.

## How scheduling works

`scheduler.ts` keeps a module-level reference to the `scheduled-task-runner` BullMQ queue (mirroring `backups/scheduler.ts`) so other modules can re-arm schedules without a circular import:

- One BullMQ **job scheduler** per task, id `scheduled-task:<taskId>`, with the task's cron pattern and the F5.13 server timezone as `tz`.
- On API boot every enabled task is re-armed and its `nextRunAt` is refreshed from BullMQ's own computed next run (`getJobSchedulers()[...].next`), so what the dashboard shows is what will actually fire — DST quirks included.
- Create/update/disable/delete re-arm or remove the scheduler immediately; **changing the server timezone** (`PUT /api/system/settings`) re-arms everything via `rescheduleAllTasks()`.
- Missed runs while the API was down are **not back-filled** (documented behavior).

## How execution works

The worker (and "Run now") call `ScheduledTaskService.executeTask()`:

1. A **Redis lock** (`SET NX EX`, TTL = timeout + 30s) prevents overlapping runs; an overlapping run is recorded as `SKIPPED`, never as a failure. The lock is released with a compare-and-delete Lua script, so only the holder releases its own lock.
2. If the project has no running container the run is recorded as `SKIPPED` ("Project not running") — the task itself stays enabled and resumes on its next tick.
3. The command runs through the Python system layer: `docker_manager.py`'s `exec` action runs `docker exec <container> sh -c "<command>"`. The command is passed as an argv element (never interpolated into a host shell), the container is resolved **at run time** from the project (so a redeploy that replaces the container doesn't break the task), and both a hard timeout and a 64 KB output cap are enforced in Python (a `threading.Timer` kills the process on timeout).
4. The run row is created as `RUNNING` and **updated in place** with the final status/exit code/output, so history never accumulates orphaned RUNNING entries. Manual ("Run now") execution is synchronous — the API responds with the finished run.

Failure streaks: `consecutiveFailures` increments on `FAILED`/`TIMEOUT` (including spawn/infrastructure errors) and resets to 0 on `SUCCESS`. At exactly 3 consecutive failures one email (`scheduled_task_failed`, F5.23) goes to the **task's owner**, unless the task has `notifyOnFailure` off — once per streak, not per run.

## Guards and limits

Enforced in `packages/shared/src/schemas/scheduledTasks.ts` (rejected with `VALIDATION_ERROR` / 400):

- 5-field cron only — a 6-field (seconds) expression is rejected; minimum interval is one minute.
- Command ≤ 2,000 characters; timeout 1–3,600 seconds; name ≤ 100 characters.

Authorization (in the service, not the routes): owners manage tasks of their own projects, admins everything, resellers the tasks of their **sub-accounts** — checked via the *owner's* `resellerId`, since a RESELLER's own `resellerId` is always null. Unauthenticated calls get 401 (`requireAuth` on every route); other users' tasks get 403. Create/update/delete/run-now are written to the audit log (`scheduled_task.*` actions, F5.18).

## API

All under `/api/projects/:id/scheduled-tasks`, authenticated:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | List the project's tasks |
| POST | `/` | Create (quota-enforced, schedules the job, returns `nextRunAt`) |
| GET | `/:taskId` | Task detail (404 if the task isn't part of this project) |
| PUT | `/:taskId` | Update; re-arms the scheduler when `schedule`/`enabled` change |
| DELETE | `/:taskId` | Delete + unschedule |
| POST | `/:taskId/run` | Run now (synchronous, audited) |
| GET | `/:taskId/runs?limit=` | Run history (limit 1–100, default 50) |

## UI

A "Scheduled Tasks" panel on the project detail page (`ScheduledTasksPanel.tsx`): list with an enable/disable switch, failure-streak badge, last/next run; a create/edit dialog with presets (every minute, every 5 minutes, hourly, daily, weekly) plus a custom cron field with a plain-English description (cronstrue, timezone-aware); "Run now"; a run-history dialog with output in the always-dark terminal style; skeleton loading, empty state with a CTA, confirmation before delete, and a refresh button with the standard spin animation.

**Presets for common stacks**: `php artisan schedule:run` every minute (Laravel) and `wp-cron.php` every 5 minutes (WordPress — the panel's docs recommend setting `DISABLE_WP_CRON` in the app). Both runtimes ship the needed binaries in the standard Vexlyx images; the commands themselves are just typed into the Command field.

## How to test

Unit/integration (Vitest, colocated):

- `service.test.ts` — execution happy path, overlap lock (SKIPPED), project-not-running (SKIPPED), failure-streak email at exactly 3 (and silence below it / with notify off), streak reset on success, TIMEOUT counting as a failure, run-history trimming, reseller/sub-account access, `QUOTA_EXCEEDED`.
- `routes.test.ts` — 401 on every endpoint when signed out, 403 for another user's project, owner and reseller access, cron/command validation (6-field and over-long command rejected), audited creation, quota enforcement, cross-project task 404.
- `utils/quota.test.ts` — the `scheduledTask` quota participates in the F5.20 nominal-pool cap.

Manual (needs Docker + the dev stack): create `echo hello` on the every-minute preset for a running project → a SUCCESS run with output `hello` appears within a minute; a command that outlives its timeout → TIMEOUT; three failing runs → exactly one email to the owner; stop the project → SKIPPED, start it → resumes; restart the API → schedules and `nextRunAt` restored; change the server timezone → next-run times shift.

## How to extend

- **New task type** (e.g. fetch-URL tasks, out of scope for v1): add an execution branch in `executeTask()` and a trigger/status if needed — the scheduling, locking, history and notification machinery is type-agnostic.
- **Adding a preset**: append to `CRON_PRESETS` in `ScheduledTasksPanel.tsx`; verify the required binary exists in the runtime image first.
- **Per-task notification settings** (e.g. "notify every failure"): extend the model + the single call site in `updateStreak()`.
