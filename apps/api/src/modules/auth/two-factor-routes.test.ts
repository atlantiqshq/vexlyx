import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { authenticator } from "otplib";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

describe("POST /api/auth/2fa/challenge rate limit + shape", () => {
  it("rejects unknown challenge with 401 2FA_INVALID_CODE", async () => {
    const { authRoutes } = await import("./routes.js");
    const app = Fastify();
    app.decorate("prisma", { user: { findUnique: vi.fn() } } as unknown as import("fastify").FastifyInstance["prisma"]);
    app.decorate("redis", { get: vi.fn(async () => null), set: vi.fn(), del: vi.fn() } as unknown as import("fastify").FastifyInstance["redis"]);
    app.decorate("requireAuth", vi.fn() as unknown as import("fastify").FastifyInstance["requireAuth"]);
    await app.register(authRoutes, { prefix: "/api/auth" });
    const res = await app.inject({ method: "POST", url: "/api/auth/2fa/challenge", payload: { challengeToken: "x".repeat(64), code: "123456" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("2FA_INVALID_CODE");
  }, 30_000);

  it("survives a typo: wrong code 401, same token + right code succeeds", async () => {
    const { authRoutes } = await import("./routes.js");
    const { encrypt } = await import("../../utils/encryption.js");
    const secret = authenticator.generateSecret();
    const store = new Map<string, string>();
    const app = Fastify();
    await app.register(cookie);
    app.decorate("prisma", {
      user: { findUnique: vi.fn(async () => ({ id: "u1", email: "u1@example.com", totpEnabled: true, totpSecretEncrypted: encrypt(secret) })) },
      session: { create: vi.fn(async () => undefined) },
      recoveryCode: { findMany: vi.fn(async () => []) },
    } as unknown as import("fastify").FastifyInstance["prisma"]);
    app.decorate("redis", {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => { store.set(k, v); return "OK"; }),
      del: vi.fn(async (k: string) => { store.delete(k); }),
    } as unknown as import("fastify").FastifyInstance["redis"]);
    app.decorate("requireAuth", vi.fn() as unknown as import("fastify").FastifyInstance["requireAuth"]);
    await app.register(authRoutes, { prefix: "/api/auth" });

    const token = "t".repeat(64);
    store.set("2fa-challenge:" + token, JSON.stringify({ userId: "u1" }));

    const wrong = await app.inject({ method: "POST", url: "/api/auth/2fa/challenge", payload: { challengeToken: token, code: "000000" } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe("2FA_INVALID_CODE");

    const right = await app.inject({ method: "POST", url: "/api/auth/2fa/challenge", payload: { challengeToken: token, code: authenticator.generate(secret) } });
    expect(right.statusCode).toBe(200);
    expect(right.json().user.id).toBe("u1");
  }, 30_000);
});
