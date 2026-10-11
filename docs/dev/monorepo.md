# Monorepo Setup — Developer Guide

## What This Feature Does

Vexlyx is a Turborepo monorepo with pnpm workspaces. The scaffold set up three TypeScript
packages — `apps/dashboard` (frontend), `apps/api` (backend), and `packages/shared` (shared
schemas and types) — with tooling (TypeScript, ESLint, Prettier) shared at the root. Two more
top-level trees sit alongside the workspace packages: `system/` (the Python layer that shells out
to Docker/Postfix/Dovecot/UFW — see each feature's own doc for its `system/python/*.py` script)
and `docker/` (Compose service configs and per-service Dockerfiles — see
[Infrastructure](infrastructure.md)).

---

## Architecture

### Repository Layout

```
vexlyx/
├── apps/
│   ├── dashboard/          # @vexlyx/dashboard — Next.js 15 App Router frontend
│   │   ├── src/app/        # (panel) and (standalone) route groups
│   │   ├── src/components/ # One directory per feature area, plus components/ui (shadcn)
│   │   ├── src/hooks/      # One data-fetching/mutation hook per feature area
│   │   ├── package.json
│   │   └── tsconfig.json   # Extends root, references shared
│   └── api/                 # @vexlyx/api — Fastify 5 backend
│       ├── src/modules/    # One directory per feature (routes/service/schema.ts) — see API Setup
│       ├── src/config/     # env.ts (Zod-validated config), redis.ts, queue.ts
│       ├── src/plugins/    # Fastify plugins: auth, prisma, redis, error-handler, socket.io
│       ├── prisma/         # schema.prisma, migrations/, seed.ts, create-admin.ts
│       ├── package.json
│       └── tsconfig.json   # Extends root, references shared
├── packages/
│   └── shared/              # @vexlyx/shared — Zod schemas + types, see Shared Package
│       ├── src/schemas/    # One file per feature area
│       ├── src/types/
│       ├── package.json
│       └── tsconfig.json   # Extends root, composite: true
├── system/
│   ├── python/              # docker_manager.py, postfix_manager.py, dovecot_manager.py, etc.
│   ├── templates/           # docker-compose service templates per project runtime
│   └── scripts/install/     # The one-line installer (see Installer reference)
├── docker/                  # Per-service configs: traefik/, postfix/, dovecot/, coredns/, php-fpm/, ufw-helper/
├── tests/                   # Python test suites (tests/test_*.py), one per system-layer feature
├── package.json             # Root — devDependencies + turbo scripts
├── pnpm-workspace.yaml      # Declares apps/* and packages/*
├── turbo.json                # Build pipeline configuration
├── tsconfig.json             # Base TypeScript config (strict mode)
├── eslint.config.mjs         # Shared ESLint flat config
└── .prettierrc                # Shared Prettier config
```

### Dependency Graph

```
@vexlyx/dashboard ──► @vexlyx/shared
@vexlyx/api ────────► @vexlyx/shared
```

Both `apps/dashboard` and `apps/api` depend on `packages/shared` via `workspace:*`. Turborepo ensures `shared` builds before either app.

### Turborepo Pipeline

| Task | Depends On | Cached | Persistent |
|------|-----------|--------|------------|
| `build` | `^build` (shared first) | ✅ Yes | No |
| `dev` | `^build` (shared first) | ❌ No | ✅ Yes |
| `lint` | Nothing | ✅ Yes | No |
| `typecheck` | `^build` (shared first) | ✅ Yes | No |
| `test` | `build` | ✅ Yes | No |
| `clean` | Nothing | ❌ No | No |

The `^build` dependency means the `shared` package always compiles before `dashboard` and `api`, ensuring TypeScript project references resolve correctly.

---

## How to Test

```bash
# Install all dependencies across all workspaces
pnpm install

# Build all packages (shared → api + dashboard)
pnpm build

# Run ESLint across all workspaces
pnpm lint

# TypeScript strict mode check
pnpm typecheck

# Start all apps in watch mode
pnpm dev

# Format all files with Prettier
pnpm format
```

---

## How to Extend

### Adding a New Package

1. Create a directory under `packages/` (e.g., `packages/utils/`)
2. Add a `package.json` with name `@vexlyx/utils`
3. Add a `tsconfig.json` that extends `../../tsconfig.json`
4. Set `composite: true` in tsconfig if other packages will reference it
5. Run `pnpm install` to register the new workspace

### Adding a New App

1. Create a directory under `apps/` (e.g., `apps/worker/`)
2. Add a `package.json` with name `@vexlyx/worker`
3. Add a `tsconfig.json` that extends `../../tsconfig.json`
4. Add `@vexlyx/shared` as a dependency: `"@vexlyx/shared": "workspace:*"`
5. Add TypeScript reference: `"references": [{ "path": "../../packages/shared" }]`
6. Run `pnpm install`

### Adding a Workspace Dependency

To make `apps/api` depend on a new package:

```bash
# From the root
pnpm add @vexlyx/utils --filter @vexlyx/api --workspace
```

Or manually add to `apps/api/package.json`:
```json
"dependencies": {
  "@vexlyx/utils": "workspace:*"
}
```

---

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| pnpm over npm/yarn | Strict dependency resolution, fast installs, disk-efficient via hard links |
| Turborepo over Nx | Simpler config, zero-config caching, better for smaller teams |
| Shared root tooling | One ESLint + Prettier config to maintain, not three |
| TypeScript project references | Faster incremental builds, correct cross-package type checking |
| `composite: true` on shared | Required for TypeScript project references to work |
| `verbatimModuleSyntax` | Enforces explicit `import type` for type-only imports |
| `bundler` module resolution | Compatible with both Next.js and node-based bundlers |

---

## Troubleshooting

### `Cannot find module '@vexlyx/shared'`

Run `pnpm build` first. The shared package must compile to `dist/` before other packages can import from it.

### `ERR_PNPM_IGNORED_BUILDS`

Run `pnpm approve-builds <package>` to allow postinstall scripts for native dependencies like esbuild.

### Turbo cache issues

Clear the Turborepo cache:
```bash
# Remove turbo cache
rm -rf .turbo
# Or on Windows
rmdir /s /q .turbo
```
