// Disposable real-session browser verification. Production services are never used.
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
const { chromium } = require(process.env.VEXLYX_PLAYWRIGHT_MODULE || "playwright");
const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prefix = `vexlyx-login-timing-${randomBytes(6).toString("hex")}`;
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
    ["--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_DB=login_timing_test", "-e", `POSTGRES_PASSWORD=${dbPassword}`],
    ["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "login_timing_test"]);
  const redisPort = await startService("redis", "redis:7-alpine", 6379, [], ["redis-cli", "ping"]);
  Object.assign(process.env, {
    DATABASE_URL: `postgresql://postgres:${dbPassword}@127.0.0.1:${pgPort}/login_timing_test`,
    REDIS_URL: `redis://127.0.0.1:${redisPort}`, NODE_ENV: "test",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    DOTENV_CONFIG_PATH: resolve(apiDir, "test", `${prefix}.no-env`),
    ALLOW_REGISTRATION: "false", REQUIRE_ADMIN_2FA: "false",
  });
  delete process.env.COOKIE_DOMAIN;
  execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), "db", "push", "--skip-generate"], {
    cwd: apiDir, env: process.env, stdio: "pipe", timeout: 60_000,
  });

  const { databasePlugin } = await import("../dist/config/database.js");
  const { redisClientPlugin } = await import("../dist/config/redis.js");
  const { authSessionPlugin } = await import("../dist/plugins/auth.js");
  const { errorHandlerPlugin } = await import("../dist/plugins/error-handler.js");
  const { authRoutes } = await import("../dist/modules/auth/routes.js");
  const { AuthService } = await import("../dist/modules/auth/service.js");
  app = Fastify();
  await app.register(databasePlugin);
  await app.register(redisClientPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authSessionPlugin);
  await app.register(authRoutes, { prefix: "/api/auth" });

  const password = randomBytes(24).toString("hex");
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  for (const [id, totpEnabled] of [["alice", false], ["second-factor", true]]) {
    await app.prisma.user.create({ data: { id, email: `${id}@example.test`, name: id, password: passwordHash, totpEnabled } });
  }
  const base = await app.listen({ host: "127.0.0.1", port: 0 });

  // Timing samples are diagnostic only; deterministic service tests enforce
  // awaited verification without making noisy wall-clock measurements a gate.
  const service = new AuthService(app.prisma);
  const samples = { known: [], unknown: [] };
  for (let i = 0; i < 8; i++) {
    const order = i % 2 ? ["unknown", "known"] : ["known", "unknown"];
    for (const kind of order) {
      const start = performance.now();
      await assert.rejects(service.login({ email: kind === "known" ? "alice@example.test" : "missing@example.test", password: "incorrect-password" }), { code: "INVALID_CREDENTIALS", statusCode: 401 });
      if (i >= 2) samples[kind].push(performance.now() - start);
    }
  }
  const median = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    return ((sorted[2] + sorted[3]) / 2).toFixed(1);
  };
  console.log(`Diagnostic only (6 warmed samples each): known=${median(samples.known)}ms, unknown=${median(samples.unknown)}ms`);

  browser = await chromium.launch({ headless: true, ...(process.env.VEXLYX_BROWSER_EXECUTABLE ? { executablePath: process.env.VEXLYX_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/api/auth/config`);
  const login = (email, submittedPassword) => page.evaluate(async ({ email, submittedPassword }) => {
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: submittedPassword }) });
    return { status: response.status, body: await response.json() };
  }, { email, submittedPassword });
  const me = () => page.evaluate(async () => {
    const response = await fetch("/api/auth/me");
    return { status: response.status, body: await response.json() };
  });
  const expectNoSession = async () => {
    assert.equal((await context.cookies()).filter((cookie) => cookie.name === "vexlyx_session").length, 0);
    assert.equal(await app.prisma.session.count(), 0);
    assert.equal((await app.redis.keys("session:*")).length, 0);
  };

  await check("browser: unknown and known failures have identical errors and no sessions", async () => {
    assert.equal((await me()).status, 401);
    const unknown = await login("missing@example.test", "incorrect-password");
    const known = await login("alice@example.test", "incorrect-password");
    assert.deepEqual(unknown, known);
    assert.deepEqual(known, { status: 401, body: { error: "Invalid email or password", code: "INVALID_CREDENTIALS", details: {} } });
    await expectNoSession();
  });
  await check("browser: valid login authenticates with an HttpOnly cookie and logout revokes it", async () => {
    const response = await login("alice@example.test", password);
    assert.equal(response.status, 200);
    assert.equal(response.body.user.id, "alice");
    assert.equal("password" in response.body.user, false);
    const cookie = (await context.cookies()).find((item) => item.name === "vexlyx_session");
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "Lax");
    assert.equal((await me()).body.user.id, "alice");
    assert.equal(await app.prisma.session.count(), 1);
    assert.equal(await app.redis.exists(`session:${cookie.value}`), 1);
    assert.equal(await page.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST" })).status), 200);
    assert.equal((await me()).status, 401);
    await expectNoSession();
  });
  await check("browser: correct password for a 2FA account produces a challenge without a session", async () => {
    const response = await login("second-factor@example.test", password);
    assert.equal(response.status, 202);
    assert.equal(response.body.requires2FA, true);
    assert.match(response.body.challengeToken, /^[0-9a-f]{64}$/);
    assert.equal(JSON.parse(await app.redis.get(`2fa-challenge:${response.body.challengeToken}`)).userId, "second-factor");
    await expectNoSession();
  });
  await check("browser: sixth login attempt is rate limited", async () => {
    assert.equal((await login("missing@example.test", "incorrect-password")).status, 401);
    assert.equal((await login("missing@example.test", "incorrect-password")).status, 429);
    await expectNoSession();
  });
  await context.close();
  console.log(`${passed} real-session browser checks passed`);
} finally {
  const cleanupErrors = [];
  const closed = await Promise.allSettled([browser?.close(), app?.close()]);
  for (const result of closed) {
    if (result.status === "rejected") cleanupErrors.push(result.reason);
  }
  for (const name of containers.reverse()) {
    try { docker("rm", "-f", "-v", name); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Test resource cleanup failed");
}
