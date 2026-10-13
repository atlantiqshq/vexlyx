# Authentication System

> **Feature:** F0.6 — Authentication System  
> **Status:** 🟢 COMPLETED  
> **Date:** 2026-08-29

## What It Does

Complete session-based authentication for Vexlyx. Users can register (email/password), log in, log out, and access protected panel pages. Passwords are hashed with Argon2id. Sessions are stored in Redis for fast lookup and PostgreSQL for audit/admin invalidation. HTTP-only cookies prevent XSS. Rate limiting protects against brute-force attacks.

### Login timing and account enumeration

Login always awaits one Argon2 verification: the stored password hash for an
existing account, or a precomputed dummy Argon2id hash for a missing account.
Both credential failures return the same 401 response (`INVALID_CREDENTIALS`),
and missing accounts remain rejected even if dummy verification reports a match.
The dummy hash was generated from random input that was discarded; it is never
an account credential.

The dummy matches current password creation defaults: Argon2id v19, 64 MiB
memory, 3 iterations, parallelism 4, a 16-byte salt and a 32-byte digest. A
regression test compares it with a password produced by `AuthService.register`.
When password parameters change, regenerate the dummy with the new settings.
This removes the missing-account verification shortcut; database/network jitter
and legacy hashes with different costs can still affect observed response times.

`pnpm --filter @vexlyx/api test` covers awaited verification, both credential
failures, successful login, 2FA, rate limiting and parameter drift. After building
the API and shared package, `pnpm --filter @vexlyx/api test:login-browser` runs
Chrome/Chromium checks against disposable PostgreSQL and Redis containers. Set
`VEXLYX_PLAYWRIGHT_MODULE` to a Playwright module path if needed and
`VEXLYX_BROWSER_EXECUTABLE` to an installed browser executable. It checks browser
HTTP responses and session cookies, without changing the dashboard UI. Timing
samples are diagnostic, not pass/fail thresholds.

The runner binds random service ports to loopback, overrides database/Redis
settings, avoids `.env`, and removes its containers and volumes on completion.
Deploy by rebuilding and restarting the API; no migration or configuration
change is required.

## Architecture

### Auth Flow

```
Register/Login → Argon2id verify → Create session (Redis + DB) → Set HTTP-only cookie
    ↓
Every request → Read cookie → Lookup session in Redis → Populate request.userId
    ↓
Protected routes → requireAuth preHandler → 401 if no session
    ↓
Logout → Delete session (Redis + DB) → Clear cookie
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Custom auth over Lucia** | Lucia Auth deprecated March 2025. Built our own following Lucia's patterns. |
| **Argon2id** | OWASP-recommended, resistant to side-channel and GPU attacks |
| **Redis + PostgreSQL dual storage** | Redis for speed (every-request lookup), PostgreSQL for audit trail and admin session management |
| **HTTP-only cookies** | Prevents XSS from reading session tokens. No JWT in localStorage. |
| **SameSite=Lax** | CSRF protection without dedicated token mechanism |
| **Auto-promote first user** | First registered user becomes ADMIN. Production uses `ALLOW_REGISTRATION=false` |
| **Scoped rate limiting** | Only auth endpoints (5/15min/IP), not global, so other APIs aren't affected |

### File Structure

```
apps/api/src/
├── config/
│   └── env.ts                    # SESSION_SECRET, ALLOW_REGISTRATION
├── modules/auth/
│   ├── schema.ts                 # Zod: RegisterSchema, LoginSchema
│   ├── service.ts                # AuthService: register, login, getCurrentUser
│   └── routes.ts                 # POST register/login/logout, GET me
├── plugins/
│   └── auth.ts                   # Session plugin + createSession/destroySession
└── index.ts                      # Registers auth plugin + rate-limited routes

apps/dashboard/src/
├── app/(auth)/
│   ├── layout.tsx                # Centered card layout (no sidebar)
│   ├── login/page.tsx            # Login page
│   └── register/page.tsx         # Register page
├── app/(panel)/
│   └── layout.tsx                # Auth guard (validates session server-side)
├── components/auth/
│   ├── LoginForm.tsx             # Email + password form
│   └── RegisterForm.tsx          # Name + email + password + confirm form
├── hooks/
│   └── useAuth.ts                # Auth state + login/register/logout
└── lib/
    └── api.ts                    # fetchAPI with credentials + error handling
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/register` | No | Create user, start session |
| `POST` | `/api/auth/login` | No | Validate credentials, start session |
| `POST` | `/api/auth/logout` | No | Destroy session, clear cookie |
| `GET` | `/api/auth/me` | Yes | Return current user |

### Rate Limiting

Auth endpoints are rate-limited to **5 requests per 15 minutes per IP**. Exceeding returns `429 Too Many Requests`.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SESSION_SECRET` | Yes | — | 32+ char secret for session signing |
| `ALLOW_REGISTRATION` | No | `true` | Enable/disable public registration |

## How to Test

```bash
# 1. Start Docker services
docker-compose up -d

# 2. Run migration (already applied)
cd apps/api && pnpm db:migrate

# 3. Start dev servers
pnpm dev

# 4. Test register
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","email":"test@example.com","password":"password123","confirmPassword":"password123"}'

# 5. Test login (use -c to save cookies)
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}' \
  -c cookies.txt

# 6. Test me (use -b to send cookies)
curl http://localhost:5000/api/auth/me -b cookies.txt

# 7. Test logout
curl -X POST http://localhost:5000/api/auth/logout -b cookies.txt

# 8. Verify session destroyed
curl http://localhost:5000/api/auth/me -b cookies.txt
# Should return 401

# 9. Visit http://localhost:3000/dashboard without auth
# Should redirect to /login

# 10. Check Redis sessions
docker exec -it vexlyx-redis redis-cli keys "session:*"
```

## How to Extend

### Adding OAuth providers
1. Create `apps/api/src/modules/auth/oauth.ts`
2. Add OAuth routes (e.g., `GET /api/auth/github`, `GET /api/auth/github/callback`)
3. Use the same `createSession()` helper after OAuth verification

### Adding password reset
1. Create `POST /api/auth/forgot-password` — generates reset token, sends email
2. Create `POST /api/auth/reset-password` — validates token, updates password
3. Store tokens in Redis with short TTL (15 minutes)

### Admin session management
Query PostgreSQL `sessions` table to see all active sessions, revoke by deleting from both DB and Redis.

### Disabling registration in production
Set `ALLOW_REGISTRATION=false` in `.env`. Admin creates users manually via a future admin API.
