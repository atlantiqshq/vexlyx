import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

vi.mock("../../config/queue.js", () => ({
  createQueue: () => ({
    name: "scheduled-task-runner",
    upsertJobScheduler: vi.fn(async () => undefined),
    removeJobScheduler: vi.fn(async () => undefined),
    getJobSchedulers: vi.fn(async () => []),
  }),
  createWorker: () => ({}),
}));
vi.mock("../system/service.js", () => ({
  SystemService: class {
    async getSettings() {
      return { timezone: "UTC" };
    }
  },
}));

const { scheduledTaskRoutes } = await import("./routes.js");
const { errorHandlerPlugin } = await import("../../plugins/error-handler.js");

const OWNER_PROJECT = {
  id: "cproject000000000000000001",
  userId: "owner-1",
  name: "my-project",
  type: "NODEJS",
  containerId: "c1",
  containerStatus: "running",
};

function createPrisma() {
  return {
    project: { findUnique: vi.fn(async () => OWNER_PROJECT) },
    scheduledTask: {
      findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => [{ id: "ctask00000000000000000001", projectId: "cproject000000000000000001", name: "t" }]),
      findUnique: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "ctask00000000000000000001", ...args.data })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "ctask00000000000000000001", ...args.data })),
      delete: vi.fn(async () => undefined),
      count: vi.fn(async () => 0),
    },
    scheduledTaskRun: {
      findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    user: {
      findUnique: vi.fn(async (): Promise<Record<string, unknown>> => ({
        id: "owner-1",
        email: "owner@example.com",
        role: "USER",
        resellerId: null,
        maxScheduledTasks: null,
      })),
    },
    auditLog: { create: vi.fn(async () => undefined) },
  };
}

type Session = { userId: string | null; role: "ADMIN" | "USER" | "RESELLER" };

async function buildApp(session: Session, prisma = createPrisma()): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  app.decorate("prisma", prisma as never);
  app.decorate("redis", { set: vi.fn(async () => "OK"), eval: vi.fn(async () => 1), get: vi.fn(), del: vi.fn() } as never);
  app.decorate("registerQueue", vi.fn() as never);
  app.decorateRequest("userId", null);
  app.decorateRequest("userRole", null);
  app.decorateRequest("userResellerId", null);
  app.decorate(
    "requireAuth",
    (async (request: FastifyRequest, reply: FastifyReply) => {
      if (!session.userId) {
        return reply.status(401).send({ error: "Authentication required", code: "UNAUTHORIZED", details: {} });
      }
      request.userId = session.userId;
      request.userRole = session.role;
    }) as never,
  );
  await app.register(scheduledTaskRoutes, { prefix: "/api/projects" });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduled task routes — authorization", () => {
  it("returns 401 for every endpoint when signed out", async () => {
    const app = await buildApp({ userId: null, role: "USER" });
    const calls: Array<{ method: "GET" | "POST" | "PUT" | "DELETE"; url: string }> = [
      { method: "GET", url: "/api/projects/cproject000000000000000001/scheduled-tasks" },
      { method: "POST", url: "/api/projects/cproject000000000000000001/scheduled-tasks" },
      { method: "GET", url: "/api/projects/cproject000000000000000001/scheduled-tasks/ctask00000000000000000001" },
      { method: "PUT", url: "/api/projects/cproject000000000000000001/scheduled-tasks/ctask00000000000000000001" },
      { method: "DELETE", url: "/api/projects/cproject000000000000000001/scheduled-tasks/ctask00000000000000000001" },
      { method: "POST", url: "/api/projects/cproject000000000000000001/scheduled-tasks/ctask00000000000000000001/run" },
      { method: "GET", url: "/api/projects/cproject000000000000000001/scheduled-tasks/ctask00000000000000000001/runs" },
    ];
    for (const call of calls) {
      const res = await app.inject({ ...call, payload: call.method === "GET" ? undefined : {} });
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(401);
    }
  });

  it("returns 403 when another user manages someone else's project", async () => {
    const app = await buildApp({ userId: "intruder", role: "USER" });
    const res = await app.inject({ method: "GET", url: "/api/projects/cproject000000000000000001/scheduled-tasks" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
  });

  it("lets the owner list tasks", async () => {
    const app = await buildApp({ userId: "owner-1", role: "USER" });
    const res = await app.inject({ method: "GET", url: "/api/projects/cproject000000000000000001/scheduled-tasks" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tasks: [{ id: "ctask00000000000000000001" }] });
  });

  it("lets a reseller list a sub-account's tasks", async () => {
    const prisma = createPrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: "owner-1",
      email: "owner@example.com",
      role: "USER",
      resellerId: "reseller-1",
      maxScheduledTasks: null,
    });
    const app = await buildApp({ userId: "reseller-1", role: "RESELLER" }, prisma);
    const res = await app.inject({ method: "GET", url: "/api/projects/cproject000000000000000001/scheduled-tasks" });
    expect(res.statusCode).toBe(200);
  });
});

