import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

// No Redis in a unit test: the queue and worker are stand-ins.
vi.mock("../../config/queue.js", () => ({
  createQueue: () => ({}),
  createWorker: () => ({}),
}));

const fakeService = {
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  runNow: vi.fn(),
  listRuns: vi.fn(),
  previewSchedule: vi.fn(),
  execute: vi.fn(),
  reconcile: vi.fn(async () => ({ interrupted: 0, armed: 0, pruned: 0 })),
};
vi.mock("./service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service.js")>();
  return {
    ...actual,
    ScheduledTaskService: class {
      constructor() {
        return fakeService;
      }
    },
  };
});

const { scheduledTaskRoutes } = await import("./routes.js");
const { ScheduledTaskError } = await import("./service.js");
const { errorHandlerPlugin } = await import("../../plugins/error-handler.js");

async function buildApp(userId: string | null) {
  const app = Fastify();
  app.decorate("prisma", {} as never);
  app.decorate("redis", {} as never);
  app.decorate("registerQueue", (() => undefined) as never);
  app.decorate("requireAuth", (async (request: FastifyRequest, reply: FastifyReply) => {
    if (!userId) return reply.status(401).send({ error: "Authentication required", code: "UNAUTHORIZED", details: {} });
    request.userId = userId;
  }) as never);
  app.decorateRequest("userId", null);
  await app.register(errorHandlerPlugin);
  await app.register(scheduledTaskRoutes, { prefix: "/api/projects" });
  return app as unknown as FastifyInstance;
}

const TASK = { name: "Nightly report", command: "node report.js", schedule: "0 3 * * *" };
const BASE = "/api/projects/p1/scheduled-tasks";

type Call = { method: "GET" | "POST" | "PUT" | "DELETE"; url: string; payload?: unknown };
const ALL_ROUTES: Call[] = [
  { method: "GET", url: BASE },
  { method: "POST", url: BASE, payload: TASK },
  { method: "POST", url: `${BASE}/preview`, payload: { schedule: "* * * * *" } },
  { method: "PUT", url: `${BASE}/t1`, payload: { enabled: false } },
  { method: "DELETE", url: `${BASE}/t1` },
  { method: "POST", url: `${BASE}/t1/run` },
  { method: "GET", url: `${BASE}/t1/runs` },
];

beforeEach(() => {
  for (const mock of Object.values(fakeService)) mock.mockClear();
  fakeService.reconcile.mockResolvedValue({ interrupted: 0, armed: 0, pruned: 0 });
});

describe("authentication", () => {
  it.each(ALL_ROUTES)("returns 401 for $method $url when signed out, without touching the service", async ({ method, url, payload }) => {
    const app = await buildApp(null);
    const res = await app.inject({ method, url, payload: payload as never });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "UNAUTHORIZED" });
    for (const mock of [fakeService.list, fakeService.create, fakeService.update, fakeService.remove, fakeService.runNow, fakeService.listRuns, fakeService.previewSchedule]) {
      expect(mock).not.toHaveBeenCalled();
    }
  });
});

