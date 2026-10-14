import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const notifyUser = vi.fn();
vi.mock("../system-email/notifier.js", () => ({ notifyUser: (...args: unknown[]) => notifyUser(...args) }));

const { env } = await import("../../config/env.js");
const { userRoutes } = await import("./routes.js");
const { errorHandlerPlugin } = await import("../../plugins/error-handler.js");

type Role = "ADMIN" | "RESELLER" | "USER";
interface Row {
  id: string;
  email: string;
  name: string;
  role: Role;
  resellerId: string | null;
}

const USERS: Row[] = [
  { id: "admin1", email: "admin1@example.com", name: "Admin One", role: "ADMIN", resellerId: null },
  { id: "admin2", email: "admin2@example.com", name: "Admin Two", role: "ADMIN", resellerId: null },
  { id: "res1", email: "res1@example.com", name: "Reseller One", role: "RESELLER", resellerId: null },
  { id: "res2", email: "res2@example.com", name: "Reseller Two", role: "RESELLER", resellerId: null },
  { id: "sub1", email: "sub1@example.com", name: "Sub One", role: "USER", resellerId: "res1" },
  { id: "sub2", email: "sub2@example.com", name: "Sub Two", role: "USER", resellerId: "res2" },
  { id: "solo", email: "solo@example.com", name: "Solo", role: "USER", resellerId: null },
];

const original = { emailEnabled: env.EMAIL_ENABLED, transport: env.EMAIL_TRANSPORT };
afterEach(() => {
  env.EMAIL_ENABLED = original.emailEnabled;
  env.EMAIL_TRANSPORT = original.transport;
  notifyUser.mockClear();
});

/** Builds the app with guards that behave like the real ones: 401 signed out, 403 for the wrong role. */
async function buildApp(session: { userId: string | null }) {
  const auditCreate = vi.fn(async () => undefined);
  const tokenCreate = vi.fn(async (_args: unknown) => undefined);
  const app = Fastify();
  app.decorate("prisma", {
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => USERS.find((u) => u.id === where.id) ?? null) },
    passwordResetToken: { deleteMany: vi.fn(async () => ({ count: 0 })), create: tokenCreate },
    auditLog: { create: auditCreate },
  } as never);
  app.decorate("redis", { get: vi.fn(), set: vi.fn(), del: vi.fn() } as never);
  app.decorate("requireAuth", vi.fn() as never);
  app.decorate(
    "requireRole",
    ((...roles: string[]) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
        const me = USERS.find((u) => u.id === session.userId);
        if (!me) {
          return reply.status(401).send({ error: "Authentication required", code: "UNAUTHORIZED", details: {} });
        }
        if (!roles.includes(me.role)) {
          return reply.status(403).send({ error: "Forbidden", code: "FORBIDDEN_ROLE", details: {} });
        }
        request.userId = me.id;
        request.userRole = me.role;
      }) as never,
  );
  app.decorate("requireRoleOrPermission", (() => async () => undefined) as never);
  app.decorateRequest("userId", null);
  app.decorateRequest("userRole", null);
  await app.register(errorHandlerPlugin);
  await app.register(userRoutes, { prefix: "/api/users" });
  return { app: app as unknown as FastifyInstance, auditCreate, tokenCreate };
}

async function issue(userId: string | null, targetId: string) {
  const ctx = await buildApp({ userId });
  const res = await ctx.app.inject({ method: "POST", url: `/api/users/${targetId}/password-reset` });
  return { ...ctx, res };
}

describe("POST /api/users/:id/password-reset — authorization", () => {
  it("returns 401 when signed out", async () => {
    expect((await issue(null, "sub1")).res.statusCode).toBe(401);
  });

  it("returns 403 for a normal user", async () => {
    expect((await issue("solo", "sub1")).res.statusCode).toBe(403);
  });

  it("lets an admin reset any non-admin user", async () => {
    env.EMAIL_TRANSPORT = "log";
    for (const target of ["res1", "sub1", "sub2", "solo"]) {
      const { res } = await issue("admin1", target);
      expect(res.statusCode, target).toBe(200);
    }
  });

  it("never lets an admin reset an admin from the panel, including themselves", async () => {
    for (const target of ["admin2", "admin1"]) {
      const { res, tokenCreate } = await issue("admin1", target);
      expect(res.statusCode, target).toBe(403);
      expect(res.json()).toMatchObject({ code: "ADMIN_NOT_RESETTABLE" });
      expect(tokenCreate).not.toHaveBeenCalled();
    }
  });

  it("returns 404 for a user that does not exist", async () => {
    expect((await issue("admin1", "ghost")).res.statusCode).toBe(404);
  });

  it("lets a reseller reset their own sub-account", async () => {
    env.EMAIL_TRANSPORT = "log";
    expect((await issue("res1", "sub1")).res.statusCode).toBe(200);
  });

  it("stops a reseller resetting another reseller's sub-account, an admin, another reseller, themselves or an unowned user", async () => {
    for (const target of ["sub2", "admin1", "res2", "res1", "solo"]) {
      const { res, tokenCreate } = await issue("res1", target);
      expect(res.statusCode, target).toBe(403);
      expect(tokenCreate, target).not.toHaveBeenCalled();
    }
  });
});

describe("POST /api/users/:id/password-reset — result", () => {
  it("returns the link once when email isn't configured, and emails nothing", async () => {
    env.EMAIL_TRANSPORT = "log";
    const { res } = await issue("admin1", "sub1");
    const body = res.json() as { delivery: string; resetUrl: string; expiresAt: string };
    expect(body.delivery).toBe("link");
    expect(body.resetUrl).toMatch(/\/reset-password#token=[0-9a-f]{64}$/);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it("emails the user and keeps the link out of the response when email is configured", async () => {
    env.EMAIL_ENABLED = true;
    env.EMAIL_TRANSPORT = "smtp";
    const { res } = await issue("res1", "sub1");
    expect(res.json()).toMatchObject({ delivery: "email" });
    expect(res.json()).not.toHaveProperty("resetUrl");
    expect(notifyUser).toHaveBeenCalledWith("password_reset", "sub1@example.com", expect.objectContaining({ initiatedByAdmin: true }));
  });

  it("audits who issued it, without ever recording a password or the token", async () => {
    env.EMAIL_TRANSPORT = "log";
    const { res, auditCreate, tokenCreate } = await issue("res1", "sub1");
    const token = (res.json() as { resetUrl: string }).resetUrl.split("#token=")[1]!;

    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: "res1",
        action: "user.password_reset_issued",
        targetType: "User",
        targetId: "sub1",
      }),
    });
    expect(JSON.stringify(auditCreate.mock.calls)).not.toContain(token);

    const stored = JSON.stringify(tokenCreate.mock.calls);
    expect(stored).not.toContain(token);
    expect(stored).toContain("ADMIN");
    expect(stored).toContain("res1");
  });
});
