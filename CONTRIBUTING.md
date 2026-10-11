# Contributing to Vexlyx

Thanks for considering a contribution. Vexlyx is MIT-licensed and open to pull requests.

## Setup

```bash
git clone https://github.com/atlantiqshq/vexlyx.git
cd vexlyx
corepack enable
pnpm bootstrap   # env files, Docker services, database, seed data
pnpm dev
```

`pnpm bootstrap` is safe to re-run; see the README for what it does and its flags.

Requires Node.js 22+ (pnpm 11 relies on the `node:sqlite` built-in, added in Node 22) and Docker
& Docker Compose for the local infrastructure (Postgres, MySQL, Redis, Traefik, CoreDNS, Postfix,
Dovecot, Roundcube — see [`docs/dev/infrastructure.md`](docs/dev/infrastructure.md)).

## Before you open a PR

```bash
pnpm typecheck   # TypeScript strict mode, all workspaces
pnpm lint        # ESLint, all workspaces
pnpm test        # Vitest (unit/integration) + the Python system-layer test suites under tests/
pnpm build       # Must succeed — this is what CI and Vercel/production builds run
pnpm format      # Prettier, if you haven't been formatting on save
```

All four checks (`typecheck`, `lint`, `test`, `build`) must pass before a PR is reviewed.

## Code conventions

[`CLAUDE.md`](CLAUDE.md) is the project's full conventions document — architecture decisions,
file naming, the API route pattern, styling rules, error handling, and the required test coverage
for a new feature (happy path, error path, auth). Read it before making a non-trivial change; PR
review holds new code to it.

In short:
- Feature code lives in `apps/api/src/modules/<name>/` (`routes.ts` + `service.ts` + `schema.ts`)
  and `apps/dashboard/src/components/<name>/`, following an existing module as a template.
- Validation schemas shared between the API and dashboard go in
  `packages/shared/src/schemas/<name>.ts` — see
  [`docs/dev/shared-package.md`](docs/dev/shared-package.md).
- Anything that needs to touch Docker, Postfix, Dovecot, DNS, or the host firewall goes through a
  `system/python/*.py` script, spawned as a subprocess — routes never call Docker or shell out
  directly.
- Tests live next to the file they test (`foo.ts` → `foo.test.ts`), using Vitest.

## Commit messages

Recent history follows `type(scope): summary` — `type` is `feat`/`fix`/`chore`/`docs`/etc., and
`scope` is either the module touched (`fix(mail): ...`) or, for a tracked feature, its ID from
[`FEATURES.md`](FEATURES.md) (`feat(F5.27): ...`). Not strictly enforced, but appreciated.

## Documentation

If your change affects behavior, update the matching page under `docs/dev/` in the same PR —
that's the single source of truth synced into the public
[docs site](https://docs.vexlyx.atlantiqs.org). A new feature gets a new page there; see any
existing page for the expected shape (what it does, architecture, how to test, how to extend).

## Reviews and merging

`main` is protected by a repository ruleset. A pull request can only be merged when:

- the four CI checks (`lint`, `typecheck`, `test`, `build`) pass;
- it has at least one approving review from a code owner (see [`.github/CODEOWNERS`](.github/CODEOWNERS)), and that approver is not the author or the person who pushed last;
- new commits dismiss earlier approvals, and all review conversations are resolved.

Nobody can push to `main` directly, force-push it or delete it, and the rules apply to admins too. Please don't merge your own pull request.

## CI and releases

Every pull request runs the same four checks in GitHub Actions (`lint`, `typecheck`, `test`, `build`), so run them locally first. Maintainers cut a release by pushing a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

That creates a GitHub release with notes generated from your commit messages (which is why the `type(scope): summary` format above matters) and publishes the dashboard and API Docker images to GHCR. See [`docs/dev/ci-cd.md`](docs/dev/ci-cd.md) for details.

## Reporting bugs / requesting features

Open a GitHub issue. For a bug, include repro steps and what you expected instead. For a security
issue, do **not** open a public issue — see [`SECURITY.md`](/project/security).

## License

By contributing, you agree your contribution is licensed under the project's [MIT license](LICENSE).
