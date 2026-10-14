# Scheduled Tasks (F5.28)

> **Feature:** F5.28 — Scheduled Tasks (Cron Jobs)
> **Package:** `@vexlyx/api`, `@vexlyx/dashboard`, `@vexlyx/shared`, `system/python/docker_manager.py`
> **Depends on:** F1.5 (deploy), F5.3 (BullMQ scheduling pattern), F5.13 (server timezone), F5.18 (audit log), F5.20 (quotas), F5.23 (system email)
> **Issue:** #26

---

## 1. What it does

A project owner schedules a shell command to run **inside their project's container** on a five-field cron schedule. The panel records every run (status, exit code, duration, output), offers **Run now**, and emails the owner once when a task keeps failing.

Typical uses: `php artisan schedule:run` for Laravel, `php wp-cron.php` for WordPress, or a nightly script for a Node or Python app.

Access is **owner-only**, the same as every other project feature: you manage the tasks of projects you own. Admins and resellers manage their own projects, not other users'.

## 2. Architecture

```
Dashboard (Tasks tab) ──► Fastify routes ──► ScheduledTaskService ──► Postgres
                                   │                  │
                                   │                  ├─► BullMQ queue "scheduled-tasks" (one repeating job per task)
                                   │                  └─► Redis lock per task
                                   │
BullMQ worker ──► ScheduledTaskService.execute() ──► runner ──► python docker_manager.py exec
                                                                      │
                                                         docker exec <app container> sh -c <command>
```

- **Routes** (`routes.ts`) only parse input and map errors. All logic is in `service.ts`.
- **Scheduling** (`scheduler.ts`) holds one BullMQ job scheduler per task, id `scheduled-task:<taskId>`, with `tz` set to the server timezone (F5.13). It is a module-level singleton, like `backups/scheduler.ts`, so other modules can re-arm or remove tasks without a circular import.
- **Execution** goes through the Python system layer. Nothing in the API calls Docker directly.

### Data model

| Table | Purpose |
|---|---|
| `scheduled_tasks` | name, command, 5-field `schedule`, `timeoutSeconds`, `enabled`, `notifyOnFailure`, `consecutiveFailures`, `lastRunAt`. Cascades with the project and the user. |
| `scheduled_task_runs` | `trigger` (SCHEDULED or MANUAL), `status` (RUNNING, SUCCESS, FAILED, TIMEOUT, SKIPPED), `exitCode`, `output`, `startedAt`, `finishedAt`. Only the newest 50 per task are kept. |
| `users.max_scheduled_tasks` | Nullable quota, null means unlimited. |

## 3. How a run works

1. The worker calls `execute(taskId, trigger)`. A task that no longer exists, is disabled (scheduled runs only), or whose project was deleted or changed owner is **dropped and its repeating job removed**. This is how stale jobs clean themselves up.
2. A **Redis lock** (`scheduled-task-lock:<taskId>`, `SET NX PX`) stops a run overlapping the previous one. If the lock is held the new run is recorded as `SKIPPED` ("the previous run is still running"). The lock outlives a run by at most two minutes if the API dies.
3. A `RUNNING` row is written and the runner invokes `docker_manager.py exec`.
4. The result is saved and the run is pruned to 50 rows.
5. The failure streak is updated: SUCCESS resets it, FAILED and TIMEOUT add one, SKIPPED changes nothing. When the streak reaches **exactly 3** and the task has notifications on, one `scheduled_task_failed` email is sent. The email never contains the command's output, which may hold secrets.

### Skipped, not failed

A run is `SKIPPED` when the container isn't running, the project has never been deployed, or the previous run is still going. Skipped runs don't count as failures and don't update `lastRunAt`.

### "Run now"

`POST .../run` queues a MANUAL job and returns 202. If the task is already running it is refused with **409 `TASK_RUNNING`** instead of recording a skipped run. Manual runs work on disabled tasks.

## 4. The Python `exec` action

`system/python/docker_manager.py` → `cmd_exec`, called with `{ command: "exec", projectDir, shellCommand, runId, timeoutSeconds, maxOutputBytes }`. The shell command travels in `shellCommand` because `command` already names the action.

- **No host shell.** The command is one argument of `docker exec <container> sh -c <command>` built as an argument list. Shell metacharacters are only ever interpreted inside the container.
- **Always the `app` service.** For WordPress and no-build PHP the primary (web-facing) service is `web` (nginx), but `php` lives in `app`, so tasks always target `app`. The container is found with `docker compose ps -q app` in the project's `deploy` directory, so a redeploy that replaces the container needs no change to the task.
- **Timeout kills the whole tree.** Killing the `docker exec` client does *not* stop the command inside the container, and the `timeout` binary only signals its direct child. So each run starts with `-e VX_TASK_RUN=<runId>`; on timeout the runner kills the client and then, inside the container, every process whose environment carries that marker (children inherit it). It reads `/proc` directly, so it works in images without `ps`. Verified on `node:22-alpine`, `python:3.12-slim` and `wordpress:php8.3-fpm-alpine`, including that another run's processes survive.
- **Output** (stdout and stderr together) is capped at 64 KB; the runner keeps reading after the cap so a chatty command never blocks.
- A container with no `sh` fails with an explanatory message.

## 5. Limits and rules

