# Database Provisioning (MySQL & PostgreSQL)

## What This Does

Feature **F2.6** implements isolated, on-demand database provisioning for **PostgreSQL 16** and **MySQL 8.0** within Vexlyx. Users can create, manage, connect to, and delete databases and database users directly from the dashboard. Credentials are encrypted at rest with AES-256-GCM, auto-injected into project environment variables, and integrated with **Adminer** for web-based GUI management.

---

## Architecture & Data Flow

```
┌────────────────────────────────────────────────────────┐
│                   Next.js Dashboard                    │
│   • /databases page                                    │
│   • /projects/[id] DatabasePanel                       │
└───────────────────────────┬────────────────────────────┘
                            │ (JSON / HTTP with Auth)
                            ▼
┌────────────────────────────────────────────────────────┐
│                    Fastify Backend                     │
│   • POST /api/databases (create & encrypt)             │
│   • GET  /api/databases (list & format URIs)           │
│   • GET  /api/databases/:id (view decrypted credentials)│
│   • POST /api/databases/:id/test (test connection)     │
│   • DELETE /api/databases/:id (drop & cleanup)         │
└─────────────┬───────────────────────────┬──────────────┘
              │                           │
  (Prisma ORM │ AES-256-GCM)              │ child_process.spawn
              ▼                           ▼
┌───────────────────────────┐   ┌────────────────────────────┐
│      PostgreSQL DB        │   │  database_manager.py       │
│  (stores user, databases, │   │  (Python system daemon)    │
│   and encrypted passwords)│   └──────────────┬─────────────┘
└───────────────────────────┘                  │
                                               │ docker exec
                     ┌─────────────────────────┴─────────────────────────┐
                     ▼                                                   ▼
       ┌───────────────────────────┐                       ┌───────────────────────────┐
       │      vexlyx-postgres      │                       │        vexlyx-mysql       │
       │  (PostgreSQL 16 engine)   │                       │     (MySQL 8.0 engine)    │
       │  • CREATE USER & DB       │                       │  • CREATE DATABASE & USER │
       │  • SCHEMA grants          │                       │  • Scoped GRANT ALL ON db │
       │  • Terminate connections  │                       │  • Drop database & user   │
       └───────────────────────────┘                       └───────────────────────────┘
```

---

## Security Model

1. **User Isolation**:
   - Every database user is generated with a scoped username `u_<dbname>_<hex>` and unique high-entropy 24-character password.
   - User privileges are restricted strictly to their own database (PostgreSQL: `GRANT ALL ON DATABASE` + `SCHEMA public`; MySQL: `GRANT ALL ON \`<dbname>\`.*`).
   - Cross-database access is prohibited by engine-level access control.

2. **Encryption at Rest**:
   - Passwords are encrypted before storing in PostgreSQL with **AES-256-GCM** using `apps/api/src/utils/encryption.ts`.
   - Secret key is derived from `ENCRYPTION_KEY` or `SESSION_SECRET` via SHA-256.

3. **SQL Injection Prevention**:
   - Identifiers (`dbName`, `dbUser`) are strictly validated against `^[a-zA-Z0-9_]{1,63}$`.
   - Passwords in SQL commands are escaped and parameterized.

---

## Connection Strings & URIs

For every provisioned database, Vexlyx generates two types of connection URIs:

1. **Internal Docker URI** (for hosted project containers on `traefik-net`):
   - PostgreSQL: `postgresql://u_app_1234:password@vexlyx-postgres:5432/app_production`
   - MySQL: `mysql://u_app_1234:password@vexlyx-mysql:3306/app_production`

2. **Host-Accessible URI** (for local development, DBeaver, DataGrip, TablePlus):
   - PostgreSQL: `postgresql://u_app_1234:password@localhost:5432/app_production`
   - MySQL: `mysql://u_app_1234:password@localhost:3306/app_production`

3. **Adminer Web GUI**:
   - Development defaults to a pre-filled deep link at `http://localhost:8088`.
   - Production is disabled by default, matching the Compose `debug` profile. The dashboard hides database-specific actions and shows the page-level action as unavailable.
   - To enable production access, set `ADMINER_URL` to a protected HTTPS endpoint. The API rejects HTTP and localhost production values. Put Adminer behind authentication and network/IP restrictions; Adminer itself provides direct database access.

