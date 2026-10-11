# Infrastructure — Docker Compose Dev Environment

`docker-compose.yml` originally ran three services (PostgreSQL, Redis, Traefik); it now runs nine, one per infrastructure piece the panel depends on:

| Service | Image | Purpose |
|---|---|---|
| `postgres` | `postgres:16-alpine` | Primary database (see [Database](database.md)) |
| `mysql` | `mysql:8.0` | Optional database type for [user-provisioned databases](database-provisioning.md) |
| `redis` | `redis:7-alpine` | Sessions, caching, BullMQ queues |
| `adminer` | `adminer:4` | Dev-only raw DB browser — gated behind `--profile debug` in production |
| `traefik` | `traefik:v3.6` | Reverse proxy, automatic Let's Encrypt HTTPS, per-domain dynamic routing |
| `coredns` | `coredns/coredns:1.11.3` | Authoritative DNS for domains in [Hosted DNS mode](dns-management.md) |
| `postfix` | `vexlyx-postfix` (custom) | Outbound/inbound SMTP — see [Postfix](email/postfix.md) |
| `dovecot` | `vexlyx-dovecot` (custom) | IMAP + mailbox storage — see [Dovecot](email/dovecot.md) |
| `roundcube` | `roundcube/roundcubemail:1.6.18-apache` | Webmail — see [Webmail](email/webmail.md) |

All services have health checks and persistent volumes. Two more images are built locally at install time rather than pulled — `vexlyx-ufw-helper` (see [Firewall](firewall.md)) and `vexlyx-php-fpm` (see [No-build PHP hosting](no-build-php-hosting.md)) — see `system/scripts/install/steps/10-images.sh`.

## Quick Start

```bash
# Start all infrastructure services
docker-compose up -d

# Verify everything is healthy
docker-compose ps

# Follow logs from all services
docker-compose logs -f

# Stop services (data persists)
docker-compose down

# Stop and destroy all data
docker-compose down -v
```

## Services

### PostgreSQL 16

| Property | Value |
|----------|-------|
| Image | `postgres:16-alpine` |
| Port | `5432` |
| User | `vexlyx` |
| Password | `vexlyx_dev` |
| Database | `vexlyx_dev` |
| Volume | `vexlyx_postgres_data` |

**Connection string:** `postgresql://vexlyx:vexlyx_dev@localhost:5432/vexlyx_dev`

### Redis 7

| Property | Value |
|----------|-------|
| Image | `redis:7-alpine` |
| Port | `6379` |
| Max memory | `256mb` |
| Eviction | `allkeys-lru` |
| Persistence | AOF (`appendonly yes`) |
| Volume | `vexlyx_redis_data` |

**Connection string:** `redis://localhost:6379`

**Usage in Vexlyx:**
- **Sessions** — the custom session plugin (`apps/api/src/plugins/auth.ts`, not a third-party auth library) stores signed session tokens here, keyed `session:<id>`, with a 24-hour TTL
- **Caching** — API response caching, rate limiting
- **Queues** — BullMQ background job processing (see below)

**Test connectivity:**
```bash
docker exec vexlyx-redis redis-cli ping
# Returns: PONG
```

### Traefik v3

| Property | Value |
|----------|-------|
| Image | `traefik:v3.6` (bumped from `v3.4` — see the [installer reference](installer.md#bugs-found-during-the-real-install-and-their-fixes) for why) |
| HTTP/HTTPS Ports | `80` / `443` |
| Dashboard | `http://localhost:8080` |
| Docker provider | Enabled (`exposedByDefault: false`) |

**Dashboard:** Open `http://localhost:8080` in your browser to view the Traefik dashboard. This shows all configured routers, services, and middlewares.

**Configuration files:**
- Static config: `docker/traefik/traefik.yml` (dev) / `traefik.prod.yml.tmpl` (production)
- Dynamic configs: `docker/traefik/dynamic/` — one YAML file per verified custom domain
  (`domain-{domainId}.yml`, written by `DomainService.syncTraefikRouter()`) plus a couple of
  static routes (e.g. webmail). See [Custom domains](domains.md) and
  [Domain routing](domain-routing.md).

## Redis Client (API)

The Redis client is registered as a Fastify plugin and available on every request via `app.redis`.

**File:** `apps/api/src/config/redis.ts`

```ts
// Access Redis from any route handler
app.get("/example", async (request, reply) => {
  await app.redis.set("key", "value");
  const value = await app.redis.get("key");
  return { value };
});
```

**Configuration:**
- Uses `ioredis` with `maxRetriesPerRequest: null` (required by BullMQ)
- Lazy connect — doesn't block startup if Redis is temporarily unavailable
- Graceful disconnect on server shutdown

## BullMQ Queues (API)

Background job queues are registered as a Fastify plugin and available via `app.queues`.

**File:** `apps/api/src/config/queue.ts`

### Current Queues

| Queue Name | Worker | Purpose |
|------------|--------|---------|
| Build queue | Yes | Nixpacks/Docker build + deploy jobs, one per push or manual trigger — see [Nixpacks build integration](build-system.md) |
| Backup queue | Yes | Scheduled (daily, cron-configurable) and manual backup snapshots — see [Backup system](backup-system.md) |
| Cleanup queue | Yes | Scheduled and manual Docker image/container pruning — see [Docker cleanup](docker-cleanup.md) |
| Metrics queue | Yes | 60-second resource-usage snapshots — see [Monitoring](monitoring.md) |

Each is registered the same way the original `test-ping` example queue was — see `apps/api/src/modules/{build,backups,cleanup,monitoring}/routes.ts` for the current call sites.

### Adding a New Queue

1. Open `apps/api/src/config/queue.ts`
2. Inside `queuePlugin`, create a new queue and worker:

```ts
const deployQueue = createQueue("deploy");
queues.set("deploy", deployQueue);

const deployWorker = createWorker(
  "deploy",
  async (job) => {
    // Process deployment job
    app.log.info({ jobId: job.id, data: job.data }, "Processing deployment");
  },
  app,
);
workers.push(deployWorker);
```

3. Enqueue a job from any route:

```ts
app.post("/deploy", async (request, reply) => {
  const queue = app.queues.get("deploy");
  await queue?.add("start-deploy", { projectId: "abc123" });
  return { status: "queued" };
});
```

## Environment Variables

`DATABASE_URL` and `REDIS_URL` are the two this doc originally covered; every other infrastructure
service (MySQL, mail, webmail, firewall helper, DNS nameservers, ...) has its own env vars in the
same schema now — see [API Setup](api-setup.md#environment-variables) or
`apps/api/src/config/env.ts` directly for the current full list.

## How to Extend

- **Add a Docker service:** Add to `docker-compose.yml`, include health check and persistent volume
- **Add a Traefik route:** Create a YAML file in `docker/traefik/dynamic/`
- **Add a BullMQ queue:** Follow the pattern in `queue.ts` — create queue + worker, add to maps
- **Use Redis for caching:** Use `app.redis.set/get` with TTL via `app.redis.setex(key, ttl, value)`
