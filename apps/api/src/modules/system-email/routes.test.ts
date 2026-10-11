import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

vi.mock("../../config/queue.js", () => ({
  createQueue: () => ({ add: vi.fn(), name: "system-email" }),
  createWorker: () => ({}),
}));
vi.mock("../mail/service.js", () => ({ runPostfixManager: vi.fn(async () => ({ found: false })) }));

const { systemEmailRoutes } = await import("./routes.js");

/** Builds the app with auth guards that behave like the real ones: 401 when signed out, 403 when not an admin. */
async function buildApp(session: { userId: string | null; role: "ADMIN" | "USER" }) {
  const app = Fastify();
  app.decorate("prisma", { auditLog: { create: vi.fn() }, user: { findUnique: vi.fn() } } as never);
  app.decorate("redis", { get: vi.fn(async () => null), set: vi.fn(), del: vi.fn() } as never);
  app.decorate("registerQueue", vi.fn() as never);
  app.decorate("requireAuth", vi.fn() as never);
  app.decorate(
    "requireRole",
    ((...roles: string[]) =>
      async (_request: FastifyRequest, reply: FastifyReply) => {
        if (!session.userId) {
          return reply.status(401).send({ error: "Authentication required", code: "UNAUTHORIZED", details: {} });
        }
        if (!roles.includes(session.role)) {
          return reply.status(403).send({ error: "Forbidden", code: "FORBIDDEN_ROLE", details: {} });
        }
      }) as never,
  );
  app.decorateRequest("userId", null);
  app.addHook("onRequest", async (request) => {
    request.userId = session.userId;
  });
  await app.register(systemEmailRoutes, { prefix: "/api/system-email" });
  return app as unknown as FastifyInstance;
}

describe("system email routes — authorization", () => {
  it("returns 401 for status and test when signed out", async () => {
    const app = await buildApp({ userId: null, role: "USER" });
    expect((await app.inject({ method: "GET", url: "/api/system-email/status" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/api/system-email/test", payload: { to: "a@example.com" } })).statusCode,
    ).toBe(401);
  });

  it("returns 403 for a non-admin", async () => {
    const app = await buildApp({ userId: "u1", role: "USER" });
    expect((await app.inject({ method: "GET", url: "/api/system-email/status" })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "POST", url: "/api/system-email/test", payload: { to: "a@example.com" } })).statusCode,
    ).toBe(403);
  });

  it("lets an admin read the status", async () => {
    const app = await buildApp({ userId: "u1", role: "ADMIN" });
    const res = await app.inject({ method: "GET", url: "/api/system-email/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, transport: "log" });
  });

  it("sends a test email as an admin and rejects an invalid address", async () => {
    const app = await buildApp({ userId: "u1", role: "ADMIN" });
    const ok = await app.inject({ method: "POST", url: "/api/system-email/test", payload: { to: "a@example.com" } });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: "POST", url: "/api/system-email/test", payload: { to: "not-an-email" } });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
  });
});
