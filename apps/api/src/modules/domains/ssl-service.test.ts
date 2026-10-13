import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient, Role } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
const { SslService } = await import("./ssl-service.js");

afterEach(() => vi.useRealTimers());

function fixture(role: Role = "USER") {
  const prisma = {
    user: { findUnique: vi.fn().mockResolvedValue({ role }) },
    certificate: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  return { prisma, service: new SslService(prisma as unknown as PrismaClient) };
}

describe("SslService.checkExpiryAlerts", () => {
  it.each([
    ["USER", { domain: { userId: "caller" } }],
    ["RESELLER", { domain: { OR: [{ userId: "caller" }, { user: { resellerId: "caller" } }] } }],
    ["ADMIN", {}],
  ] as const)("scopes the database query for %s", async (role, where) => {
    const { prisma, service } = fixture(role);
    expect(await service.checkExpiryAlerts("caller")).toEqual({
      totalChecked: 0, expiringSoon: 0, expired: 0, alerts: [],
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "caller" }, select: { role: true },
    });
    expect(prisma.certificate.findMany).toHaveBeenCalledWith({
      where, include: { domain: { select: { hostname: true } } },
    });
  });

  it.each(["ADMIN", "RESELLER", "USER"] as const)("keeps the dashboard own-only for %s", async (role) => {
    const { prisma, service } = fixture(role);
    await service.checkExpiryAlerts("caller", { ownOnly: true });
    expect(prisma.certificate.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { domain: { userId: "caller" } },
    }));
  });

  it("rejects absent identity before querying the database", async () => {
    const { prisma, service } = fixture("ADMIN");
    await expect(service.checkExpiryAlerts(undefined as unknown as string)).rejects.toMatchObject({
      statusCode: 401, code: "UNAUTHORIZED",
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.certificate.findMany).not.toHaveBeenCalled();
  });

  it.each([null, { role: "UNKNOWN" }])("fails closed for a missing or invalid account: %j", async (user) => {
    const { prisma, service } = fixture();
    prisma.user.findUnique.mockResolvedValue(user);
    await expect(service.checkExpiryAlerts("caller")).rejects.toMatchObject({
      statusCode: 403, code: "FORBIDDEN",
    });
    expect(prisma.certificate.findMany).not.toHaveBeenCalled();
    expect(prisma.certificate.update).not.toHaveBeenCalled();
  });

  it("uses the current role on every call, including after demotion", async () => {
    const { prisma, service } = fixture("ADMIN");
    await service.checkExpiryAlerts("caller");
    prisma.user.findUnique.mockResolvedValue({ role: "USER" });
    await service.checkExpiryAlerts("caller");
    expect(prisma.certificate.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { domain: { userId: "caller" } },
    }));
  });

  it("calculates counts from scoped rows and preserves the ownership check on updates", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-10-14T12:00:00Z");
    vi.setSystemTime(now);
    const { prisma, service } = fixture();
    const day = 86_400_000;
    prisma.certificate.findMany.mockResolvedValue([
      { id: "soon", domainId: "d1", status: "ACTIVE", validTo: new Date(+now + 3 * day), domain: { hostname: "soon.example" } },
      { id: "expired", domainId: "d2", status: "ACTIVE", validTo: new Date(+now - day), domain: { hostname: "expired.example" } },
      { id: "healthy", domainId: "d3", status: "ACTIVE", validTo: new Date(+now + 90 * day), domain: { hostname: "healthy.example" } },
    ]);

    expect(await service.checkExpiryAlerts("caller")).toEqual({
      totalChecked: 3, expiringSoon: 1, expired: 1,
      alerts: [
        { domainId: "d1", hostname: "soon.example", daysRemaining: 3, status: "EXPIRING_SOON" },
        { domainId: "d2", hostname: "expired.example", daysRemaining: -1, status: "EXPIRED" },
      ],
    });
    expect(prisma.certificate.update).toHaveBeenCalledTimes(2);
    expect(prisma.certificate.update).toHaveBeenCalledWith({
      where: { id: "soon", AND: { domain: { userId: "caller" } } },
      data: { status: "EXPIRING_SOON", lastCheckedAt: now },
    });
    expect(prisma.certificate.update).toHaveBeenCalledWith({
      where: { id: "expired", AND: { domain: { userId: "caller" } } },
      data: { status: "EXPIRED", lastCheckedAt: now },
    });
  });
});