describe("scheduled task routes — validation", () => {
  it("rejects a 6-field (seconds) cron expression", async () => {
    const app = await buildApp({ userId: "owner-1", role: "USER" });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/cproject000000000000000001/scheduled-tasks",
      payload: { name: "t", command: "echo hi", schedule: "* * * * * *" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it("rejects an over-long command", async () => {
    const app = await buildApp({ userId: "owner-1", role: "USER" });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/cproject000000000000000001/scheduled-tasks",
      payload: { name: "t", command: "x".repeat(5000), schedule: "* * * * *" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts stepped and ranged cron fields (BullMQ-compatible)", async () => {
    for (const schedule of ["*/5 * * * *", "0-30/10 * * * *", "0 0 * * 0", "*/15 9-17 * 1,7 1-5"]) {
      const app = await buildApp({ userId: "owner-1", role: "USER" });
      const res = await app.inject({
        method: "POST",
        url: "/api/projects/cproject000000000000000001/scheduled-tasks",
        payload: { name: "t", command: "echo hi", schedule },
      });
      expect(res.statusCode, schedule).toBe(201);
    }
  });

  it("rejects out-of-range and short cron fields before saving", async () => {
    for (const schedule of ["99 99 99 99 99", "0 0 * 0", "*/0 * * * *", "61 * * * *", "0 25 * * *"]) {
      const app = await buildApp({ userId: "owner-1", role: "USER" });
      const res = await app.inject({
        method: "POST",
        url: "/api/projects/cproject000000000000000001/scheduled-tasks",
        payload: { name: "t", command: "echo hi", schedule },
      });
      expect(res.statusCode, schedule).toBe(400);
      expect(res.json().code, schedule).toBe("VALIDATION_ERROR");
    }
  });

  it("accepts a valid task and audits the creation", async () => {
    const prisma = createPrisma();
    const app = await buildApp({ userId: "owner-1", role: "USER" }, prisma);
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/cproject000000000000000001/scheduled-tasks",
      payload: { name: "nightly", command: "echo hi", schedule: "0 0 * * *" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: "ctask00000000000000000001", schedule: "0 0 * * *", userId: "owner-1" });
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it("enforces the quota with QUOTA_EXCEEDED", async () => {
    const prisma = createPrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: "owner-1",
      email: "owner@example.com",
      role: "USER",
      resellerId: null,
      maxScheduledTasks: 0,
    });
    const app = await buildApp({ userId: "owner-1", role: "USER" }, prisma);
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/cproject000000000000000001/scheduled-tasks",
      payload: { name: "t", command: "echo hi", schedule: "* * * * *" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("QUOTA_EXCEEDED");
  });
});

describe("scheduled task routes — task detail scoping", () => {
  it("404s when the task belongs to a different project", async () => {
    const prisma = createPrisma();
    prisma.scheduledTask.findUnique.mockResolvedValue({ id: "ctask00000000000000000001", projectId: "other-project" });
    const app = await buildApp({ userId: "owner-1", role: "USER" }, prisma);
    const res = await app.inject({ method: "GET", url: "/api/projects/cproject000000000000000001/scheduled-tasks/ctask00000000000000000001" });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("TASK_NOT_FOUND");
  });
});
