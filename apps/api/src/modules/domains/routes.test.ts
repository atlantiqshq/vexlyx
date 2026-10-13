import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??=
  "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??=
  "test-session-secret-at-least-32-characters-long";
const { domainRoutes } = await import("./routes.js");
const { DomainService, DomainError } = await import("./service.js");

afterEach(() => vi.restoreAllMocks());

async function appFixture(prisma: PrismaClient = {} as PrismaClient) {
  const app = Fastify();
  app.decorate("prisma", prisma);
  app.decorate("requireAuth", async (request, reply) => {
    if (request.headers.authorization !== "test-session") {
      return reply
        .status(401)
        .send({ error: "Unauthorized", code: "UNAUTHORIZED", details: {} });
    }
    request.userId = "u1";
  });
  await app.register(domainRoutes, { prefix: "/api/domains" });
  return app;
}

describe("PATCH /api/domains/:id", () => {
  it("requires authentication", async () => {
    const update = vi.spyOn(DomainService.prototype, "update");
    const app = await appFixture();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/domains/d1",
        payload: { projectId: "p1" },
      });
      expect(response.statusCode).toBe(401);
      expect(update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("validates the payload before updating", async () => {
    const update = vi.spyOn(DomainService.prototype, "update");
    const app = await appFixture();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/domains/d1",
        headers: { authorization: "test-session" },
        payload: {},
      });
      expect(response.statusCode).toBe(400);
      expect(update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("updates using the authenticated user", async () => {
    const update = vi
      .spyOn(DomainService.prototype, "update")
      .mockResolvedValue({ id: "d1", projectId: null } as never);
    const app = await appFixture();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/domains/d1",
        headers: { authorization: "test-session" },
        payload: { projectId: null },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: "d1", projectId: null });
      expect(update).toHaveBeenCalledWith("u1", "d1", { projectId: null });
    } finally {
      await app.close();
    }
  });

  it("returns the domain error without exposing other users' domains", async () => {
    vi.spyOn(DomainService.prototype, "update").mockRejectedValue(
      new DomainError("Domain not found", "DOMAIN_NOT_FOUND", 404),
    );
    const app = await appFixture();
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/domains/d1",
        headers: { authorization: "test-session" },
        payload: { projectId: "p1" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: "Domain not found",
        code: "DOMAIN_NOT_FOUND",
        details: {},
      });
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/domains/ssl/alerts", () => {
  function prismaFixture() {
    return {
      user: { findUnique: vi.fn().mockResolvedValue({ role: "USER" }) },
      certificate: {
        // A deliberately unsafe query reproduces the original cross-tenant leak.
        findMany: vi.fn().mockImplementation(async ({ where }) => {
          const certificates = ["u1", "u2"].map((userId) => ({
            id: `cert-${userId}`, domainId: `domain-${userId}`, status: "ACTIVE",
            validTo: new Date(Date.now() + 3.5 * 86_400_000),
            domain: { hostname: `${userId}.example`, userId },
          }));
          return where?.domain?.userId
            ? certificates.filter((cert) => cert.domain.userId === where.domain.userId)
            : certificates;
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
  }

  it("requires authentication before reading any certificates", async () => {
    const prisma = prismaFixture();
    const app = await appFixture(prisma as unknown as PrismaClient);
    try {
      const response = await app.inject({ method: "GET", url: "/api/domains/ssl/alerts" });
      expect(response.statusCode).toBe(401);
      expect(prisma.certificate.findMany).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(["", "?userId=u2&role=ADMIN&ownOnly=false"])("returns only the authenticated user's alerts and counts: %s", async (query) => {
    const prisma = prismaFixture();
    const app = await appFixture(prisma as unknown as PrismaClient);
    try {
      const response = await app.inject({
        method: "GET", url: `/api/domains/ssl/alerts${query}`,
        headers: { authorization: "test-session" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        totalChecked: 1, expiringSoon: 1, expired: 0,
        alerts: [{ domainId: "domain-u1", hostname: "u1.example", daysRemaining: 3, status: "EXPIRING_SOON" }],
      });
      expect(prisma.certificate.update).toHaveBeenCalledTimes(1);
      expect(prisma.certificate.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: "cert-u1", AND: { domain: { userId: "u1" } } },
      }));
    } finally {
      await app.close();
    }
  });

  it("rejects a deleted account with a remaining session", async () => {
    const prisma = prismaFixture();
    prisma.user.findUnique.mockResolvedValue(null);
    const app = await appFixture(prisma as unknown as PrismaClient);
    try {
      const response = await app.inject({
        method: "GET", url: "/api/domains/ssl/alerts",
        headers: { authorization: "test-session" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "Access denied", code: "FORBIDDEN", details: {} });
      expect(prisma.certificate.findMany).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
