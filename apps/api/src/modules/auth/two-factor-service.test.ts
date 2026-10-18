import { describe, it, expect, vi } from "vitest";
import { authenticator } from "otplib";
import * as argon2 from "argon2";

// config/env.ts validates process.env eagerly at import time, so these must
// be set before two-factor-service.ts (which imports encryption.ts → env.ts)
// is loaded — static imports would be hoisted ahead of any assignment here.
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const { TwoFactorService } = await import("./two-factor-service.js");
const { AuthError } = await import("./service.js");
const { encrypt } = await import("../../utils/encryption.js");

function makeService() {
  const store = new Map<string, string>();
  const redis = {
    set: vi.fn(async (k: string, v: string, _mode?: string, _ttl?: number) => {
      store.set(k, v);
      return "OK";
    }),
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    del: vi.fn(async (k: string) => {
      store.delete(k);
    }),
  };
  const prisma = {
    user: { findUnique: vi.fn(), update: vi.fn() },
    recoveryCode: { createMany: vi.fn(), findMany: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  };
  const auditLog = { log: vi.fn(async () => undefined) };
  const service = new TwoFactorService(prisma as never, redis as never, auditLog as never);
  return { service, prisma, redis, auditLog };
}

describe("TwoFactorService.confirmSetup", () => {
  it("enables 2fa on valid totp code and returns 10 recovery codes", { timeout: 30000 }, async () => {
    const { service, prisma } = makeService();
    const secret = authenticator.generateSecret();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1", email: "u1@example.com", password: "hashed", totpSecretEncrypted: encrypt(secret), totpEnabled: false,
    });
    const code = authenticator.generate(secret);
    const result = await service.confirmSetup("u1", code);
    expect(result.recoveryCodes).toHaveLength(10);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u1" } }),
    );
    expect(prisma.recoveryCode.createMany).toHaveBeenCalledOnce();
    const rows = (prisma.recoveryCode.createMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].data as { userId: string; codeHash: string }[];
    expect(rows).toHaveLength(10);
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]?.userId).toBe("u1");
      expect(rows[i]?.codeHash).not.toBe(result.recoveryCodes[i]);
    }
    // Real-hash proof: at least one stored hash verifies against its plaintext.
    await expect(argon2.verify(rows[0]?.codeHash as string, result.recoveryCodes[0] as string)).resolves.toBe(true);
  });

  it("clears stale unused recovery codes on reconfirm, keeping used rows", { timeout: 60000 }, async () => {
    const { service, prisma } = makeService();
    type Row = { id: string; userId: string; codeHash: string; usedAt: Date | null };
    let rows: Row[] = [];
    let nextId = 0;
    (prisma.recoveryCode.createMany as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ data }: { data: { userId: string; codeHash: string }[] }) => {
        for (const d of data) rows.push({ id: `rc${nextId++}`, userId: d.userId, codeHash: d.codeHash, usedAt: null });
        return { count: data.length };
      },
    );
    (prisma.recoveryCode.deleteMany as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ where }: { where: { userId: string; usedAt?: null } }) => {
        const before = rows.length;
        rows = rows.filter((r) => !(r.userId === where.userId && (where.usedAt === undefined || r.usedAt === null)));
        return { count: before - rows.length };
      },
    );
    (prisma.recoveryCode.findMany as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ where }: { where: { userId: string; usedAt?: null } }) => {
        return rows.filter((r) => r.userId === where.userId && (where.usedAt === undefined || r.usedAt === null));
      },
    );
    (prisma.recoveryCode.update as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ where, data }: { where: { id: string }; data: { usedAt: Date } }) => {
        const row = rows.find((r) => r.id === where.id);
        if (row) row.usedAt = data.usedAt;
        return row;
      },
    );

    const findUnique = prisma.user.findUnique as ReturnType<typeof vi.fn>;
    const secret1 = authenticator.generateSecret();
    findUnique.mockResolvedValue({
      id: "u1", email: "u1@example.com", password: "hashed", totpSecretEncrypted: encrypt(secret1), totpEnabled: false,
    });
    const first = await service.confirmSetup("u1", authenticator.generate(secret1));
    expect(first.recoveryCodes).toHaveLength(10);

    // Mark one first-batch code as used (audit history) — must survive reconfirm.
    findUnique.mockResolvedValue({
      id: "u1", email: "u1@example.com", password: "hashed", totpSecretEncrypted: encrypt(secret1), totpEnabled: true,
    });
    expect(await service.verifyLoginCode("u1", first.recoveryCodes[0] as string)).toBe(true);

    const secret2 = authenticator.generateSecret();
    findUnique.mockResolvedValue({
      id: "u1", email: "u1@example.com", password: "hashed", totpSecretEncrypted: encrypt(secret2), totpEnabled: false,
    });
    const second = await service.confirmSetup("u1", authenticator.generate(secret2));
    expect(second.recoveryCodes).toHaveLength(10);

    expect(prisma.recoveryCode.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1", usedAt: null } });

    // The consumed first-batch row survives reconfirm in observed state.
    const usedRows = rows.filter((r) => r.usedAt !== null);
    expect(usedRows).toHaveLength(1);
    await expect(argon2.verify(usedRows[0]?.codeHash as string, first.recoveryCodes[0] as string)).resolves.toBe(true);

    // Enabled user for verifyLoginCode (recovery-code path: hex codes skip the TOTP branch).
    findUnique.mockResolvedValue({
      id: "u1", email: "u1@example.com", password: "hashed", totpSecretEncrypted: encrypt(secret2), totpEnabled: true,
    });
    // Latest batch verifies…
    expect(await service.verifyLoginCode("u1", second.recoveryCodes[0] as string)).toBe(true);
    // …stale unused codes from the first batch do not (only the used one is gone via consumption).
    expect(await service.verifyLoginCode("u1", first.recoveryCodes[1] as string)).toBe(false);
  });
});

