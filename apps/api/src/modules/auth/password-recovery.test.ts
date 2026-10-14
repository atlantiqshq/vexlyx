import { describe, expect, it, vi } from "vitest";
import * as argon2 from "argon2";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const { recoverAccount, RecoveryError } = await import("./password-recovery.js");
const { hashResetToken } = await import("./password-reset-token.js");

const ADMIN = { id: "admin1", email: "Admin@Example.com" };

function setup(found: typeof ADMIN | null = ADMIN, withRedis = true) {
  const tokenCreate = vi.fn(async (_args: { data: { tokenHash: string; source: string; expiresAt: Date; createdById: string | null } }) => undefined);
  const prisma = {
    user: { findFirst: vi.fn(async () => found), update: vi.fn(async () => undefined) },
    passwordResetToken: { deleteMany: vi.fn(async () => ({ count: 1 })), create: tokenCreate },
    recoveryCode: { deleteMany: vi.fn(async () => ({ count: 10 })) },
    session: {
      findMany: vi.fn(async () => [{ id: "s1" }, { id: "s2" }]),
      deleteMany: vi.fn(async () => ({ count: 2 })),
    },
  };
  const redis = { del: vi.fn(async () => 2) };
  const audit = { log: vi.fn(async () => undefined) };
  const deps = {
    prisma: prisma as never,
    redis: withRedis ? redis : undefined,
    audit,
    buildUrl: (path: string) => `https://panel.example.com${path}`,
  };
  return { deps, prisma, redis, audit, tokenCreate };
}

describe("recoverAccount — reset link (the default)", () => {
  it("prints a single-use CLI link and changes nothing else", async () => {
    const { deps, prisma, redis, audit, tokenCreate } = setup();

    const result = await recoverAccount(deps, { email: "admin@example.com" });

    expect(result.resetUrl).toMatch(/^https:\/\/panel\.example\.com\/reset-password#token=[0-9a-f]{64}$/);
    expect(result.expiresMinutes).toBe(60);
    expect(result.passwordChanged).toBe(false);
    expect(result.twoFactorDisabled).toBe(false);

    const stored = tokenCreate.mock.calls[0]![0].data;
    expect(stored.source).toBe("CLI");
    expect(stored.createdById).toBeNull();
    expect(stored.tokenHash).toBe(hashResetToken(result.resetUrl!.split("#token=")[1]!));
    expect(stored.tokenHash).not.toContain(result.resetUrl!.split("#token=")[1]!);

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith("admin1", "user.password_reset_issued", { type: "User", id: "admin1" }, {
      after: { source: "cli", delivery: "link" },
    });
  });

  it("works with no Redis and no email configured at all", async () => {
    const { deps } = setup(ADMIN, false);
    await expect(recoverAccount(deps, { email: "admin@example.com", link: true })).resolves.toMatchObject({
      resetUrl: expect.stringContaining("/reset-password#token="),
    });
  });

  it("looks the account up case-insensitively", async () => {
    const { deps, prisma } = setup();
    await recoverAccount(deps, { email: "  ADMIN@example.com " });
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: { equals: "ADMIN@example.com", mode: "insensitive" } } }),
    );
  });

  it("reports an unknown email without touching anything", async () => {
    const { deps, tokenCreate } = setup(null);
    await expect(recoverAccount(deps, { email: "nobody@example.com" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(tokenCreate).not.toHaveBeenCalled();
  });
});

describe("recoverAccount — set a password from stdin", () => {
  it("hashes it with Argon2id, ends every session, clears old links and audits it", async () => {
    const { deps, prisma, redis, audit, tokenCreate } = setup();

    const result = await recoverAccount(deps, { email: "admin@example.com", newPassword: "a long recovery passphrase" });

    expect(result).toMatchObject({ passwordChanged: true, twoFactorDisabled: false });
    expect(result.resetUrl).toBeUndefined();
    expect(tokenCreate).not.toHaveBeenCalled();

    const written = (prisma.user.update.mock.calls[0] as unknown as [{ data: { password: string } }])[0].data.password;
    expect(written).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(written, "a long recovery passphrase")).toBe(true);
    expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({ where: { userId: "admin1" } });
    expect(redis.del).toHaveBeenCalledWith("session:s1", "session:s2");
    expect(audit.log).toHaveBeenCalledWith("admin1", "user.password_reset", { type: "User", id: "admin1" }, {
      after: { source: "cli" },
    });
  });

  it.each(["short", "password1234", "aaaaaaaaaaaa"])("rejects %j and leaves the account untouched", async (weak) => {
    const { deps, prisma, redis } = setup();
    await expect(recoverAccount(deps, { email: "admin@example.com", newPassword: weak })).rejects.toMatchObject({
      code: "WEAK_PASSWORD",
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it("refuses to run without Redis, since the old sessions could otherwise survive", async () => {
    const { deps, prisma } = setup(ADMIN, false);
    await expect(
      recoverAccount(deps, { email: "admin@example.com", newPassword: "a long recovery passphrase" }),
    ).rejects.toBeInstanceOf(RecoveryError);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("recoverAccount — disable two-factor", () => {
  it("clears the authenticator and recovery codes, ends sessions and audits it", async () => {
    const { deps, prisma, redis, audit } = setup();

    const result = await recoverAccount(deps, { email: "admin@example.com", disable2fa: true });

    expect(result).toMatchObject({ twoFactorDisabled: true, passwordChanged: false });
    expect(result.resetUrl).toBeUndefined();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "admin1" },
      data: { totpSecretEncrypted: null, totpEnabled: false, totpVerifiedAt: null },
    });
    expect(prisma.recoveryCode.deleteMany).toHaveBeenCalledWith({ where: { userId: "admin1" } });
    expect(redis.del).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith("admin1", "user.2fa_reset", { type: "User", id: "admin1" }, {
      after: { source: "cli" },
    });
  });

  it("can also print a link in the same run", async () => {
    const { deps } = setup();
    const result = await recoverAccount(deps, { email: "admin@example.com", disable2fa: true, link: true });
    expect(result.twoFactorDisabled).toBe(true);
    expect(result.resetUrl).toContain("/reset-password#token=");
  });
});
