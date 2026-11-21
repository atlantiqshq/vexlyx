import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

const nsAnswers = vi.hoisted(() => ({ ns: [] as string[] }));

vi.mock("node:dns/promises", () => {
  class Resolver {
    setServers() {}
    async resolveNs() {
      if (nsAnswers.ns.length === 0) throw new Error("ENODATA");
      return nsAnswers.ns;
    }
  }
  return { default: { Resolver } };
});

// config/env.ts validates process.env at import time
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
process.env.DNS_NAMESERVERS = "ns1.example.net,ns2.example.net";

const { DnsService } = await import("./dns-service.js");
const { DomainError } = await import("./service.js");

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

const ACTIVE_CONNECTED = { id: "d1", hostname: "example.com", status: "ACTIVE", dnsMode: "CONNECTED" };

describe("DnsService.checkDelegation with DNS_NAMESERVERS set", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VEXLYX_MOCK_DNS", "false");
    nsAnswers.ns = ["ns1.example.net", "ns2.example.net"];
  });
  afterEach(() => vi.unstubAllEnvs());

  it("reports hosting as configured with the configured nameservers", async () => {
    const { prisma } = buildPrisma(ACTIVE_CONNECTED);

    await expect(new DnsService(prisma).checkDelegation("u1", "d1")).resolves.toEqual({
      configured: true,
      delegated: true,
      found: ["ns1.example.net", "ns2.example.net"],
      expected: ["ns1.example.net", "ns2.example.net"],
    });
  });
});

describe("DnsService.setDnsMode", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VEXLYX_MOCK_DNS", "false");
    nsAnswers.ns = [];
  });
  afterEach(() => vi.unstubAllEnvs());

  it("rejects hosting an unverified domain", async () => {
    const { prisma } = buildPrisma({ ...ACTIVE_CONNECTED, status: "PENDING" });

    await expect(new DnsService(prisma).setDnsMode("u1", "d1", "MANAGED")).rejects.toMatchObject({
      code: "DOMAIN_NOT_VERIFIED",
    });
  });

  it("rejects hosting when nameservers are not delegated", async () => {
    const { prisma, update } = buildPrisma(ACTIVE_CONNECTED);
    nsAnswers.ns = ["dns1.p08.nsone.net"];

    const attempt = new DnsService(prisma).setDnsMode("u1", "d1", "MANAGED");

    await expect(attempt).rejects.toBeInstanceOf(DomainError);
    await expect(attempt).rejects.toMatchObject({ code: "NS_NOT_DELEGATED" });
    expect(update).not.toHaveBeenCalled();
  });

  it("enables hosting once every configured nameserver is delegated", async () => {
    const { prisma, update } = buildPrisma(ACTIVE_CONNECTED);
    nsAnswers.ns = ["NS1.example.net.", "ns2.example.net"];

    const result = await new DnsService(prisma).setDnsMode("u1", "d1", "MANAGED");

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { dnsMode: "MANAGED" } }));
    expect(result.dnsMode).toBe("MANAGED");
  });

  it("prepares the zone before delegation when skipDelegationCheck is set", async () => {
    const { prisma, update } = buildPrisma(ACTIVE_CONNECTED);

    await new DnsService(prisma).setDnsMode("u1", "d1", "MANAGED", true);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { dnsMode: "MANAGED" } }));
  });

  it("still requires a verified domain when skipping the delegation check", async () => {
    const { prisma } = buildPrisma({ ...ACTIVE_CONNECTED, status: "PENDING" });

    await expect(new DnsService(prisma).setDnsMode("u1", "d1", "MANAGED", true)).rejects.toMatchObject({
      code: "DOMAIN_NOT_VERIFIED",
    });
  });

  it("refuses to switch back while the domain has mailboxes", async () => {
    const { prisma } = buildPrisma({ ...ACTIVE_CONNECTED, dnsMode: "MANAGED" });
    (prisma.mailbox.count as ReturnType<typeof vi.fn>).mockResolvedValue(2);

    await expect(new DnsService(prisma).setDnsMode("u1", "d1", "CONNECTED")).rejects.toMatchObject({
      code: "DNS_MODE_MAIL_ACTIVE",
    });
  });
});
