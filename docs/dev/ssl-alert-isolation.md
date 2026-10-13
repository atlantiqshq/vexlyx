# SSL expiry alert authorization

`GET /api/domains/ssl/alerts` requires an authenticated session. The API loads
the requester's current role from PostgreSQL on each request and applies this
scope to the certificate query:

| Role | Visible certificates |
| --- | --- |
| USER | Domains owned by that account |
| RESELLER | Their own domains and domains owned by accounts whose `resellerId` points to them |
| ADMIN | All domains |

The same scope controls `totalChecked`, `expiringSoon`, `expired`, the alert
list, and certificate status refreshes. Identity and role query parameters are
ignored. A missing account with a stale session receives 403; an unauthenticated
request receives 401. Role changes take effect on the next request.

`SslService.checkExpiryAlerts` requires a requester ID; there is no implicit
global scan. The dashboard passes `{ ownOnly: true }` to keep its existing
own-domain activity feed for every role. Other domain endpoints keep their
existing authorization rules.

Deploy by rebuilding and restarting the API. No schema migration or environment
variable changes are required. Previously disclosed information cannot be
retracted; this change prevents subsequent cross-tenant responses.

## Verification

- Unit/route regressions: `pnpm --filter @vexlyx/api test`.
- Real PostgreSQL/Redis integration: build the API and shared package, then run
  `pnpm --filter @vexlyx/api test:ssl-alerts`. Docker must be available.
- Browser verification: run the same command with `--browser`. Playwright must
  be available via `VEXLYX_PLAYWRIGHT_MODULE` (or installed locally), with either
  its Chromium browser installed or `VEXLYX_BROWSER_EXECUTABLE` pointing to Chrome.

The integration runner creates disposable containers with loopback-only,
random host ports and random credentials. It overrides database/Redis settings,
never loads `.env`, and removes its containers and volumes when finished. Real
authentication, Prisma queries, role changes, alert counts, and status writes
are exercised; host monitoring is stubbed. Optional browser checks perform real
password logins, use session cookies, navigate to the alert endpoint, and check
the dashboard summary for USER, RESELLER, and ADMIN accounts.

The `ssl-alerts-isolation` CI job runs the database integration checks. Unit
regressions remain part of the standard test job.