describe("happy paths", () => {
  it("lists tasks for the signed-in user and the project in the path", async () => {
    fakeService.list.mockResolvedValue({ tasks: [], timezone: "UTC", quota: { used: 0, limit: null }, supported: true });
    const app = await buildApp("u1");
    const res = await app.inject({ method: "GET", url: BASE });
    expect(res.statusCode).toBe(200);
    expect(fakeService.list).toHaveBeenCalledWith("u1", "p1");
  });

  it("creates with 201, passing the parsed body with its defaults", async () => {
    fakeService.create.mockResolvedValue({ id: "t1", ...TASK });
    const app = await buildApp("u1");
    const res = await app.inject({ method: "POST", url: BASE, payload: TASK });
    expect(res.statusCode).toBe(201);
    expect(fakeService.create).toHaveBeenCalledWith("u1", "p1", { ...TASK, timeoutSeconds: 300, enabled: true, notifyOnFailure: true });
  });

  it("updates, deletes (204), queues a run (202), lists runs and previews a schedule", async () => {
    fakeService.update.mockResolvedValue({ id: "t1" });
    fakeService.runNow.mockResolvedValue({ queued: true });
    fakeService.listRuns.mockResolvedValue([]);
    fakeService.previewSchedule.mockResolvedValue({ timezone: "UTC", nextRuns: [] });
    const app = await buildApp("u1");

    expect((await app.inject({ method: "PUT", url: `${BASE}/t1`, payload: { enabled: false } })).statusCode).toBe(200);
    expect(fakeService.update).toHaveBeenCalledWith("u1", "p1", "t1", { enabled: false });
    expect((await app.inject({ method: "DELETE", url: `${BASE}/t1` })).statusCode).toBe(204);
    expect(fakeService.remove).toHaveBeenCalledWith("u1", "p1", "t1");
    const run = await app.inject({ method: "POST", url: `${BASE}/t1/run` });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toEqual({ queued: true });
    const runs = await app.inject({ method: "GET", url: `${BASE}/t1/runs?limit=5` });
    expect(runs.json()).toEqual({ runs: [] });
    expect(fakeService.listRuns).toHaveBeenCalledWith("u1", "p1", "t1", 5);
    const preview = await app.inject({ method: "POST", url: `${BASE}/preview`, payload: { schedule: "*/5 * * * *" } });
    expect(preview.statusCode).toBe(200);
    expect(fakeService.previewSchedule).toHaveBeenCalledWith("u1", "p1", "*/5 * * * *");
  });
});

describe("errors", () => {
  it.each([
    [403, "FORBIDDEN"],
    [404, "TASK_NOT_FOUND"],
    [409, "TASK_RUNNING"],
    [403, "QUOTA_EXCEEDED"],
    [400, "INVALID_SCHEDULE"],
  ])("returns the service's %i %s in the standard error shape", async (status, code) => {
    fakeService.runNow.mockRejectedValue(new ScheduledTaskError("Nope", code, status));
    const app = await buildApp("u1");
    const res = await app.inject({ method: "POST", url: `${BASE}/t1/run` });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: "Nope", code, details: {} });
  });

  it("does not leak unexpected errors", async () => {
    fakeService.list.mockRejectedValue(new Error("connection string postgres://secret"));
    const app = await buildApp("u1");
    const res = await app.inject({ method: "GET", url: BASE });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret");
  });
});

describe("validation happens before the service is called", () => {
  it.each([
    ["a six-field (seconds) schedule", { ...TASK, schedule: "* * * * * *" }],
    ["a 5,000-character command", { ...TASK, command: "x".repeat(5000) }],
    ["a missing name", { command: TASK.command, schedule: TASK.schedule }],
    ["a timeout of 0", { ...TASK, timeoutSeconds: 0 }],
    ["a timeout over an hour", { ...TASK, timeoutSeconds: 3601 }],
  ])("rejects %s with 400", async (_label, payload) => {
    const app = await buildApp("u1");
    const res = await app.inject({ method: "POST", url: BASE, payload });
    expect(res.statusCode).toBe(400);
    expect(fakeService.create).not.toHaveBeenCalled();
  });

  it("rejects an empty update and an out-of-range history limit", async () => {
    const app = await buildApp("u1");
    expect((await app.inject({ method: "PUT", url: `${BASE}/t1`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `${BASE}/t1/runs?limit=500` })).statusCode).toBe(400);
    expect(fakeService.update).not.toHaveBeenCalled();
    expect(fakeService.listRuns).not.toHaveBeenCalled();
  });
});

describe("startup", () => {
  it("restores schedules when the routes register, and survives that failing", async () => {
    await buildApp("u1");
    expect(fakeService.reconcile).toHaveBeenCalledTimes(1);

    fakeService.reconcile.mockRejectedValueOnce(new Error("redis down"));
    await expect(buildApp("u1")).resolves.toBeDefined();
  });
});
