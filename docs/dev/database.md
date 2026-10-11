# Database — Prisma Schema & PostgreSQL

## What This Does

Vexlyx uses **Prisma ORM** with **PostgreSQL 16** for all database operations. The schema has grown from its original 8 models/7 enums (see the table below for the current count — this doc is kept in sync as the schema grows, unlike some of its Foundation siblings) to cover every entity in the hosting control panel: users and roles, projects and deployments, domains/DNS/SSL, mail, backups, firewall rules, and the audit log. PostgreSQL runs locally via Docker Compose.

## Architecture

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   Fastify Route  │────▶│  app.prisma.*    │────▶│   PostgreSQL 16  │
│  (route handler) │     │  (Prisma Client) │     │  (Docker)        │
└──────────────────┘     └──────────────────┘     └──────────────────┘
```

- **Prisma Client** is registered as a Fastify plugin (`app.prisma`)
- All routes access the database through `app.prisma`
- Connection is established on server start, disconnected on shutdown
- Queries are logged in development, only errors in production

## Schema Overview

24 models, 18 enums as of this writing (`apps/api/prisma/schema.prisma` is always the exact source
of truth — grep it for `^model ` / `^enum ` for the current count).

### Models

| Area | Models | Purpose |
|---|---|---|
| Users & access | `User`, `Session` | Panel accounts (ADMIN/RESELLER/USER, quotas, permissions — see [Roles & permissions](roles-permissions.md)); server-side session rows |
| Projects & deploys | `Project`, `Deployment`, `EnvVar` | Hosted apps, one row per build/deploy attempt, encrypted env vars |
| Domains, DNS & SSL | `Domain`, `DnsRecord`, `Certificate` | Custom domains (connect or hosted DNS mode — see [Domains](domains.md)), zone records, TLS certificates |
| Databases & files | `Database`, `SftpUser` | User-provisioned MySQL/PostgreSQL instances, SFTP accounts |
| Mail | `Mailbox`, `VirtualAlias`, `DkimKey`, `VacationResponder` | Mailboxes, forwarding/catch-all aliases, DKIM keys, auto-responders — see [Email](/guide/email) |
| Operations | `MetricSnapshot`, `BackupSnapshot`, `BackupSettings`, `CleanupSettings`, `CleanupRun`, `FirewallRule`, `FirewallSettings`, `SystemSettings` | Resource-usage history, backup runs/schedule, disk cleanup runs/schedule, firewall rules/policy, misc panel settings |
| Audit | `AuditLog` | Who changed what — see [Audit log](audit-log.md) |

### Enums

The original 7 are unchanged; notable additions since:

| Enum | Values |
|------|--------|
| `Role` | ADMIN, USER, **RESELLER** (added in [Roles & permissions](roles-permissions.md)) |
| `Permission` | canManageDns, canManageFirewall, canManageBackups, canCreateSubAccounts (see [Fine-grained permissions](fine-grained-permissions.md)) |
| `ProjectType` | NODEJS, NEXTJS, PYTHON, REACT, STATIC, PHP, WORDPRESS, DOCKER |
| `ProjectStatus` | CREATING, ACTIVE, STOPPED, ERROR, DELETED |
| `DeploymentStatus` | QUEUED, BUILDING, DEPLOYING, RUNNING, FAILED, CANCELLED |
| `DomainStatus` | PENDING, ACTIVE, ERROR |
| `DnsMode` | CONNECTED, MANAGED (see [DNS management](dns-management.md)) |
| `DatabaseType` | POSTGRESQL, MYSQL |
| `MailboxStatus` | ACTIVE, SUSPENDED, DELETED |
| `CertType` / `CertStatus` | LETS_ENCRYPT/CUSTOM/SELF_SIGNED — PENDING/ACTIVE/EXPIRING_SOON/EXPIRED/ERROR |
| `BackupStatus` / `BackupTrigger` | see [Backup system](backup-system.md) |
| `CleanupStatus` / `CleanupTrigger` | see [Docker cleanup](docker-cleanup.md) |
| `FirewallProtocol` / `FirewallAction` / `FirewallPolicy` | see [Firewall](firewall.md) |

### Key Relations

- `User` → has many Projects, Domains, Databases, Mailboxes
- `Project` → belongs to User, has many Deployments, EnvVars, Domains, Databases
- `Domain` → belongs to User, optionally linked to Project, has many DnsRecords, Mailboxes
- All child records cascade-delete when their parent is deleted

### Unique Constraints

- `User.email` — globally unique
- `Project [userId, name]` — project names unique per user
- `EnvVar [projectId, key]` — env var keys unique per project
- `Domain.hostname` — globally unique
- `Database [userId, name]` — database names unique per user
- `Mailbox.address` — globally unique

## Common Commands

Run from `apps/api/`:

```bash
# Generate Prisma Client after schema changes
pnpm db:generate

# Create and apply a new migration
pnpm db:migrate

# Push schema to DB without creating a migration file (prototyping)
pnpm db:push

# Seed the database with development data
pnpm db:seed

# Open Prisma Studio (visual DB browser)
pnpm db:studio

# Reset DB: drop all data, re-apply migrations, re-seed
pnpm db:reset
```

## Migration Workflow

### Adding a New Model

1. Edit `prisma/schema.prisma` — add the new model with `@@map("table_name")`
2. Run `pnpm db:migrate` — Prisma creates a migration SQL file
3. Name the migration descriptively: `add_ssl_certificates_table`
4. Run `pnpm db:generate` — regenerate the client with new types
5. Use `app.prisma.newModel.findMany()` etc. in service layer

### Modifying an Existing Model

1. Edit the model in `schema.prisma`
2. Run `pnpm db:migrate`
3. If migration fails due to data constraints, edit the generated SQL or use `pnpm db:push` for prototyping

## Querying Patterns

```ts
// In a Fastify route handler:
app.get("/", async (request, reply) => {
  const projects = await app.prisma.project.findMany({
    where: { userId: request.user.id },
    include: { deployments: { take: 1, orderBy: { createdAt: "desc" } } },
  });
  return { projects };
});
```

Always use the service layer for complex queries — routes should only call service methods.

## How to Test

1. Start PostgreSQL: `docker-compose up -d postgres`
2. Apply migrations: `cd apps/api && pnpm db:migrate`
3. Seed data: `pnpm db:seed`
4. Open Prisma Studio: `pnpm db:studio`
5. Verify the `users` table contains the admin user

## How to Extend

- **New model:** Add to `schema.prisma`, migrate, generate client
- **New enum:** Add to `schema.prisma` enums section, migrate
- **New relation:** Add fields to both sides of the relation, migrate
- **Indexes:** Add `@@index([field])` for frequently queried columns

## Important Decisions

| Decision | Rationale |
|----------|-----------|
| `cuid()` IDs | URL-safe, sortable, no collision risk across distributed systems |
| Snake-case DB columns | PostgreSQL convention via `@map()`, while keeping camelCase in TypeScript |
| Cascade deletes | Simplifies cleanup — deleting a User removes all their Projects, Domains, etc. |
| Per-user unique project names | Users can have projects with the same name as other users |
| Separate Deployment model | Tracks every deploy attempt, not just current state |
| `EnvVar.value` is AES-256-GCM ciphertext | Encrypted at rest since [F1.7](environment-variables.md); the database never holds a plaintext secret |
