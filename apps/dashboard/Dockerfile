# Vexlyx Dashboard — production image (F5.1)
# Multi-stage build using `turbo prune` + Next.js standalone output to keep
# the final image small.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# 1. Prune the monorepo down to what @vexlyx/dashboard actually needs
# ---------------------------------------------------------------------------
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@^2 prune @vexlyx/dashboard --docker

# ---------------------------------------------------------------------------
# 2. Install dependencies and build
# ---------------------------------------------------------------------------
FROM base AS builder
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# `turbo prune` only copies the pruned workspaces themselves — it has no
# awareness of TypeScript's `extends`, so the monorepo root tsconfig.json
# (which packages/shared/tsconfig.json extends for its target/lib) never
# makes it into out/full/. Without it, tsc silently falls back to its ES5
# default lib and fails on String.prototype.startsWith/includes etc.
COPY --from=pruner /app/tsconfig.json ./tsconfig.json
# Baked in at build time — Next.js inlines NEXT_PUBLIC_* vars into the client bundle.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ARG NEXT_PUBLIC_MAIL_HOSTNAME
ENV NEXT_PUBLIC_MAIL_HOSTNAME=${NEXT_PUBLIC_MAIL_HOSTNAME}
RUN pnpm exec turbo run build --filter=@vexlyx/dashboard

# ---------------------------------------------------------------------------
# 3. Runtime image — Next.js standalone server only
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S vexlyx && adduser -S vexlyx -G vexlyx

COPY --from=builder /app/apps/dashboard/.next/standalone ./
COPY --from=builder /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder /app/apps/dashboard/public ./apps/dashboard/public

USER vexlyx
EXPOSE 3000

CMD ["node", "apps/dashboard/server.js"]
