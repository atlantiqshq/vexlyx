import { beforeEach, describe, expect, it, vi } from "vitest";
import * as argon2 from "argon2";
import type { AuditLogService } from "../audit-log/service.js";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const notifyUser = vi.fn();
vi.mock("../system-email/notifier.js", () => ({ notifyUser: (...args: unknown[]) => notifyUser(...args) }));

const { PasswordResetService, hashResetToken } = await import("./password-reset-service.js");

const USER = { id: "u1", email: "ada@example.com", name: "Ada", role: "USER" };

function setup(user: typeof USER | null = USER) {
  const tokens: { id: string; userId: string; tokenHash: string; expiresAt: Date; usedAt: Date | null }[] = [];
  const prisma = {
    user: {
      findUnique: vi.fn(async () => user),
      update: vi.fn(async (_args: { data: { password: string } }) => undefined),
    },
    passwordResetToken: {
      deleteMany: vi.fn(async ({ where }: { where: { userId: string; usedAt?: null; id?: { not: string } } }) => {
        for (let i = tokens.length - 1; i >= 0; i--) {
          const t = tokens[i]!;
          if (t.userId === where.userId && (where.usedAt === undefined || t.usedAt === null) && (!where.id || t.id !== where.id.not)) {
            tokens.splice(i, 1);
          }
        }
        return { count: 0 };
      }),
      create: vi.fn(async ({ data }: { data: { userId: string; tokenHash: string; expiresAt: Date } }) => {
        tokens.push({ id: `t${tokens.length + 1}`, usedAt: null, ...data });
      }),
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
        const t = tokens.find((x) => x.tokenHash === where.tokenHash);
        return t ? { ...t, user } : null;
      }),
      updateMany: vi.fn(async ({ where }: { where: { id: string; usedAt: null } }) => {
        const t = tokens.find((x) => x.id === where.id && x.usedAt === null);
        if (!t) return { count: 0 };
        t.usedAt = new Date();
        return { count: 1 };
      }),
    },
    session: {
      findMany: vi.fn(async () => [{ id: "s1" }, { id: "s2" }]),
      deleteMany: vi.fn(async () => ({ count: 2 })),
    },
  };
  const redisKeys = new Set<string>();
  const redis = {
    set: vi.fn(async (key: string, _v: string, _m: "EX", _t: number, _nx: "NX") => {
      if (redisKeys.has(key)) return null;
      redisKeys.add(key);
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      keys.forEach((k) => redisKeys.delete(k));
    }),
  };
  const auditLog = { log: vi.fn(async () => undefined) } as unknown as AuditLogService;
  const service = new PasswordResetService(prisma as never, redis, auditLog);
  return { service, prisma, redis, tokens, auditLog };
}

function emailedToken(): string {
  const call = notifyUser.mock.calls.find((c) => c[0] === "password_reset");
  const url = (call?.[2] as { resetUrl: string }).resetUrl;
  return url.split("#token=")[1]!;
}

beforeEach(() => notifyUser.mockClear());

describe("requestReset", () => {
  it("stores only a hash of the emailed token and links to the fragment", async () => {
    const { service, tokens } = setup();
    await service.requestReset("ada@example.com", "203.0.113.5");

    const token = emailedToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.tokenHash).toBe(hashResetToken(token));
    expect(tokens[0]!.tokenHash).not.toBe(token);
    expect(tokens[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("does nothing for an unknown email, without throwing", async () => {
    const { service, tokens } = setup(null);
    await expect(service.requestReset("nobody@example.com", "203.0.113.5")).resolves.toBeUndefined();
    expect(tokens).toHaveLength(0);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it("throttles repeat requests for the same account", async () => {
    const { service } = setup();
    await service.requestReset("ada@example.com", "203.0.113.5");
    await service.requestReset("ada@example.com", "203.0.113.5");
    expect(notifyUser).toHaveBeenCalledTimes(1);
  });

  it("skips admin accounts unless ALLOW_ADMIN_EMAIL_RESET is on", async () => {
    const { service, tokens } = setup({ ...USER, role: "ADMIN" });
    await service.requestReset("ada@example.com", "203.0.113.5");
    expect(tokens).toHaveLength(0);
    expect(notifyUser).not.toHaveBeenCalled();
  });
});

describe("resetPassword", () => {
  async function issue() {
    const ctx = setup();
    await ctx.service.requestReset("ada@example.com", "203.0.113.5");
    return { ...ctx, token: emailedToken() };
  }

  it("sets a new Argon2id password, ends every session and notifies the user", async () => {
    const { service, prisma, redis, auditLog, token } = await issue();

    await service.resetPassword(token, "a-brand-new-password");

    const update = prisma.user.update.mock.calls[0]![0];
    expect(update.data.password).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(update.data.password, "a-brand-new-password")).toBe(true);
    expect(prisma.session.deleteMany).toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalledWith("session:s1", "session:s2");
    expect(auditLog.log).toHaveBeenCalledWith("u1", "user.password_reset", { type: "User", id: "u1" }, {});
    expect(notifyUser).toHaveBeenCalledWith("password_changed", "ada@example.com", { name: "Ada" });
  });

  it("rejects a link on its second use", async () => {
    const { service, token } = await issue();
    await service.resetPassword(token, "a-brand-new-password");
    await expect(service.resetPassword(token, "another-password-1")).rejects.toMatchObject({
      code: "INVALID_RESET_TOKEN",
    });
  });

  it("rejects an expired link", async () => {
    const { service, tokens, token } = await issue();
    tokens[0]!.expiresAt = new Date(Date.now() - 1000);
    await expect(service.resetPassword(token, "a-brand-new-password")).rejects.toMatchObject({
      code: "INVALID_RESET_TOKEN",
    });
  });

  it("rejects a token that was never issued", async () => {
    const { service } = await issue();
    await expect(service.resetPassword("f".repeat(64), "a-brand-new-password")).rejects.toMatchObject({
      code: "INVALID_RESET_TOKEN",
    });
  });

  it("lets only one of two simultaneous requests with the same link win", async () => {
    const { service, token } = await issue();
    const results = await Promise.allSettled([
      service.resetPassword(token, "a-brand-new-password"),
      service.resetPassword(token, "a-brand-new-password"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("invalidates the earlier link when a newer one is requested", async () => {
    const ctx = setup();
    await ctx.service.requestReset("ada@example.com", "203.0.113.5");
    const first = emailedToken();
    ctx.redis.del("password-reset:throttle:u1");
    notifyUser.mockClear();
    await ctx.service.requestReset("ada@example.com", "203.0.113.5");

    await expect(ctx.service.resetPassword(first, "a-brand-new-password")).rejects.toMatchObject({
      code: "INVALID_RESET_TOKEN",
    });
  });
});
