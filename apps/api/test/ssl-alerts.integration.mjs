// Runs real auth, routes and Prisma queries against disposable Docker services.
// Never reads a developer's .env or accepts an external database URL.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import * as argon2 from "argon2";

const require = createRequire(import.meta.url);
const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prefix = `vexlyx-ssl-alerts-${randomBytes(6).toString("hex")}`;
const containers = [];
let app;
let browser;
let passed = 0;

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
}

async function startService(suffix, image, port, args, readyCommand) {
  const name = `${prefix}-${suffix}`;
  docker("run", "--rm", "-d", "--name", name, "-p", `127.0.0.1::${port}`, ...args, image);
  containers.push(name);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      docker("exec", name, ...readyCommand);
      const mapping = docker("port", name, `${port}/tcp`);
      assert.match(mapping, /^127\.0\.0\.1:\d+$/);
      return Number(mapping.split(":").at(-1));
    } catch {
      await delay(500);
    }
  }
  throw new Error(`${suffix} did not become ready`);
}

async function check(label, test) {
  await test();
  passed++;
  console.log(`PASS ${label}`);
}

try {
  const dbPassword = randomBytes(24).toString("hex");
  const pgPort = await startService("postgres", "postgres:16-alpine", 5432,
    ["--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_DB=ssl_alerts_test", "-e", `POSTGRES_PASSWORD=${dbPassword}`],
    ["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "ssl_alerts_test"]);
  const redisPort = await startService("redis", "redis:7-alpine", 6379, [], ["redis-cli", "ping"]);

  // Set every relevant value before loading modules that validate environment.
  Object.assign(process.env, {
    DATABASE_URL: `postgresql://postgres:${dbPassword}@127.0.0.1:${pgPort}/ssl_alerts_test`,
    REDIS_URL: `redis://127.0.0.1:${redisPort}`, NODE_ENV: "test",
    SESSION_SECRET: randomBytes(32).toString("hex"), COOKIE_DOMAIN: "",
    DOTENV_CONFIG_PATH: resolve(apiDir, "test", `${prefix}.no-env`),
    ALLOW_REGISTRATION: "false", REQUIRE_ADMIN_2FA: "false",
  });
  delete process.env.COOKIE_DOMAIN;
  execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "db", "push", "--skip-generate"], {
    cwd: apiDir, env: process.env, stdio: "pipe", timeout: 60_000,
  });

  const { databasePlugin } = await import("../dist/config/database.js");
  const { redisClientPlugin } = await import("../dist/config/redis.js");
  const { authSessionPlugin, createSession } = await import("../dist/plugins/auth.js");
  const { errorHandlerPlugin } = await import("../dist/plugins/error-handler.js");
  const { authRoutes } = await import("../dist/modules/auth/routes.js");
  const { domainRoutes } = await import("../dist/modules/domains/routes.js");
  const { dashboardRoutes } = await import("../dist/modules/dashboard/routes.js");
  const { MonitoringService } = await import("../dist/modules/monitoring/service.js");
  // Host metrics are unrelated to authorization; never run host monitoring in this fixture.
  MonitoringService.prototype.getServerMetrics = async () => null;
  app = Fastify();
  await app.register(databasePlugin);
  await app.register(redisClientPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authSessionPlugin);
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(domainRoutes, { prefix: "/api/domains" });
  await app.register(dashboardRoutes, { prefix: "/api/dashboard" });

  const password = randomBytes(24).toString("hex");
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const users = [
    ["admin", "ADMIN", null], ["reseller-a", "RESELLER", null], ["reseller-b", "RESELLER", null],
    ["alice", "USER", "reseller-a"], ["bob", "USER", "reseller-a"], ["foreign", "USER", "reseller-b"],
    ["empty", "USER", null], ["demoted", "ADMIN", null], ["deleted", "USER", null],
  ];
  const soon = new Date(Date.now() + 3.5 * 86_400_000);
  for (const [id, role, resellerId] of users) {
    await app.prisma.user.create({ data: { id, role, resellerId, name: id, email: `${id}@example.test`, password: hash } });
    if (["empty", "deleted"].includes(id)) continue;
    await app.prisma.domain.create({ data: {
      id: `domain-${id}`, hostname: `${id}.example.test`, userId: id,
      certificate: { create: {
        id: `cert-${id}`, commonName: `${id}.example.test`, status: "ACTIVE",
        validTo: id === "bob" ? new Date(Date.now() - 86_400_000) : soon,
      } },
    } });
  }
  await app.prisma.domain.create({ data: {
    id: "domain-healthy", userId: "alice", hostname: "healthy.example.test",
    certificate: { create: { id: "cert-healthy", commonName: "healthy.example.test", status: "ACTIVE", validTo: new Date(Date.now() + 90 * 86_400_000) } },
  } });

  // Seed HTTP client sessions with the production helper; browser tests below
  // additionally exercise password login and the actual Set-Cookie response.
  const cookies = {};
  for (const [id] of users) {
    const sessionId = await createSession(app, { setCookie() {} }, id);
    cookies[id] = `vexlyx_session=${sessionId}`;
  }
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const alertsPath = "/api/domains/ssl/alerts";
  const reset = () => app.prisma.certificate.updateMany({ data: { status: "ACTIVE", lastCheckedAt: null } });
  async function request(path, user) {
    const response = await fetch(`${base}${path}`, {
      headers: user ? { cookie: cookies[user] } : {}, signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() };
  }
  function expectAlerts(body, expected, total = expected.length) {
    assert.deepEqual(body.alerts.map((alert) => alert.domainId).sort(), expected.map((id) => `domain-${id}`).sort());
    assert.equal(body.totalChecked, total);
    assert.equal(body.expired, expected.includes("bob") ? 1 : 0);
    assert.equal(body.expiringSoon, expected.length - body.expired);
    for (const alert of body.alerts) {
      assert.equal(alert.hostname, `${alert.domainId.slice(7)}.example.test`);
      assert.equal(alert.status, alert.domainId === "domain-bob" ? "EXPIRED" : "EXPIRING_SOON");
    }
  }
  async function expectUpdates(expected) {
    const updated = await app.prisma.certificate.findMany({ where: { lastCheckedAt: { not: null } }, select: { id: true } });
    assert.deepEqual(updated.map((cert) => cert.id).sort(), expected.map((id) => `cert-${id}`).sort());
    const untouched = await app.prisma.certificate.count({ where: { lastCheckedAt: null, status: { not: "ACTIVE" } } });
    assert.equal(untouched, 0);
  }
  const all = ["admin", "reseller-a", "reseller-b", "alice", "bob", "foreign", "demoted"];
  const cases = [
    ["alice", ["alice"], 2], ["bob", ["bob"], 1],
    ["reseller-a", ["reseller-a", "alice", "bob"], 4],
    ["reseller-b", ["reseller-b", "foreign"], 2], ["admin", all, 8], ["empty", [], 0],
  ];
  await check("anonymous request is rejected without updates", async () => {
    await reset();
    assert.equal((await request(alertsPath)).status, 401);
    await expectUpdates([]);
  });
  for (const [user, expected, total] of cases) {
    await check(`HTTP ${user}: scoped alerts, counts and writes`, async () => {
      await reset();
      const response = await request(alertsPath, user);
      assert.equal(response.status, 200);
      expectAlerts(response.body, expected, total);
      await expectUpdates(expected);
    });
  }
  await check("forged requester and role parameters cannot widen access", async () => {
    await reset();
    const response = await request(`${alertsPath}?userId=admin&role=ADMIN&ownOnly=false`, "alice");
    assert.equal(response.status, 200);
    expectAlerts(response.body, ["alice"], 2);
    await expectUpdates(["alice"]);
  });
  await check("sub-account reassignment changes reseller visibility immediately", async () => {
    await app.prisma.user.update({ where: { id: "bob" }, data: { resellerId: "reseller-b" } });
    try {
      await reset();
      expectAlerts((await request(alertsPath, "reseller-a")).body, ["reseller-a", "alice"], 3);
      await expectUpdates(["reseller-a", "alice"]);
      await reset();
      expectAlerts((await request(alertsPath, "reseller-b")).body, ["reseller-b", "foreign", "bob"], 3);
      await expectUpdates(["reseller-b", "foreign", "bob"]);
    } finally {
      await app.prisma.user.update({ where: { id: "bob" }, data: { resellerId: "reseller-a" } });
    }
  });
  for (const user of ["alice", "reseller-a", "admin", "empty"]) {
    await check(`HTTP dashboard ${user}: preserves own-domain feed and writes`, async () => {
      await reset();
      const response = await request("/api/dashboard/summary", user);
      assert.equal(response.status, 200);
      const expected = user === "empty" ? [] : [user];
      assert.deepEqual(response.body.activity.filter((item) => item.type === "ssl_alert").map((item) => item.id), expected.map((id) => `ssl-domain-${id}`));
      assert.equal(response.body.sslExpiringCount, expected.length);
      await expectUpdates(expected);
    });
  }
  await check("role demotion applies to the existing session immediately", async () => {
    assert.equal((await request(alertsPath, "demoted")).body.totalChecked, 8);
    await app.prisma.user.update({ where: { id: "demoted" }, data: { role: "USER" } });
    await reset();
    expectAlerts((await request(alertsPath, "demoted")).body, ["demoted"]);
    await expectUpdates(["demoted"]);
  });
  await check("deleted user with stale Redis session fails closed", async () => {
    await app.prisma.user.delete({ where: { id: "deleted" } });
    await reset();
    assert.equal((await request(alertsPath, "deleted")).status, 403);
    await expectUpdates([]);
  });

  if (process.argv.includes("--browser")) {
    const { chromium } = require(process.env.VEXLYX_PLAYWRIGHT_MODULE || "playwright");
    browser = await chromium.launch({ headless: true, ...(process.env.VEXLYX_BROWSER_EXECUTABLE ? { executablePath: process.env.VEXLYX_BROWSER_EXECUTABLE } : {}) });
    for (const [user, expected, total] of cases.filter(([id]) => ["alice", "reseller-a", "admin"].includes(id))) {
      await check(`browser ${user}: real login, cookie, scoped alerts and dashboard`, async () => {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.goto(`${base}/api/auth/config`);
          const loginStatus = await page.evaluate(async ({ user, password }) => {
            const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${user}@example.test`, password }) });
            return response.status;
          }, { user, password });
          assert.equal(loginStatus, 200);
          await reset();
          const response = await page.goto(`${base}${alertsPath}?userId=admin&role=ADMIN`);
          assert.equal(response.status(), 200);
          expectAlerts(await response.json(), expected, total);
          await expectUpdates(expected);
          await reset();
          const summary = await page.evaluate(async () => (await fetch("/api/dashboard/summary")).json());
          assert.equal(summary.sslExpiringCount, 1);
          assert.deepEqual(summary.activity.filter((item) => item.type === "ssl_alert").map((item) => item.id), [`ssl-domain-${user}`]);
          await expectUpdates([user]);
        } finally {
          await context.close();
        }
      });
    }
  }
  console.log(`${passed} security integration checks passed`);
} finally {
  const cleanupErrors = [];
  const closed = await Promise.allSettled([browser?.close(), app?.close()]);
  for (const result of closed) {
    if (result.status === "rejected") cleanupErrors.push(result.reason);
  }
  for (const name of containers.reverse()) {
    try {
      docker("rm", "-f", "-v", name);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Test resource cleanup failed");
}