| Rule | Value |
|---|---|
| Schedule | Five fields only. Seconds fields and `@macros` are rejected; the fastest schedule is once a minute. Values are checked with `cron-parser`. |
| Command | 1 to 2,000 characters, no control characters except newline and tab |
| Timeout | 1 to 3,600 seconds, default 300 |
| Runs kept | 50 per task |
| Output | 64 KB per run |
| Concurrency | `SCHEDULED_TASK_CONCURRENCY` (default 4) commands at once across the server |
| Project types | Not available for `STATIC` and `REACT`, which have no runtime |
| Quota | `maxScheduledTasks`, per user across all their projects. **Not** part of reseller overselling pools. Warnings at 80% and 100% (F5.23). |

Run-now is rate limited to 10 a minute and the schedule preview to 60.

## 6. Timezone

Schedules are evaluated in the server timezone (F5.13). Changing it re-arms every task (`PUT /api/system/settings` calls `rearmAllTasks`). Around daylight-saving changes a job set for a time that doesn't exist (for example 02:30 on the spring-forward day) runs once at the shifted time; one set for a repeated hour runs once. This follows `cron-parser`'s behaviour and is covered by a test.

## 7. Restarts, deletes and what is not made up

At API start, `reconcile()`:

1. closes runs still marked `RUNNING` as `FAILED` ("Interrupted: the panel restarted…"),
2. deletes any task locks (nothing can still be running under a single API process),
3. re-arms every enabled task in the current timezone,
4. removes repeating jobs whose task is gone or disabled.

The worker uses `maxStalledCount: 0`, so a run interrupted by a restart is **not** retried as a "stalled" job, which would run the user's command a second time.

- **Runs missed while the API was down are not made up.**
- **A command can outlive an API crash.** The `docker exec` keeps running in the container until it finishes or its own timeout; the panel just stops tracking it.
- Deleting a project (`teardownWorkspace`) deletes its tasks and jobs. A run that was in flight when its task disappeared finishes quietly: it cannot record its result and that is not treated as an error.
- Job records are not kept in Redis (`removeOnComplete`), because the outcome lives in `scheduled_task_runs`. Without this an every-minute task would add 1,440 records a day.

## 8. Security notes

- Ownership is checked on every call and again on every run, including scheduled ones: a task whose project changed hands is dropped.
- The command text is **never written to the audit log** (it can contain secrets). The log records name, schedule, enabled, timeout and a `commandChanged` flag. Create, update, delete and run-now are all audited.
- Run output is only returned to the project's owner. It is never logged by the API.
- Every shipped compose template sets a memory limit on the container, and a command runs inside that limit. None sets a CPU limit, so a runaway command is bounded in CPU only by its timeout, the output cap and the worker concurrency.

## 9. API

All routes need a session and are under `/api/projects/:id/scheduled-tasks`.

| Method | Path | Notes |
|---|---|---|
| GET | `/` | Tasks, server timezone, quota and whether the project type is supported |
| POST | `/` | 201. 403 `QUOTA_EXCEEDED`, 400 `INVALID_SCHEDULE` or `UNSUPPORTED_PROJECT_TYPE` |
| POST | `/preview` | `{ schedule }` → next five run times in the server timezone |
| PUT | `/:taskId` | Partial update. Changing the command or re-enabling resets the failure streak |
| DELETE | `/:taskId` | 204 |
| POST | `/:taskId/run` | 202 `{ queued: true }`, or 409 `TASK_RUNNING` |
| GET | `/:taskId/runs?limit=` | Newest first, at most 50 |

Another user's project returns 403; an unknown project or task returns 404; signed out returns 401.

## 10. Presets

`packages/shared/src/schemas/scheduledTasks.ts` holds `SCHEDULE_PRESETS` (every minute, hour, day, week) and `TASK_PRESETS` (stack starting points shown in the dialog for matching project types).

| Preset | Command | Schedule | For |
|---|---|---|---|
| Laravel scheduler | `php artisan schedule:run` | every minute | `PHP` projects |
| WordPress cron | `php wp-cron.php` | every 5 minutes | `WORDPRESS` projects |

The WordPress image has `php` but **no `wp` CLI**, so the preset uses `wp-cron.php`; add `define('DISABLE_WP_CRON', true);` to `wp-config.php` so it also stops running on page views. WordPress exits with status 0 even when its database is unreachable, so a "Succeeded" run of this preset should be checked in its output. The preset command was confirmed to be available (`php` exists in the image); a full end-to-end cron run in an installed WordPress was not exercised here.

To add a preset, append to `TASK_PRESETS` with the project types it applies to, and confirm the binary exists in that type's image first.

## 11. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SCHEDULED_TASK_CONCURRENCY` | `4` | Commands running at once, server-wide (1 to 20) |

## 12. How to test

| Layer | How |
|---|---|
| Cron helpers, schemas, routes, quota | `pnpm --filter @vexlyx/api test` |
| Service against Postgres | `SCHEDULED_TASK_TEST_DATABASE_URL=postgresql://… pnpm exec vitest run src/modules/scheduled-tasks` in `apps/api` (migrations applied) |
| Python `exec` | `python -m unittest system/python/test_docker_manager_exec.py` |
| Dashboard helpers | `pnpm --filter @vexlyx/dashboard test` |

The live behaviour (real Docker, Redis and BullMQ) was checked with a scripted run covering: validation, 401/403/404, the timeout killing the process tree, output cap, one failure email per streak, a stopped project being skipped and resuming, a redeploy, overlap handling, quota, scheduled runs on a real clock, an API restart mid-run (no re-run), a timezone change re-arming jobs, and project deletion removing tasks and jobs.

## 13. Not in the first version

Fetch-URL tasks, host-level server tasks for admins, second-level schedules, job chaining, per-run environment overrides, importing a crontab, reseller or admin access to other users' projects' tasks, and per-container CPU limits.
