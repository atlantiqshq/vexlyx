# Node build preflight

Issue #35 adds validation before Nixpacks image setup. Repository checks run before `nixpacks plan`; toolchain checks use the generated plan before `nixpacks build` starts Docker. Direct image builds repeat validation so callers cannot bypass it.

`system/python/node_preflight.py` owns package-manager resolution and configuration checks. Both framework helpers use that resolver. `packageManager` takes precedence over lockfiles. Multiple manager lockfiles without a declaration fail with `CONFLICTING_LOCKFILES`; a declaration resolves the selection and emits a warning about stale lockfiles. Lockfiles belonging to the same manager are not treated as competing managers.

The YAML parser uses a safe loader, bounds configuration size and aliases, and preserves YAML 1.2 string semantics for workspace names such as `on`. Validation never rewrites Node project files. Custom Dockerfiles bypass these Nixpacks-specific checks.

## Version compatibility

Workspace rules depend on the effective pnpm version. Before pnpm 10.5.0, a non-empty workspace configuration needs a `packages` field. pnpm 10.5.0+ permits a configuration-only workspace without that field. An explicit empty array is valid and retains pnpm's root-package behavior. When present, `packages` must contain only non-empty strings. Monorepo globs pass through unchanged.

The setup package alone does not establish the effective package-manager version: Corepack can provision the declared version. Preflight checks the effective install phase, including explicit overrides. Nixpacks 1.41 generates Corepack 0.24.1, which cannot launch pnpm 11's ESM entry point. This combination fails early with `PACKAGE_MANAGER_VERSION_UNSUPPORTED`. Corepack 0.34.5 supports that entry point; pnpm 11.24.0 also requires Node 22.13+. These facts were verified with isolated Node 22 containers, including a successful pnpm 11.24.0 launch using Corepack 0.34.5.

Vexlyx preserves Nixpacks' Node install phase. It passes `--install-cmd` only for an explicit Node install override. Existing Python install handling remains unchanged. An opaque custom installation script produces an unverified-toolchain warning because preflight cannot establish what that script provisions. Floating versions and unpinned manager versions also produce explicit warnings rather than claims of exact compatibility.

An explicit per-deployment override can be sent to `POST /api/projects/:id/build`:

```json
{
  "installCmd": "npm install -g corepack@0.34.5 && corepack enable && pnpm install --frozen-lockfile"
}
```

The override is optional, validated, and retained through the queue and Python payload. It is not a persistent project setting. Configure a compatible Node runtime in the source manifest or use a Dockerfile for a fully controlled toolchain.

## Diagnostics and runtime installation

Python errors include `error`, `code`, and `details` with the affected file and remediation. The worker stores a structured `[vexlyx:failure]` record in the existing deployment logs; no database migration is required. Deployment responses expose a parsed `failure` field, and the dashboard displays it even with logs collapsed. Legacy deployments remain readable. Final status writes await pending log writes so an older snapshot cannot overwrite the diagnostic.

Install the pinned parser using `python -m pip install -r system/python/requirements-build.txt`. The installer installs it on the host; the API runtime image also includes the same PyYAML version. Existing installations must rebuild the API runtime image when upgrading to this change.

## Verification

```sh
python -m pip install -r system/python/requirements-build.txt
python -m unittest discover -s system/python -p 'test_build_preflight.py' -v
NIXPACKS_INTEGRATION=1 python -m unittest discover -s system/python -p 'test_build_preflight.py' -v
pnpm --filter @vexlyx/api exec vitest run src/modules/build/service.test.ts
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The integration option requires Nixpacks 1.41 in PATH. Unit coverage includes invalid JSON/YAML, workspace variants, declaration precedence, lockfile conflicts, manager/version mismatches, Corepack compatibility, script requirements, overrides, and Dockerfile bypass. Service tests cover persistence, polling, live diagnostics, fragmented output, trailing-newline handling, and owner-only access.

Browser verification uses the actual `BuildPanel` with isolated HTTP and Socket.io fixture responses. Check that a failed deployment shows the code, file, and remediation without expanding logs; logs still expand; old failures and successful deployments still render; and a queued deployment transitions to a visible failure with Deploy enabled again. Temporary fixture routes and servers are removed after verification.

The issue validation run passed 28 Python tests (including real Nixpacks plans), eight build service tests, and the browser checks above. The complete configured JavaScript suites passed 594 tests; 75 existing conditional tests remained skipped. Frozen-lockfile installation, Prisma generation, lint, typecheck, and production build also passed. Existing lint warnings are outside the changed files.
