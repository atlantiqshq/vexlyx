# Resource Monitoring (F5.2)

> **Status:** 🟢 COMPLETED  
> **Feature:** Server and container resource monitoring with real-time Socket.io push, historical persistence, and threshold alerts.

---

## What It Does

Host-wide monitoring is ADMIN-only. USER and RESELLER accounts receive 403 from
the monitoring REST endpoints and cannot subscribe to metrics or threshold
alerts. The dashboard returns `serverMetrics: null` for them without collecting
host metrics, and hides Server Health and Monitoring navigation. Direct page
visits show "Access restricted" before mounting monitoring hooks.

Socket subscriptions use the server-resolved user and session IDs. The API
checks Redis session existence/expiry and the current PostgreSQL role before
initial delivery and every live/background delivery. It rechecks after slow
initial collection, invalidates pending subscriptions on unsubscribe/disconnect,
and removes revoked subscribers from the metrics room and stops their timers.
Data and threshold alerts are delivered individually to authorized subscribers,
so stale room membership cannot bypass the check. Authorization-store errors
fail closed. Other socket features remain available to authenticated tenants.

The collector continues persisting and pruning host snapshots even when there
are no authorized subscribers. Deploy by rebuilding/restarting the API and
dashboard; no migration or new environment variable is required.

Regression tests run in the standard API/dashboard suites. After building the
API and shared package, `pnpm --filter @vexlyx/api test:monitoring-browser` runs
real browser requests against PostgreSQL, Redis, sessions and Socket.IO. Docker,
Playwright and Chromium/Chrome are required; set `VEXLYX_PLAYWRIGHT_MODULE` and
`VEXLYX_BROWSER_EXECUTABLE` if they are not on the default paths. After building
the dashboard, `pnpm --filter @vexlyx/dashboard test:monitoring-browser` checks
navigation, Server Health visibility and direct page access in the production
dashboard with fixture API responses and blocked sockets. It also asserts that
tenants never mount monitoring hooks. Component tests cover the UI guards too.

The browser fixture uses synthetic native metrics. Authorization, sessions,
database history and Socket.IO are real. It binds random loopback ports, avoids
developer `.env` files, and removes its containers and volumes on completion.

F5.2 adds a `/monitoring` page to the Vexlyx dashboard that shows:

- **Live server gauges** — CPU %, RAM %, Disk % updated every 5 seconds via Socket.io
- **System stats** — Uptime, load average (1/5/15m), cumulative network RX/TX
- **Historical trend chart** — Area chart of CPU/RAM/Disk over 1h, 24h, 7d, or 30d
- **Container resource table** — Per-container CPU, RAM usage, and network I/O
- **Threshold alerts** — Animated badge + sonner toast when CPU >80%, RAM >85%, or Disk >90%

---

## Architecture

```
Browser                         API Server                    Host OS
──────                         ──────────                    ───────
useServerMetrics()  ──WS──▶   subscribe:metrics    ─────▶  system_monitor.py
                    ◀──WS──   metrics:server push           (psutil / /proc)
                    ◀──WS──   alert:threshold

useMetricHistory()  ──REST──▶  GET /api/monitoring/history
                    ◀──JSON──  MetricSnapshot[] (PostgreSQL)

                               BullMQ Worker (every 60s)
                               → system_monitor.py
                               → save MetricSnapshot
                               → push to metrics room
```

### Key Files

| File | Purpose |
|------|---------|
| `system/python/system_monitor.py` | Python collector — psutil for server, `docker stats` for containers |
| `apps/api/src/modules/monitoring/service.ts` | Spawns Python script, queries DB history, saves snapshots |
| `apps/api/src/modules/monitoring/socket.ts` | Socket.io handlers + BullMQ job runner |
| `apps/api/src/modules/monitoring/routes.ts` | REST endpoints + BullMQ repeatable job registration |
| `apps/api/prisma/schema.prisma` | `MetricSnapshot` model |
| `apps/dashboard/src/hooks/useMonitoring.ts` | React hooks (Socket.io + REST fallback + alerts) |
| `apps/dashboard/src/components/monitoring/` | All UI components |
| `apps/dashboard/src/app/(panel)/monitoring/page.tsx` | Next.js route |

