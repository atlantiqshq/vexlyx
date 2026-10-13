import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { hasMonitoringAccess } from "./access.js";

afterEach(() => { vi.useRealTimers(); });

function fixture() {
  const prisma = { user: { findUnique: vi.fn().mockResolvedValue({ role: "ADMIN" }) } };
  const redis = { get: vi.fn().mockResolvedValue(JSON.stringify({ userId: "u1", expiresAt: Date.now() + 60_000 })) };
  const allowed = (userId: unknown = "u1", sessionId: unknown = "s1") => hasMonitoringAccess(prisma as unknown as PrismaClient, redis, userId, sessionId);
  return { prisma, redis, allowed };
}

describe("monitoring socket access", () => {
  it("requires a current admin role and matching live session", async () => {
    const { prisma, redis, allowed } = fixture();
    expect(await allowed()).toBe(true);
    expect(redis.get).toHaveBeenCalledExactlyOnceWith("session:s1");
    expect(prisma.user.findUnique).toHaveBeenCalledExactlyOnceWith({ where: { id: "u1" }, select: { role: true } });
  });

  it.each(["USER", "RESELLER", "UNKNOWN", null])("rejects a non-admin or deleted account: %s", async (role) => {
    const { prisma, allowed } = fixture();
    prisma.user.findUnique.mockResolvedValue(role ? { role } : null);
    expect(await allowed()).toBe(false);
  });

  it.each([null, "not-json", "null", "[]", "{}", JSON.stringify({ userId: "other", expiresAt: Date.now() + 60_000 }), JSON.stringify({ userId: "u1", expiresAt: 0 }), JSON.stringify({ userId: "u1", expiresAt: "99999999999999" })])("rejects absent, malformed, mismatched and expired sessions: %s", async (raw) => {
    const { prisma, redis, allowed } = fixture();
    redis.get.mockResolvedValue(raw);
    expect(await allowed()).toBe(false);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it.each([[null, "s1"], ["u1", null], ["", "s1"], ["u1", 42]])("rejects missing or untrusted socket identity: %j", async (userId, sessionId) => {
    const { redis, allowed } = fixture();
    expect(await allowed(userId, sessionId)).toBe(false);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("rechecks the role and session on every call", async () => {
    const { prisma, redis, allowed } = fixture();
    expect(await allowed()).toBe(true);
    prisma.user.findUnique.mockResolvedValue({ role: "USER" });
    expect(await allowed()).toBe(false);
    prisma.user.findUnique.mockResolvedValue({ role: "ADMIN" });
    redis.get.mockResolvedValue(null);
    expect(await allowed()).toBe(false);
  });

  it("rejects a session that expires while the role lookup is pending", async () => {
    vi.useFakeTimers();
    const { prisma, allowed } = fixture();
    prisma.user.findUnique.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 60_001);
      return { role: "ADMIN" };
    });
    expect(await allowed()).toBe(false);
  });
});
