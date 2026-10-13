import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import cors from "@fastify/cors";
import * as argon2 from "argon2";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.VEXLYX_PLAYWRIGHT_MODULE || "playwright");
const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prefix = `vexlyx-monitoring-${randomBytes(6).toString("hex")}`;
const containers = [];
let app, browser;
let passed = 0;

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
}
async function startService(suffix, image, port, args, ready) {
  const name = `${prefix}-${suffix}`;
  docker("run", "--rm", "-d", "--name", name, "-p", `127.0.0.1::${port}`, ...args, image);
  containers.push(name);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      docker("exec", name, ...ready);
      const mapping = docker("port", name, `${port}/tcp`);
      assert.match(mapping, /^127\.0\.0\.1:\d+$/);
      return Number(mapping.split(":").at(-1));
    } catch { await delay(500); }
  }
  throw new Error(`${suffix} did not become ready`);
}
async function check(label, test) { await test(); passed++; console.log(`PASS ${label}`); }

try {
  const dbPassword = randomBytes(24).toString("hex");
  const pgPort = await startService("postgres", "postgres:16-alpine", 5432,
    ["--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_DB=monitoring_test", "-e", `POSTGRES_PASSWORD=${dbPassword}`],
    ["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "monitoring_test"]);
  const redisPort = await startService("redis", "redis:7-alpine", 6379, [], ["redis-cli", "ping"]);
  Object.assign(process.env, {
    DATABASE_URL: `postgresql://postgres:${dbPassword}@127.0.0.1:${pgPort}/monitoring_test`,
    REDIS_URL: `redis://127.0.0.1:${redisPort}`, NODE_ENV: "test", SESSION_SECRET: randomBytes(32).toString("hex"),
    DOTENV_CONFIG_PATH: join(apiDir, "test", `${prefix}.no-env`), ALLOW_REGISTRATION: "false", REQUIRE_ADMIN_2FA: "false",
  });
  delete process.env.COOKIE_DOMAIN;
  execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "db", "push", "--skip-generate"], { cwd: apiDir, env: process.env, stdio: "pipe", timeout: 120_000 });

  const { databasePlugin } = await import("../dist/config/database.js");
  const { redisClientPlugin } = await import("../dist/config/redis.js");
  const { queuePlugin_ } = await import("../dist/config/queue.js");
  const { authSessionPlugin } = await import("../dist/plugins/auth.js");
  const { socketPlugin, getIO } = await import("../dist/plugins/socket.js");
  const { errorHandlerPlugin } = await import("../dist/plugins/error-handler.js");
  const { authRoutes } = await import("../dist/modules/auth/routes.js");
  const { monitoringRoutes } = await import("../dist/modules/monitoring/routes.js");
  const { dashboardRoutes } = await import("../dist/modules/dashboard/routes.js");
  const { MonitoringService } = await import("../dist/modules/monitoring/service.js");
  const { runMetricsCollectorJob } = await import("../dist/modules/monitoring/socket.js");
  const { hasMonitoringAccess } = await import("../dist/modules/monitoring/access.js");
  const metrics = { cpuPercent: 10, cpuCoreCount: 2, cpuPerCore: [10, 10], ramUsed: 200, ramTotal: 1000, ramPercent: 20, diskUsed: 300, diskTotal: 1000, diskPercent: 30, uptimeSeconds: 3600, loadAvg1: 0.1, loadAvg5: 0.2, loadAvg15: 0.3, netRxBytes: 100, netTxBytes: 100 };
  const containerMetrics = [{ containerId: "fixture-container", name: "private-other-tenant", cpuPercent: 1, memUsed: 10, memLimit: 100, memPercent: 10, netRx: 0, netTx: 0, blockRead: 0, blockWrite: 0, status: "running" }];
  // Authorization is real; the native host collector is replaced with synthetic data.
  MonitoringService.prototype.getServerMetrics = async () => ({ ...metrics });
  MonitoringService.prototype.getContainerMetrics = async () => containerMetrics;
  app = Fastify();
  await app.register(cors, { origin: true, credentials: true });
  await app.register(databasePlugin);
  await app.register(redisClientPlugin);
  await app.register(queuePlugin_);
  await app.register(errorHandlerPlugin);
  await app.register(authSessionPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(monitoringRoutes, { prefix: "/api/monitoring" });
  await app.register(dashboardRoutes, { prefix: "/api/dashboard" });
  const io = getIO();
  io.on("connection", (socket) => { socket.on("test:barrier", (ack) => ack()); });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const queue = app.queues.get("metrics-collector");
  await queue.removeJobScheduler("collect-metrics");
  await queue.drain();
  for (let attempt = 0; await queue.getActiveCount(); attempt++) {
    assert.ok(attempt < 60, "fixture collector did not become idle");
    await delay(100);
  }
  const service = new MonitoringService(app.prisma, app.log);
  const collect = () => runMetricsCollectorJob(io, service, app.log, (socket) => hasMonitoringAccess(app.prisma, app.redis, socket.data.userId, socket.data.sessionId));
  const password = randomBytes(24).toString("hex");
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  for (const [id, role] of [["admin", "ADMIN"], ["user", "USER"], ["reseller", "RESELLER"]]) {
    await app.prisma.user.create({ data: { id, role, email: `${id}@example.test`, name: id, password: hash } });
  }
  await service.saveSnapshot(metrics);
  browser = await chromium.launch({ headless: true, ...(process.env.VEXLYX_BROWSER_EXECUTABLE ? { executablePath: process.env.VEXLYX_BROWSER_EXECUTABLE } : {}) });
  const contexts = {};
  const pages = {};
  const request = (page, path) => page.evaluate(async (path) => {
    const response = await fetch(path);
    return { status: response.status, body: await response.json() };
  }, path);
  const login = (page, id) => page.evaluate(async ({ id, password }) => (await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${id}@example.test`, password }) })).status, { id, password });
  const connect = async (page) => {
    if (!await page.evaluate(() => !!window.io)) await page.addScriptTag({ url: `${base}/socket.io/socket.io.js` });
    await page.evaluate((base) => new Promise((resolve, reject) => {
      window.monitoringEvents = [];
      window.monitoringSocket = window.io(base, { transports: ["websocket"], withCredentials: true, reconnection: false, timeout: 10_000 });
      window.monitoringSocket.onAny((event, data) => window.monitoringEvents.push({ event, data }));
      window.monitoringSocket.once("connect", resolve);
      window.monitoringSocket.once("connect_error", (error) => reject(new Error(error.message)));
    }), base);
  };
  const subscribe = (page) => page.evaluate(() => new Promise((resolve) => {
    const done = () => { window.monitoringSocket.off("metrics:server", done); window.monitoringSocket.off("metrics:error", done); resolve(); };
    window.monitoringSocket.once("metrics:server", done);
    window.monitoringSocket.once("metrics:error", done);
    window.monitoringSocket.emit("subscribe:metrics", { role: "ADMIN", userId: "admin", sessionId: "forged" });
  }));
  const barrier = (page) => page.evaluate(() => new Promise((resolve) => window.monitoringSocket.emit("test:barrier", resolve)));
  const clearEvents = (page) => page.evaluate(() => { window.monitoringEvents = []; });
  const expectNoMetrics = async (page) => {
    await barrier(page);
    const events = await page.evaluate(() => window.monitoringEvents);
    assert.deepEqual(events.filter(({ event }) => ["metrics:server", "metrics:containers", "alert:threshold"].includes(event)), []);
  };
  await check("anonymous REST and socket access are denied", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${base}/api/auth/config`);
    for (const path of ["server", "containers", "history"]) assert.equal((await request(page, `/api/monitoring/${path}`)).status, 401);
    await assert.rejects(connect(page), /UNAUTHORIZED/);
    await context.close();
  });
  for (const id of ["user", "reseller", "admin"]) {
    const context = contexts[id] = await browser.newContext();
    const page = pages[id] = await context.newPage();
    await page.goto(`${base}/api/auth/config`);
    assert.equal(await login(page, id), 200);
    await connect(page);
    await check(`${id}: REST, dashboard and live metrics enforce the current role`, async () => {
      for (const path of ["server", "containers", "history"]) {
        const response = await request(page, `/api/monitoring/${path}`);
        assert.equal(response.status, id === "admin" ? 200 : 403);
        if (id === "admin" && path === "containers") assert.deepEqual(response.body.containers, containerMetrics);
        if (id === "admin" && path === "history") assert.ok(response.body.snapshots.length > 0);
      }
      const summary = await request(page, "/api/dashboard/summary");
      assert.equal(summary.status, 200);
      assert.deepEqual(summary.body.serverMetrics, id === "admin" ? metrics : null);
      await subscribe(page);
      if (id !== "admin") {
        await collect();
        await expectNoMetrics(page);
        assert.equal(await page.evaluate(() => window.monitoringSocket.connected), true);
      } else {
        await clearEvents(page);
        metrics.cpuPercent = 95;
        await collect();
        await barrier(page);
        const events = await page.evaluate(() => window.monitoringEvents);
        assert.ok(events.some(({ event }) => event === "metrics:server"));
        assert.ok(events.some(({ event }) => event === "alert:threshold"));
      }
    });
  }

  const admin = pages.admin;
  const session = (await contexts.admin.cookies()).find((cookie) => cookie.name === "vexlyx_session").value;
  const sessionKey = `session:${session}`;
  const rawSession = await app.redis.get(sessionKey);
  const expectRevoked = async () => {
    await collect();
    await expectNoMetrics(admin);
    const events = await admin.evaluate(() => window.monitoringEvents);
    assert.ok(events.some(({ event }) => event === "metrics:error"));
  };
  await check("connected admin loses metrics and alerts immediately after demotion", async () => {
    await clearEvents(admin);
    await app.prisma.user.update({ where: { id: "admin" }, data: { role: "USER" } });
    await expectRevoked();
    assert.equal((await request(admin, "/api/monitoring/server")).status, 403);
    assert.equal((await request(admin, "/api/dashboard/summary")).body.serverMetrics, null);
    await app.prisma.user.update({ where: { id: "admin" }, data: { role: "ADMIN" } });
  });
  for (const reason of ["expired", "revoked"]) {
    await check(`connected admin loses access with a ${reason} session`, async () => {
      await subscribe(admin);
      await clearEvents(admin);
      if (reason === "expired") await app.redis.set(sessionKey, JSON.stringify({ ...JSON.parse(rawSession), expiresAt: 0 }));
      else await app.redis.del(sessionKey);
      await expectRevoked();
      assert.equal((await request(admin, "/api/monitoring/server")).status, 401);
      await app.redis.set(sessionKey, rawSession);
    });
  }
  await check("logout revokes metrics on an already connected socket", async () => {
    await subscribe(admin);
    await clearEvents(admin);
    assert.equal(await admin.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST" })).status), 200);
    await expectRevoked();
    await admin.evaluate(() => window.monitoringSocket.disconnect());
    assert.equal(await login(admin, "admin"), 200);
    await connect(admin);
  });
  await check("account deletion denies metrics despite a stale Redis session", async () => {
    await subscribe(admin);
    await clearEvents(admin);
    await app.prisma.user.delete({ where: { id: "admin" } });
    await expectRevoked();
    assert.equal((await request(admin, "/api/monitoring/server")).status, 403);
  });
  console.log(`${passed} monitoring browser checks passed`);
} finally {
  const errors = [];
  for (const close of [() => browser?.close(), () => app?.close()]) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  for (const name of containers.reverse()) {
    try { docker("rm", "-f", "-v", name); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Test resource cleanup failed");
}