---

## Python Collector (`system_monitor.py`)

**Protocol:** Same as `docker_manager.py` — JSON payload on stdin, JSON response on stdout.

```bash
# Test server metrics manually:
echo '{"command":"server_metrics"}' | python3 system/python/system_monitor.py

# Test container metrics:
echo '{"command":"container_metrics"}' | python3 system/python/system_monitor.py
```

**psutil is preferred** but the script falls back to `/proc/stat`, `/proc/meminfo`, `os.statvfs()`, and `/proc/net/dev` if psutil is unavailable. Install with:

```bash
pip install psutil
```

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/monitoring/server` | ADMIN | Live server metrics snapshot |
| `GET` | `/api/monitoring/containers` | ADMIN | Live per-container metrics |
| `GET` | `/api/monitoring/history?range=24h` | ADMIN | Historical snapshots (`1h` / `24h` / `7d` / `30d`) |

---

## Socket.io Events

| Direction | Event | Payload |
|-----------|-------|---------|
| Client → Server | `subscribe:metrics` | — |
| Server → Client | `metrics:server` | `ServerMetrics` |
| Server → Client | `metrics:containers` | `ContainerMetric[]` |
| Server → Client | `alert:threshold` | `AlertThreshold` |
| Client → Server | `unsubscribe:metrics` | — |

---

## Database

A new `metric_snapshots` table is created by migration:

```sql
CREATE TABLE metric_snapshots (
  id           TEXT PRIMARY KEY,
  cpu_percent  DOUBLE PRECISION NOT NULL,
  ram_used     BIGINT NOT NULL,
  ram_total    BIGINT NOT NULL,
  disk_used    BIGINT NOT NULL,
  disk_total   BIGINT NOT NULL,
  recorded_at  TIMESTAMP DEFAULT NOW()
);
CREATE INDEX ON metric_snapshots (recorded_at);
```

Snapshots are written every **60 seconds** by the BullMQ `metrics-collector` worker.  
Snapshots older than **30 days** are pruned automatically in each collection cycle.

---

## Background Collector (BullMQ)

The repeatable job is registered in `monitoringRoutes()` on startup:

```ts
await metricsQueue.upsertJobScheduler(
  "collect-metrics",
  { every: 60_000 },        // run every 60 seconds
  { name: "collect-metrics", data: {} },
);
```

`upsertJobScheduler` is idempotent — safe to call on every restart without creating duplicates.

---

## Alert Thresholds

Default thresholds (hardcoded in `socket.ts`):

| Resource | Default Threshold |
|----------|------------------|
| CPU | > 80% |
| RAM | > 85% |
| Disk | > 90% |

To change defaults, edit `DEFAULT_THRESHOLDS` in `apps/api/src/modules/monitoring/socket.ts`.

---

## How to Test

1. Start the dev stack: `pnpm dev`
2. Visit `http://localhost:3000/monitoring`
3. Verify live gauges update every 5 seconds (watch CPU/RAM fluctuate)
4. Check the container table populates if Docker containers are running
5. Wait ~60 seconds → check the 1h chart starts showing data points
6. Simulate a CPU spike: open Task Manager / `stress-ng` on the server → watch toast appear

---

## How to Extend

### Add a new metric to the server snapshot

1. Add field to `ServerMetricsSchema` in `packages/shared/src/schemas/monitoring.ts`
2. Collect it in `get_server_metrics()` in `system/python/system_monitor.py`
3. Add it to the `MonitoringPage` UI in the system info grid or as a new gauge

### Add a new alert type

1. Add the check in `checkThresholds()` in `apps/api/src/modules/monitoring/socket.ts`
2. Add a dismiss case in `ThresholdAlertBadge.tsx`

### Persist container metrics historically

Currently only server-level snapshots are persisted. To add per-container history:
1. Add a `ContainerSnapshot` model to `schema.prisma` with `containerId` + metrics fields
2. Call `service.saveContainerSnapshots()` from the BullMQ job in `socket.ts`

