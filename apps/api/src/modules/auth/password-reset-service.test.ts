import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as argon2 from "argon2";
import type { AuditLogService } from "../audit-log/service.js";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const notifyUser = vi.fn();
vi.mock("../system-email/notifier.js", () => ({ notifyUser: (...args: unknown[]) => notifyUser(...args) }));

const { env } = await import("../../config/env.js");
const { PasswordResetService, hashResetToken } = await import("./password-reset-service.js");

type Source = "SELF_SERVICE" | "ADMIN" | "CLI";
interface StoredToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  source: Source;
  createdById: string | null;
}

const USER = { id: "u1", email: "ada@example.com", name: "Ada", role: "USER" as "USER" | "ADMIN" | "RESELLER" };

function setup(user: typeof USER | null = USER, scheduler?: (task: () => Promise<void>) => void) {
  const tokens: StoredToken[] = [];
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
      create: vi.fn(async ({ data }: { data: Omit<StoredToken, "id" | "usedAt"> }) => {
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
  const logger = { error: vi.fn() };
  const service = new PasswordResetService(prisma as never, redis, auditLog, logger, scheduler);
  return { service, prisma, redis, tokens, auditLog, logger };
}

function lastResetUrl(): string {
  const call = [...notifyUser.mock.calls].reverse().find((c) => c[0] === "password_reset");
  return (call?.[2] as { resetUrl: string }).resetUrl;
}

const tokenFromUrl = (url: string) => url.split("#token=")[1]!;
const emailedToken = () => tokenFromUrl(lastResetUrl());

const original = {
  allowAdmin: env.ALLOW_ADMIN_EMAIL_RESET,
  emailEnabled: env.EMAIL_ENABLED,
  transport: env.EMAIL_TRANSPORT,
};

beforeEach(() => notifyUser.mockClear());
afterEach(() => {
  env.ALLOW_ADMIN_EMAIL_RESET = original.allowAdmin;
  env.EMAIL_ENABLED = original.emailEnabled;
  env.EMAIL_TRANSPORT = original.transport;
});

describe("requestReset", () => {
  it("returns before doing any work, so timing can't reveal whether the email exists", () => {
    const scheduled: Array<() => Promise<void>> = [];
    const { service, prisma } = setup(USER, (task) => scheduled.push(task));

    expect(service.requestReset("ada@example.com", "203.0.113.5")).toBeUndefined();

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(notifyUser).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
  });

  it("logs, rather than throws, when the deferred work fails", async () => {
    const { service, prisma, logger } = setup();
    prisma.user.findUnique.mockRejectedValueOnce(new Error("db down"));

    service.requestReset("ada@example.com", "203.0.113.5");
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
  });
});

describe("handleRequest", () => {
  it("stores only a hash of the emailed token and links to the fragment", async () => {
    const { service, tokens } = setup();
    await service.handleRequest("ada@example.com", "203.0.113.5");

    const token = emailedToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.tokenHash).toBe(hashResetToken(token));
    expect(tokens[0]!.tokenHash).not.toBe(token);
    expect(tokens[0]!.source).toBe("SELF_SERVICE");
    expect(tokens[0]!.createdById).toBeNull();
    expect(tokens[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(tokens[0]!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
  });

  it("does nothing for an unknown email, without throwing", async () => {
    const { service, tokens } = setup(null);
    await expect(service.handleRequest("nobody@example.com", "203.0.113.5")).resolves.toBeUndefined();
    expect(tokens).toHaveLength(0);
    expect(notifyUser).not.toHaveBeenCalled();
  });

  it("throttles repeat requests for the same account", async () => {
    const { service } = setup();
    await service.handleRequest("ada@example.com", "203.0.113.5");
    await service.handleRequest("ada@example.com", "203.0.113.5");
    expect(notifyUser).toHaveBeenCalledTimes(1);
  });

  it("skips admin accounts unless ALLOW_ADMIN_EMAIL_RESET is on", async () => {
    const { service, tokens } = setup({ ...USER, role: "ADMIN" });
    env.ALLOW_ADMIN_EMAIL_RESET = false;
    await service.handleRequest("ada@example.com", "203.0.113.5");
    expect(tokens).toHaveLength(0);
    expect(notifyUser).not.toHaveBeenCalled();

    env.ALLOW_ADMIN_EMAIL_RESET = true;
    await service.handleRequest("ada@example.com", "203.0.113.5");
    expect(tokens).toHaveLength(1);
  });
});

describe("resetPassword", () => {
  async function issue() {
    const ctx = setup();
    await ctx.service.handleRequest("ada@example.com", "203.0.113.5");
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
    expect(auditLog.log).toHaveBeenCalledWith("u1", "user.password_reset", { type: "User", id: "u1" }, {
      after: { source: "SELF_SERVICE", issuedBy: null },
    });
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
    await ctx.service.handleRequest("ada@example.com", "203.0.113.5");
    const first = emailedToken();
    ctx.redis.del("password-reset:throttle:u1");
    notifyUser.mockClear();
    await ctx.service.handleRequest("ada@example.com", "203.0.113.5");

    await expect(ctx.service.resetPassword(first, "a-brand-new-password")).rejects.toMatchObject({
      code: "INVALID_RESET_TOKEN",
    });
  });

  it("never touches two-factor settings", async () => {
    const { service, prisma, token } = await issue();
    await service.resetPassword(token, "a-brand-new-password");
    const data = prisma.user.update.mock.calls[0]![0].data;
    expect(Object.keys(data)).toEqual(["password"]);
  });

  it("does not log the user in", async () => {
    const { service, token } = await issue();
    // The service has no way to create a session at all, only to destroy them.
    await expect(service.resetPassword(token, "a-brand-new-password")).resolves.toBeUndefined();
    expect("createSession" in service).toBe(false);
  });
});

describe("issueForUser (admin or reseller initiated)", () => {
  it("emails the link and never returns it when email delivery is configured", async () => {
    const { service, tokens, auditLog } = setup();
    env.EMAIL_ENABLED = true;
    env.EMAIL_TRANSPORT = "smtp";

    const result = await service.issueForUser("admin1", USER);

    expect(result.delivery).toBe("email");
    expect(result).not.toHaveProperty("resetUrl");
    expect(notifyUser).toHaveBeenCalledWith(
      "password_reset",
      "ada@example.com",
      expect.objectContaining({ initiatedByAdmin: true, expiresMinutes: 24 * 60 }),
    );
    expect(tokens[0]).toMatchObject({ source: "ADMIN", createdById: "admin1" });
    expect(auditLog.log).toHaveBeenCalledWith("admin1", "user.password_reset_issued", { type: "User", id: "u1" }, {
      after: { delivery: "email" },
    });
  });

  it("returns the link once, and sends nothing, when email isn't configured", async () => {
    const { service, tokens } = setup();
    env.EMAIL_TRANSPORT = "log";

    const result = await service.issueForUser("admin1", USER);

    expect(result.delivery).toBe("link");
    expect(result.resetUrl).toContain("/reset-password#token=");
    expect(notifyUser).not.toHaveBeenCalled();
    expect(tokens[0]!.tokenHash).toBe(hashResetToken(tokenFromUrl(result.resetUrl!)));
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
  });

  it("refuses admin accounts, which recover from the server", async () => {
    const { service, tokens } = setup();
    await expect(service.issueForUser("admin1", { ...USER, role: "ADMIN" })).rejects.toMatchObject({
      code: "ADMIN_NOT_RESETTABLE",
      statusCode: 403,
    });
    expect(tokens).toHaveLength(0);
  });

  it("replaces an earlier link, and the new link resets the password and ends sessions", async () => {
    const { service, prisma, redis, auditLog } = setup();
    env.EMAIL_TRANSPORT = "log";

    const first = await service.issueForUser("admin1", USER);
    const second = await service.issueForUser("admin1", USER);

    await expect(service.resetPassword(tokenFromUrl(first.resetUrl!), "a-brand-new-password")).rejects.toMatchObject({
      code: "INVALID_RESET_TOKEN",
    });
    await service.resetPassword(tokenFromUrl(second.resetUrl!), "a-brand-new-password");

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith("session:s1", "session:s2");
    expect(auditLog.log).toHaveBeenCalledWith("u1", "user.password_reset", { type: "User", id: "u1" }, {
      after: { source: "ADMIN", issuedBy: "admin1" },
    });
  });
});

describe("who a link may reset", () => {
  async function tokenFor(source: Source, role: "USER" | "ADMIN") {
    const ctx = setup({ ...USER, role });
    const token = "a".repeat(64);
    ctx.tokens.push({
      id: "t1",
      userId: "u1",
      tokenHash: hashResetToken(token),
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      source,
      createdById: null,
    });
    return { ...ctx, token };
  }

  it("lets a shell-issued link reset an admin even though email reset is off", async () => {
    env.ALLOW_ADMIN_EMAIL_RESET = false;
    const { service, prisma, token } = await tokenFor("CLI", "ADMIN");
    await service.resetPassword(token, "a-brand-new-password");
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it("rejects a self-service link for an admin unless the operator opted in", async () => {
    env.ALLOW_ADMIN_EMAIL_RESET = false;
    const off = await tokenFor("SELF_SERVICE", "ADMIN");
    await expect(off.service.resetPassword(off.token, "a-brand-new-password")).rejects.toMatchObject({
      code: "INVALID_RESET_TOKEN",
    });

    env.ALLOW_ADMIN_EMAIL_RESET = true;
    const on = await tokenFor("SELF_SERVICE", "ADMIN");
    await on.service.resetPassword(on.token, "a-brand-new-password");
    expect(on.prisma.user.update).toHaveBeenCalled();
  });

  it("rejects an admin-issued link once its user has since become an admin", async () => {
    env.ALLOW_ADMIN_EMAIL_RESET = true;
    const { service, prisma, token } = await tokenFor("ADMIN", "ADMIN");
    await expect(service.resetPassword(token, "a-brand-new-password")).rejects.toMatchObject({
      code: "INVALID_RESET_TOKEN",
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
