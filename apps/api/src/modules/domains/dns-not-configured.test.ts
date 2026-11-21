import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
delete process.env.DNS_NAMESERVERS;

const { DnsService } = await import("./dns-service.js");
const { domainRoutes } = await import("./routes.js");

const ACTIVE_CONNECTED = { id: "d1", hostname: "example.com", status: "ACTIVE", dnsMode: "CONNECTED" };

function buildPrisma(domain: Record<string, unknown>) {
  const update = vi.fn().mockImplementation(async ({ data }) => ({ ...domain, ...data }));
  const prisma = {
    domain: {
      findFirst: vi.fn().mockResolvedValue(domain),
      findUnique: vi.fn().mockResolvedValue({ dnsMode: "MANAGED" }),
      update,
    },
    dnsRecord: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    mailbox: { count: vi.fn().mockResolvedValue(0) },
  } as unknown as PrismaClient;
  return { prisma, update };
}

describe("DNS hosting when DNS_NAMESERVERS is not set (#247)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VEXLYX_MOCK_DNS", "false");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("reports hosting as not configured and advertises no nameservers", async () => {
    const { prisma } = buildPrisma(ACTIVE_CONNECTED);

    await expect(new DnsService(prisma).checkDelegation("u1", "d1")).resolves.toEqual({
      configured: false,
      delegated: false,
      found: [],
      expected: [],
    });
  });

  it("reports not configured even with mock DNS enabled", async () => {
    vi.stubEnv("VEXLYX_MOCK_DNS", "true");
    const { prisma } = buildPrisma(ACTIVE_CONNECTED);

    const result = await new DnsService(prisma).checkDelegation("u1", "d1");

    expect(result.configured).toBe(false);
    expect(result.delegated).toBe(false);
  });

  it("rejects enabling hosting with 409 DNS_HOSTING_NOT_CONFIGURED", async () => {
    const { prisma, update } = buildPrisma(ACTIVE_CONNECTED);

    await expect(new DnsService(prisma).setDnsMode("u1", "d1", "MANAGED")).rejects.toMatchObject({
      code: "DNS_HOSTING_NOT_CONFIGURED",
      statusCode: 409,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects preparing the zone before delegation too", async () => {
    const { prisma, update } = buildPrisma(ACTIVE_CONNECTED);

    await expect(new DnsService(prisma).setDnsMode("u1", "d1", "MANAGED", true)).rejects.toMatchObject({
      code: "DNS_HOSTING_NOT_CONFIGURED",
    });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("dns-mode routes when DNS_NAMESERVERS is not set (#247)", () => {
  async function appFixture() {
    const prisma = buildPrisma(ACTIVE_CONNECTED).prisma;
    const app = Fastify();
    app.decorate("prisma", prisma);
    app.decorate("requireAuth", async (request, reply) => {
      if (request.headers.authorization !== "test-session") {
        return reply.status(401).send({ error: "Unauthorized", code: "UNAUTHORIZED", details: {} });
      }
      request.userId = "u1";
    });
    await app.register(domainRoutes, { prefix: "/api/domains" });
    return app;
  }

  beforeEach(() => vi.stubEnv("NODE_ENV", "production"));
  afterEach(() => vi.unstubAllEnvs());

  it("requires authentication to check delegation", async () => {
    const app = await appFixture();
    try {
      const response = await app.inject({ method: "POST", url: "/api/domains/d1/dns-mode/check" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("requires authentication to switch the mode", async () => {
    const app = await appFixture();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/domains/d1/dns-mode",
        payload: { mode: "MANAGED" },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("answers the check with configured: false", async () => {
    const app = await appFixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/domains/d1/dns-mode/check",
        headers: { authorization: "test-session" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ configured: false, delegated: false, expected: [] });
    } finally {
      await app.close();
    }
  });

  it("answers enabling with the 409 error shape", async () => {
    const app = await appFixture();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/domains/d1/dns-mode",
        headers: { authorization: "test-session" },
        payload: { mode: "MANAGED", skipDelegationCheck: true },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "DNS_HOSTING_NOT_CONFIGURED" });
      expect(typeof response.json().error).toBe("string");
    } finally {
      await app.close();
    }
  });
});
