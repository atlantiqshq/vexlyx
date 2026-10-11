# F2.7 — GitHub Webhook Auto-Deploy

## What This Feature Does

Automatically redeploys projects whenever new code is pushed to connected GitHub repositories. It provides cryptographically verified webhook ingestion via HMAC-SHA256 signatures, branch filtering, automated BullMQ job dispatching, and live commit metadata display in the dashboard.

This page documents the legacy per-project webhook used by manually connected repositories. GitHub App projects use the panel-wide `/api/webhooks/github-app` endpoint and require no manual webhook setup; see [GitHub Integration](github-integration.md).

---

## Architecture

```
GitHub Push / Ping Event
       │
       │  POST /api/webhooks/github?projectId=:id
       │  POST /api/webhooks/github/:projectId
       │  Headers: x-github-event, x-hub-signature-256
       ▼
Fastify Webhook Routes (apps/api/src/modules/webhooks/routes.ts)
       │ (Preserves raw body buffer for HMAC integrity)
       ▼
Webhook Service (apps/api/src/modules/webhooks/service.ts)
       ├── verifySignature()  — HMAC-SHA256 with crypto.timingSafeEqual
       ├── Handle "ping"      — Returns 200 OK pong
       ├── Handle "push"      — Matches ref against project.branch
       │                        ├─ Mismatch: 200 OK (ignored)
       │                        └─ Match: Creates Deployment (QUEUED) with commitHash & commitMsg
       ▼
BullMQ Build Queue (build-queue)
       │
       ▼
Build Worker (apps/api/src/modules/build/service.ts)
       ├── Git Sync: pulls latest commits via git_manager.py
       ├── Detection: runs nixpacks plan
       ├── Build: runs nixpacks build
       └── Deploy: launches container via docker_manager.py
```

---

## Security & Verification

1. **HMAC-SHA256 Signature Verification**:
   - Every GitHub webhook request includes an `x-hub-signature-256` header containing `sha256=<hex_digest>`.
   - The API computes the expected signature over the exact incoming raw payload buffer using the project's secret:
     ```ts
     const computedHash = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
     ```
   - Signatures are compared using constant-time `crypto.timingSafeEqual` to eliminate timing attack vectors.
   - Any signature mismatch or missing signature immediately returns `401 Unauthorized`.

2. **Branch Isolation**:
   - The webhook parses the `ref` field (e.g. `refs/heads/main`).
   - If the pushed branch differs from the project's configured deployment branch (e.g. `main`), the request is acknowledged with `200 OK` and `{ ignored: true, reason: "Branch mismatch" }` without queuing unwanted builds.

3. **Secret Rotation**:
   - Project owners can rotate/regenerate their HMAC secret at any time via `POST /api/projects/:id/git/webhook-secret/rotate` or the Dashboard UI.

---

## Key Files

| File | Role |
| :--- | :--- |
| [`packages/shared/src/schemas/webhooks.ts`](../../packages/shared/src/schemas/webhooks.ts) | Zod schemas and TypeScript types for GitHub push/ping events and webhook responses |
| [`apps/api/src/modules/webhooks/schema.ts`](../../apps/api/src/modules/webhooks/schema.ts) | Fastify request validation schemas |
| [`apps/api/src/modules/webhooks/service.ts`](../../apps/api/src/modules/webhooks/service.ts) | `WebhookService` class: HMAC verification, branch filtering, deployment record creation |
| [`apps/api/src/modules/webhooks/routes.ts`](../../apps/api/src/modules/webhooks/routes.ts) | Webhook endpoints with custom raw body content parser |
| [`apps/api/src/modules/git/routes.ts`](../../apps/api/src/modules/git/routes.ts) | Added `POST /api/projects/:id/git/webhook-secret/rotate` route |
| [`apps/api/src/modules/git/service.ts`](../../apps/api/src/modules/git/service.ts) | Added `rotateWebhookSecret()` and exposed `webhookSecret` in metadata |
| [`apps/api/src/modules/build/service.ts`](../../apps/api/src/modules/build/service.ts) | Automated `git_manager.py` sync before Nixpacks build |
| [`apps/dashboard/src/hooks/useGitSettings.ts`](../../apps/dashboard/src/hooks/useGitSettings.ts) | Added `rotateWebhookSecret()` mutate action |
| [`apps/dashboard/src/components/projects/GitSettings.tsx`](../../apps/dashboard/src/components/projects/GitSettings.tsx) | Enhanced Webhook UI: URL & Secret display, reveal toggle, copy buttons, regenerate action, setup guide |
| [`apps/dashboard/src/components/projects/BuildPanel.tsx`](../../apps/dashboard/src/components/projects/BuildPanel.tsx) | `DeploymentRow` with Git commit badge and commit message |
| [`tests/test_github_webhooks.py`](../../tests/test_github_webhooks.py) | Automated test suite for signature verification, tamper detection, and endpoint behavior |

---

## How to Test

### 1. Run Automated Tests
```bash
python -m unittest tests/test_github_webhooks.py -v
```

### 2. Manual Verification via curl

Simulate a GitHub `ping` event:
```bash
SECRET="<PROJECT_WEBHOOK_SECRET>"
PAYLOAD='{"zen":"Keep it logically awesome."}'
SIG="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

curl -X POST "http://localhost:5000/api/webhooks/github?projectId=<PROJECT_ID>" \
  -H "Content-Type: application/json" \
  -H "x-github-event: ping" \
  -H "x-hub-signature-256: $SIG" \
  -d "$PAYLOAD"
```

Simulate a GitHub `push` event:
```bash
PAYLOAD='{"ref":"refs/heads/main","after":"a1b2c3d4e5f6","head_commit":{"id":"a1b2c3d4e5f6","message":"feat: new release"}}'
SIG="sha256=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

curl -X POST "http://localhost:5000/api/webhooks/github?projectId=<PROJECT_ID>" \
  -H "Content-Type: application/json" \
  -H "x-github-event: push" \
  -H "x-hub-signature-256: $SIG" \
  -d "$PAYLOAD"
```

---

## Extending This Feature

- **GitLab Webhooks**: Add `POST /api/webhooks/gitlab` validating the `X-Gitlab-Token` header.
- **Bitbucket / Gitea**: Add vendor-specific signature parsers in `WebhookService`.
- **Pull Request Previews**: In future phases, listen for `x-github-event: pull_request` to deploy ephemeral preview subdomains and containers.