---

## Per-Core CPU & Timezone (F5.13)

### Per-core CPU

`get_server_metrics()` now also returns `cpuPerCore` (array of per-core %) and
`cpuCoreCount`. `_get_cpu_stats()` in `system_monitor.py` gets both in a single
`psutil.cpu_percent(interval=0.2, percpu=True)` call (one sleep, not two) — the
aggregate `cpuPercent` is the average of that list rather than a separate
psutil call. When psutil is unavailable, it falls back to the existing
single-value platform calculation, with `cpuPerCore` as a single-element array
and `cpuCoreCount` from `os.cpu_count()`.

This is **live-only** — per-core data is pushed over the existing
`metrics:server` Socket.io event / `GET /api/monitoring/server` REST endpoint,
but is **not** persisted to `MetricSnapshot` or exposed via `/history`, so
there's no per-core historical trend. `MonitoringPage.tsx`'s
`PerCoreCpuBars` component renders one bar per core (only when
`cpuPerCore.length > 1`, i.e. psutil is available) next to the aggregate CPU
gauge. When it isn't (`cpuPerCore.length <= 1` but `cpuCoreCount > 1` —
i.e. the fallback engaged on a genuinely multi-core box), a muted
"install psutil" hint renders instead of silently showing nothing.

`system/scripts/install/steps/04-runtime.sh` installs `psutil` via
`pip3 install --break-system-packages` alongside `cryptography`, so a fresh
production install always has real per-core data. A local dev box the
installer never touched (e.g. this repo's own Windows dev environment) still
needs `pip install psutil` by hand to see it — otherwise it silently runs the
`/proc`-parsing fallback (single aggregate value only).

### Server timezone

A new singleton `SystemSettings` model (`id: "default"`, mirrors
`BackupSettings`/`FirewallSettings`) holds the server's configured IANA
timezone, defaulting to `Intl.DateTimeFormat().resolvedOptions().timeZone` on
first read. Managed via:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/system/settings` | any authenticated user | Read the current timezone |
| `PUT` | `/api/system/settings` | ADMIN | Update it (validated against the runtime's own IANA tz database via `Intl.DateTimeFormat`) |

Edited from the **Settings page** (F5.11) "Server Timezone" card.

**Backup cron.** `apps/api/src/modules/backups/routes.ts` passes `tz` to
`backupQueue.upsertJobScheduler()` alongside the existing `pattern`. Since the
timezone can change from a different module (`system/routes.ts`) than the one
owning the queue (`backups/routes.ts`), `apps/api/src/modules/backups/scheduler.ts`
exposes a small module-level singleton (`registerBackupQueue`,
`setCurrentBackupCron`, `rescheduleBackupJob`) that mirrors `plugins/socket.ts`'s
`getIO()` accessor pattern — `PUT /api/system/settings` calls
`rescheduleBackupJob()` so a timezone change takes effect immediately, without
a restart.

**Dashboard timestamps.** `apps/dashboard/src/lib/datetime.ts` exports
`formatDateTime` / `formatDate` / `formatTime`, each taking an explicit
`timezone?: string` — sourced via `useTimezone()` from
`apps/dashboard/src/hooks/useSystemSettings.ts` (a thin TanStack Query wrapper
around `GET /api/system/settings`, 5-minute `staleTime`). Every page/component
that previously called `toLocaleString()`/`toLocaleDateString()`/
`toLocaleTimeString()` with an implicit browser timezone now goes through
these helpers instead.

### How to extend

- **Persist per-core history:** add a `cpuPerCore Float[]` column to
  `MetricSnapshot`, write it in `saveSnapshot()`, and extend
  `MetricHistoryChart` to plot it — currently out of scope (live-only, see
  above).
- **New timezone-aware surface:** import `formatDateTime`/`formatDate`/
  `formatTime` from `@/lib/datetime` and `useTimezone()` from
  `@/hooks/useSystemSettings` — don't call `toLocaleString()` directly.
