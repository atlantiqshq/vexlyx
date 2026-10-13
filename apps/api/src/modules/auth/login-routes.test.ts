import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import * as argon2 from "argon2";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
const { authRoutes } = await import("./routes.js");
const { errorHandlerPlugin } = await import("../../plugins/error-handler.js");

const password = "correct-test-password";
let passwordHash: string;
const apps: FastifyInstance[] = [];
beforeAll(async () => { passwordHash = await argon2.hash(password, { type: argon2.argon2id }); }, 30_000);
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function fixture(totpEnabled = false) {
  const user = { id: "u1", email: "ada@example.test", name: "Ada", role: "USER", totpEnabled };
  const prisma = {
    user: { findUnique: vi.fn(async ({ where, select }: { where: { email?: string; id?: string }; select?: unknown }) => {
      if (where.email && where.email !== user.email) return null;
      return select ? user : { ...user, password: passwordHash };
    }) },
    session: { create: vi.fn().mockResolvedValue({}) },
  };
  const redis = { get: vi.fn(), set: vi.fn().mockResolvedValue("OK"), del: vi.fn() };
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  await app.register(errorHandlerPlugin);
  app.decorate("prisma", prisma as never);
  app.decorate("redis", redis as never);
  app.decorate("requireAuth", vi.fn() as never);
  await app.register(authRoutes, { prefix: "/api/auth" });
  return { app, prisma, redis, user };
}

describe("POST /api/auth/login", () => {
  it("returns identical credential errors without sessions for unknown and known accounts", async () => {
    const { app, prisma, redis } = await fixture();
    const responses = [];
    for (const email of ["missing@example.test", "ada@example.test"]) {
      const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "wrong-password" } });
      expect(response.statusCode).toBe(401);
      expect(response.headers["set-cookie"]).toBeUndefined();
      responses.push(response.json());
    }
    expect(responses).toEqual([
      { error: "Invalid email or password", code: "INVALID_CREDENTIALS", details: {} },
      { error: "Invalid email or password", code: "INVALID_CREDENTIALS", details: {} },
    ]);
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  }, 30_000);

  it("creates the same authenticated session on a valid password", async () => {
    const { app, prisma, user } = await fixture();
    const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: user.email, password } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user });
    expect(response.headers["set-cookie"]).toContain("vexlyx_session=");
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(prisma.session.create).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("still requires the second factor after a valid password", async () => {
    const { app, prisma, user } = await fixture(true);
    const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: user.email, password } });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ requires2FA: true, challengeToken: expect.any(String) });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(prisma.session.create).not.toHaveBeenCalled();
  }, 30_000);

  it("continues to rate limit the sixth login attempt", async () => {
    const { app } = await fixture();
    for (let attempt = 1; attempt <= 6; attempt++) {
      const response = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "missing@example.test", password: "wrong-password" } });
      expect(response.statusCode).toBe(attempt === 6 ? 429 : 401);
    }
  }, 30_000);
});