describe("TwoFactorService.verifyLoginCode", () => {
  it("accepts a valid totp code", async () => {
    const { service, prisma } = makeService();
    const secret = authenticator.generateSecret();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1", totpSecretEncrypted: encrypt(secret), totpEnabled: true,
    });
    const ok = await service.verifyLoginCode("u1", authenticator.generate(secret));
    expect(ok).toBe(true);
  });

  it("rejects a wrong code with no recovery codes", async () => {
    const { service, prisma } = makeService();
    const secret = authenticator.generateSecret();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1", totpSecretEncrypted: encrypt(secret), totpEnabled: true,
    });
    (prisma.recoveryCode.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const ok = await service.verifyLoginCode("u1", "000000");
    expect(ok).toBe(false);
  });
});

describe("TwoFactorService.createSetup guard", () => {
  it("rejects setup when 2fa already enabled without clobbering", async () => {
    const { service, prisma } = makeService();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1", email: "u1@example.com", totpEnabled: true, totpSecretEncrypted: "enc",
    });
    const err = await service.createSetup("u1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toMatchObject({ code: "2FA_ALREADY_ENABLED", statusCode: 409 });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("TwoFactorService challenge peek", () => {
  it("peek does not consume; deleteChallenge removes", async () => {
    const { service } = makeService();
    const token = await service.storeChallenge("u1");
    expect(await service.peekChallenge(token)).toBe("u1");
    expect(await service.peekChallenge(token)).toBe("u1");
    await service.deleteChallenge(token);
    expect(await service.peekChallenge(token)).toBeNull();
  });
});

describe("TwoFactorService challenge store", () => {
  it("round-trips a challenge token single-use", async () => {
    const { service } = makeService();
    const token = await service.storeChallenge("u1");
    expect(token).toHaveLength(64);
    expect(await service.consumeChallenge(token)).toBe("u1");
    expect(await service.consumeChallenge(token)).toBeNull();
  });
});
