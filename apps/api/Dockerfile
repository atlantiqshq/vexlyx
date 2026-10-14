# Vexlyx API — production runtime image (F5.1)
#
# Unlike a typical Node service, the API does not run standalone: every
# deploy/build/mail/DNS/SSL/database feature works by spawning
# `system/python/*.py` as a child process, which in turn shells out to the
# HOST's `docker` CLI (docker_manager.py runs `docker compose up -d` for each
# user project, postfix_manager.py runs `docker exec vexlyx-postfix ...`,
# etc. — see CLAUDE.md section 6, "Use Python daemon" instead of touching
# Docker from routes directly). That coupling means this image intentionally
# does NOT bake in application code: it only provides the runtime toolchain
# (Node, Python + cryptography, git, Nixpacks, and a Docker CLI talking to
# the host daemon over the bind-mounted socket — "Docker-outside-of-Docker").
# The actual /opt/vexlyx checkout — already `pnpm install`'d, `pnpm build`'t,
# and `prisma generate`'d on the host by the installer — is bind-mounted in
# at runtime at the SAME absolute path on both sides, so relative path
# lookups inside build_manager.py/docker_manager.py/ssl_manager.py (which
# resolve paths like `system/templates/docker-compose` or
# `docker/traefik/certs` relative to their own script location or cwd) find
# the exact same files the host sees, and any docker-compose.yml this
# process generates for a user project is readable by the host daemon too.
# See docker-compose.prod.yml for the bind mounts and docs/dev/installer.md
# for the full rationale.

FROM node:22-bookworm-slim

RUN apt-get update -y && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    git \
    openssh-client \
    curl \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# The API spawns Python as literally `python` (not `python3`) on several call
# sites (apps/api/src/modules/{build,deploy,wordpress,dockerfile,databases}/
# service.ts) — Debian ships no `python` binary by default, so those spawns
# fail with ENOENT without this. Mirrors the same symlink
# system/scripts/install/steps/04-runtime.sh creates on the host.
RUN ln -sf /usr/bin/python3 /usr/local/bin/python

# Docker CLI + the `docker compose`/`docker buildx` v2 plugins — client only,
# talking to the HOST's daemon over the bind-mounted socket (no dockerd in
# this image). docker-buildx-plugin is required because modern Docker
# daemons default `docker build` to BuildKit, which Nixpacks' build step
# (build_manager.py) invokes — without it: "BuildKit is enabled but the
# buildx component is missing or broken". Installed from Docker's official
# apt repo (the same one system/scripts/install/steps/03-docker.sh adds on
# the host) so the binaries land at their standard Debian paths instead of
# guessing at another base image's layout.
RUN install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update -y \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# cryptography (ssl_manager.py) — installed into the system interpreter;
# this container is disposable, so PEP 668's "externally managed" guard is
# not a concern here.
RUN pip3 install --break-system-packages --no-cache-dir cryptography PyYAML==6.0.3

# Nixpacks — required by build_manager.py to build user projects.
RUN curl -fsSL https://nixpacks.com/install.sh | bash

RUN corepack enable

WORKDIR /opt/vexlyx/apps/api
ENV NODE_ENV=production
EXPOSE 5000

# `prisma migrate deploy` is a safe no-op when the schema is already current,
# so it's re-applied on every boot rather than only once at install time.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/index.js"]
