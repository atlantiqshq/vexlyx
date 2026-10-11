import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

async function buildApp(findUser: () => Promise<unknown>) {
  const { authRoutes } = await import("./routes.js");
  const app = Fastify();
  app.decorate("prisma", {
    user: { findUnique: vi.fn(findUser) },
    passwordResetToken: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async () => undefined),
      findUnique: vi.fn(async () => null),
    },
  } as never);
  app.decorate("redis", { get: vi.fn(async () => null), set: vi.fn(async () => "OK"), del: vi.fn() } as never);
  app.decorate("requireAuth", vi.fn() as never);
  await app.register(authRoutes, { prefix: "/api/auth" });
  return app;
}

describe("POST /api/auth/forgot-password", () => {
  it("answers identically for a known and an unknown email", async () => {
    const known = await buildApp(async () => ({ id: "u1", email: "ada@example.com", name: "Ada", role: "USER" }));
    const unknown = await buildApp(async () => null);

    const a = await known.inject({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "ada@example.com" } });
    const b = await unknown.inject({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "nobody@example.com" } });

    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(a.json()).toEqual(b.json());
  }, 30_000);

  it("still answers 202 when the lookup fails, so errors can't reveal anything", async () => {
    const app = await buildApp(async () => {
      throw new Error("db down");
    });
    const res = await app.inject({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "ada@example.com" } });
    expect(res.statusCode).toBe(202);
  }, 30_000);

  it("rejects a malformed email", async () => {
    const app = await buildApp(async () => null);
    const res = await app.inject({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "nope" } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  }, 30_000);

  it("rate limits the sixth request in the window with 429", async () => {
    const app = await buildApp(async () => null);
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({ method: "POST", url: "/api/auth/forgot-password", payload: { email: "a@example.com" } });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  }, 30_000);
});

describe("POST /api/auth/reset-password", () => {
  it("rejects an unknown token with INVALID_RESET_TOKEN", async () => {
    const app = await buildApp(async () => null);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { token: "a".repeat(64), newPassword: "a-brand-new-password" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_RESET_TOKEN");
  }, 30_000);
});
