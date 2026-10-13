import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { PrismaClient, Role } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
vi.mock("../../config/queue.js", () => ({
  createQueue: () => ({ upsertJobScheduler: vi.fn().mockResolvedValue({}) }),
  createWorker: () => ({}),
}));
vi.mock("../../plugins/socket.js", () => ({ getIO: () => ({ on: vi.fn() }) }));
const { authSessionPlugin } = await import("../../plugins/auth.js");
const { errorHandlerPlugin } = await import("../../plugins/error-handler.js");
const { MonitoringService } = await import("./service.js");
const { monitoringRoutes } = await import("./routes.js");

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

async function fixture(role: Role | null = "ADMIN", expired = false) {
  const findUnique = vi.fn().mockResolvedValue(role ? { role } : null);
  const metrics = {
    server: vi.spyOn(MonitoringService.prototype, "getServerMetrics").mockResolvedValue({ cpuPercent: 42 } as never),
    containers: vi.spyOn(MonitoringService.prototype, "getContainerMetrics").mockResolvedValue([{ name: "private-container" }] as never),
    history: vi.spyOn(MonitoringService.prototype, "getHistory").mockResolvedValue([{ cpuPercent: 42 }] as never),
  };
  const app = Fastify();
  apps.push(app);
  await app.register(fp(async (instance) => {
    instance.decorate("prisma", { user: { findUnique } } as unknown as PrismaClient);
  }, { name: "prisma" }));
  await app.register(fp(async (instance) => {
    instance.decorate("redis", { get: vi.fn().mockResolvedValue(JSON.stringify({ userId: "u1", expiresAt: expired ? 0 : Date.now() + 60_000 })), del: vi.fn() } as never);
  }, { name: "redis" }));
  await app.register(errorHandlerPlugin);
  await app.register(authSessionPlugin);
  app.decorate("registerQueue", vi.fn<FastifyInstance["registerQueue"]>());
  await app.register(monitoringRoutes, { prefix: "/api/monitoring" });
  return { app, metrics, findUnique };
}

const endpoints = ["server", "containers", "history"] as const;
beforeAll(async () => {
  const { app } = await fixture();
  await app.ready();
  await app.close();
  apps.length = 0;
  vi.restoreAllMocks();
}, 30_000);
const cookie = { vexlyx_session: "test-session" };
function expectNoCollection(metrics: Awaited<ReturnType<typeof fixture>>["metrics"]) {
  for (const method of Object.values(metrics)) expect(method).not.toHaveBeenCalled();
}

describe("admin-only monitoring routes", () => {
  for (const endpoint of endpoints) {
    it.each(["USER", "RESELLER", null] as const)(`denies ${endpoint} to %s before collection`, async (role) => {
      const { app, metrics } = await fixture(role);
      const response = await app.inject({ url: `/api/monitoring/${endpoint}?role=ADMIN`, cookies: cookie });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "FORBIDDEN_ROLE" });
      expectNoCollection(metrics);
    });

    it(`denies anonymous ${endpoint} access before collection`, async () => {
      const { app, metrics } = await fixture();
      expect((await app.inject(`/api/monitoring/${endpoint}`)).statusCode).toBe(401);
      expectNoCollection(metrics);
    });

    it(`allows current administrators to read ${endpoint}`, async () => {
      const { app, metrics } = await fixture();
      const response = await app.inject({ url: `/api/monitoring/${endpoint}`, cookies: cookie });
      expect(response.statusCode).toBe(200);
      expect(metrics[endpoint]).toHaveBeenCalledTimes(1);
      if (endpoint === "history") expect(response.json()).toMatchObject({ range: "24h", snapshots: [{ cpuPercent: 42 }] });
      if (endpoint === "containers") expect(response.json()).toEqual({ containers: [{ name: "private-container" }] });
      if (endpoint === "server") expect(response.json()).toEqual({ cpuPercent: 42 });
    });

    it(`rejects expired sessions for ${endpoint}`, async () => {
      const { app, metrics } = await fixture("ADMIN", true);
      expect((await app.inject({ url: `/api/monitoring/${endpoint}`, cookies: cookie })).statusCode).toBe(401);
      expectNoCollection(metrics);
    });

    it(`rechecks demoted administrators on ${endpoint}`, async () => {
      const { app, metrics, findUnique } = await fixture();
      const options = { url: `/api/monitoring/${endpoint}`, cookies: cookie };
      expect((await app.inject(options)).statusCode).toBe(200);
      findUnique.mockResolvedValue({ role: "USER" });
      expect((await app.inject(options)).statusCode).toBe(403);
      expect(metrics[endpoint]).toHaveBeenCalledTimes(1);
    });
  }

  it("fails closed when the role lookup fails", async () => {
    const { app, metrics, findUnique } = await fixture();
    findUnique.mockRejectedValue(new Error("database unavailable"));
    expect((await app.inject({ url: "/api/monitoring/server", cookies: cookie })).statusCode).toBe(500);
    expectNoCollection(metrics);
  });
});