---

## Environment Variable Auto-Injection

When a database is linked to a project with `autoInjectEnv = true`, the following variables are automatically encrypted and inserted into the project's environment variables:

| Variable       | Description             | Example                                             |
| -------------- | ----------------------- | --------------------------------------------------- |
| `DATABASE_URL` | Internal connection URI | `postgresql://u_app:pw@vexlyx-postgres:5432/app_db` |
| `DB_TYPE`      | Database engine type    | `POSTGRESQL` or `MYSQL`                             |
| `DB_HOST`      | Internal Docker host    | `vexlyx-postgres` or `vexlyx-mysql`                 |
| `DB_PORT`      | Port number             | `5432` or `3306`                                    |
| `DB_NAME`      | Database name           | `app_db`                                            |
| `DB_USER`      | Scoped username         | `u_app_9a2f`                                        |
| `DB_PASSWORD`  | Plaintext password      | `••••••••••••••••••••••••`                          |

---

## API Endpoints

### 1. List Databases

```http
GET /api/databases?projectId=cm123&type=POSTGRESQL&search=app&page=1&limit=20
```

### 2. Provision Database

```http
POST /api/databases
Content-Type: application/json

{
  "name": "ecommerce_prod",
  "type": "POSTGRESQL",
  "projectId": "cm123456",
  "autoInjectEnv": true
}
```

### 3. Get Database & Credentials

```http
GET /api/databases/:id
```

### 4. Test Connectivity

```http
POST /api/databases/:id/test
```

### 5. Drop Database & User

```http
DELETE /api/databases/:id
```

---

## How to Test

Run the automated Python test suite covering validation, PostgreSQL lifecycle, and MySQL lifecycle:

```bash
python tests/test_database_provisioning.py
```

Expected output:

```
=================================================================
Running Vexlyx Database Provisioning Test Suite (F2.6)
=================================================================
Testing identifier validation & SQL injection prevention...
  [PASS] SQL injection patterns and invalid identifiers rejected successfully

Testing PostgreSQL provisioning lifecycle...
  [PASS] Created PostgreSQL database 'test_vex_pg_2184' with owner 'u_test_2184'
  [PASS] Verified active PostgreSQL connection (157.29ms latency)
  [PASS] Dropped database 'test_vex_pg_2184' and cleaned up user 'u_test_2184'

Testing MySQL provisioning lifecycle...
  [PASS] Created MySQL database 'test_vex_my_2186' and user 'u_my_2186' with scoped privileges
  [PASS] Verified active MySQL connection (177.64ms latency)
  [PASS] Dropped MySQL database 'test_vex_my_2186' and removed user 'u_my_2186'

=================================================================
ALL DATABASE PROVISIONING TESTS COMPLETED SUCCESSFULLY!
=================================================================
```

---

## File Structure Reference

```
vexlyx/
├── system/
│   └── python/
│       └── database_manager.py        # System layer DB lifecycle daemon
├── packages/
│   └── shared/
│       └── src/
│           ├── schemas/
│           │   └── databases.ts       # Shared Zod schemas & types
│           └── index.ts
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── config/
│   │   │   │   └── env.ts             # DB engine environment configs
│   │   │   ├── modules/
│   │   │   │   └── databases/
│   │   │   │       ├── schema.ts      # Fastify request schemas
│   │   │   │       ├── service.ts     # Business logic & encryption
│   │   │   │       └── routes.ts      # API routes
│   │   │   └── index.ts               # Registered /api/databases
│   └── dashboard/
│       └── src/
│           ├── app/
│           │   └── (panel)/
│           │       ├── databases/
│           │       │   └── page.tsx   # Standalone /databases management page
│           │       └── projects/
│           │           └── [id]/
│           │               └── page.tsx
│           └── components/
│               └── projects/
│                   └── DatabasePanel.tsx # Embedded project DB panel
├── tests/
│   └── test_database_provisioning.py  # Automated test suite
└── docker-compose.yml                 # MySQL 8.0 & Adminer services
```
