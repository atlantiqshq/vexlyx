# Vexlyx

**Open-source hybrid hosting control panel.**

Deploy modern apps (Next.js, Node.js, Python, React, static, WordPress) and manage traditional hosting services (email, DNS, domains, databases) — all from a single server.

## Production Install

On a fresh Ubuntu 24.04 server:

```bash
VEXLYX_DOMAIN=panel.yourdomain.com curl -fsSL https://vexlyx.atlantiqs.org/install.sh | bash
```

Installs Docker, Node.js, Python, and Nixpacks; brings up Postgres, Redis, Traefik (with a real Let's Encrypt certificate), CoreDNS, Postfix/Dovecot, and the panel itself; creates the admin user; and configures UFW. Safe to re-run at any time. See [docs/dev/installer.md](./docs/dev/installer.md) for how it works.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v22+ (pnpm 11 requires Node's `node:sqlite` built-in, added in 22)
- [pnpm](https://pnpm.io/) v9+
- [Docker](https://www.docker.com/) & Docker Compose
- [Git](https://git-scm.com/)

### Setup

```bash
# Clone the repo
git clone https://github.com/atlantiqshq/vexlyx.git
cd vexlyx

# Install dependencies
pnpm install

# Start development
pnpm dev
```

### Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all apps in parallel (watch mode) |
| `pnpm build` | Build all packages |
| `pnpm lint` | Run ESLint across all packages |
| `pnpm typecheck` | TypeScript strict mode check |
| `pnpm test` | Run all tests |
| `pnpm format` | Format all files with Prettier |
| `pnpm clean` | Remove all build artifacts |

## Project Structure

```
vexlyx/
├── apps/
│   ├── dashboard/          # Next.js 15 frontend
│   └── api/                # Fastify backend
├── packages/
│   └── shared/             # Shared Zod schemas + TypeScript types
├── docs/
│   └── dev/                # Developer documentation
├── turbo.json              # Turborepo pipeline config
├── pnpm-workspace.yaml     # pnpm workspace config
├── tsconfig.json           # Root TypeScript config
├── eslint.config.mjs       # Shared ESLint config
├── .prettierrc             # Prettier config
├── CLAUDE.md               # AI developer guide
├── FEATURES.md             # Feature tracking & roadmap
└── DEV.md                  # Vibe coding workflow guide
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15, Tailwind CSS 4, shadcn/ui |
| Backend | Fastify, Prisma, BullMQ |
| Shared | Zod, TypeScript |
| Infrastructure | Docker, Traefik, Redis |
| Build | Turborepo, Nixpacks |

## Documentation

- **[CLAUDE.md](./CLAUDE.md)** — Project conventions for AI assistants
- **[FEATURES.md](./FEATURES.md)** — Complete feature roadmap with status tracking
- **[DEV.md](./DEV.md)** — Guide for vibe coding with AI
- **[docs/dev/](./docs/dev/)** — Per-feature developer documentation

## License

[MIT](./LICENSE)
