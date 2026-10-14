// Runs against a real Postgres, because what needs proving here is the database behaviour:
// cascades, counts, ordering, retention and the shape of every query.
//   SCHEDULED_TASK_TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/db pnpm exec vitest run <this file>
// The database must already have the migrations applied (prisma migrate deploy).
// Without that variable the whole file is skipped, so ordinary `pnpm test` needs no database.
// Redis, BullMQ and Docker are replaced by fakes here; the live test in docs/dev/scheduled-tasks.md
// covers the real ones.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

vi.setConfig({ testTimeout: 60_000 });

const databaseUrl = process.env.SCHEDULED_TASK_TEST_DATABASE_URL;
process.env.DATABASE_URL = databaseUrl ?? "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const notifyUser = vi.fn();
vi.mock("../system-email/notifier.js", () => ({ notifyUser: (...args: unknown[]) => notifyUser(...args) }));

const { ScheduledTaskService, ScheduledTaskError } = await import("./service.js");
const { registerScheduledTaskQueue, removeTasksForProject, schedulerIdFor } = await import("./scheduler.js");
const { AuditLogService } = await import("../audit-log/service.js");
import type { ExecRequest, ExecResult } from "./exec.js";

/** Just enough of ioredis for the lock and the boot sweep. */
class FakeRedis {
  store = new Map<string, string>();
  async set(key: string, value: string, _mode: "PX", _ttl: number, _nx: "NX") {
    if (this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async eval(_script: string, _numKeys: number, key: string, token: string) {
    if (this.store.get(key) === token) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }
  async scan(_cursor: string, _match: "MATCH", pattern: string, _count: "COUNT", _n: number): Promise<[string, string[]]> {
    const prefix = pattern.replace("*", "");
    return ["0", [...this.store.keys()].filter((key) => key.startsWith(prefix))];
  }
  async del(...keys: string[]) {
    keys.forEach((key) => this.store.delete(key));
    return keys.length;
  }
}

const schedulers = new Map<string, { pattern: string; tz: string }>();
const fakeQueue = {
  upsertJobScheduler: vi.fn(async (id: string, repeat: { pattern: string; tz: string }) => {
    schedulers.set(id, repeat);
  }),
  removeJobScheduler: vi.fn(async (id: string) => {
    schedulers.delete(id);
    return true;
  }),
  add: vi.fn(async () => undefined),
  getJobSchedulers: vi.fn(async () => [...schedulers.keys()].map((key) => ({ key }))),
};
registerScheduledTaskQueue(fakeQueue as never);

const ok: ExecResult = { status: "success", exitCode: 0, output: "hello\n", truncated: false, reason: null };
const fail: ExecResult = { status: "failed", exitCode: 1, output: "boom", truncated: false, reason: null };
const timeout: ExecResult = { status: "timeout", exitCode: null, output: "partial", truncated: false, reason: null };
let queued: ExecResult[] = [];
const runner = vi.fn(async (_request: ExecRequest): Promise<ExecResult> => queued.shift() ?? ok);
let timezone = "UTC";
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

describe.skipIf(!databaseUrl)("ScheduledTaskService against Postgres", () => {
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const redis = new FakeRedis();
  const service = new ScheduledTaskService(prisma, redis, new AuditLogService(prisma, logger as never), logger as never, runner, async () => timezone);
  const userIds: string[] = [];

  const body = (overrides: Record<string, unknown> = {}) => ({
    name: "Nightly report",
    command: "node report.js",
    schedule: "0 3 * * *",
    timeoutSeconds: 300,
    enabled: true,
    notifyOnFailure: true,
    ...overrides,
  });

  async function fixture(projectType: "NODEJS" | "STATIC" | "REACT" | "PHP" = "NODEJS", userData: Record<string, unknown> = {}) {
    const id = randomBytes(4).toString("hex");
    const user = await prisma.user.create({ data: { email: `owner-${id}@task-test.local`, name: "Owner", password: "x", ...userData } });
    userIds.push(user.id);
    const project = await prisma.project.create({ data: { name: `Shop ${id}`, type: projectType, status: "ACTIVE", userId: user.id } });
    return { user, project };
  }
  const create = async (f: { user: { id: string }; project: { id: string } }, overrides: Record<string, unknown> = {}) =>
    service.create(f.user.id, f.project.id, body(overrides) as never);
  const runsOf = (taskId: string) => prisma.scheduledTaskRun.findMany({ where: { taskId }, orderBy: { startedAt: "asc" } });
  const taskOf = (taskId: string) => prisma.scheduledTask.findUniqueOrThrow({ where: { id: taskId } });
  const expectError = async (promise: Promise<unknown>, code: string, status: number) => {
    const error = await promise.then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ScheduledTaskError);
    expect(error).toMatchObject({ code, statusCode: status });
  };

  beforeEach(() => {
    queued = [];
    timezone = "UTC";
    redis.store.clear();
    schedulers.clear();
    runner.mockClear();
    notifyUser.mockClear();
    fakeQueue.upsertJobScheduler.mockClear();
    fakeQueue.removeJobScheduler.mockClear();
    fakeQueue.add.mockClear();
    logger.error.mockClear();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  describe("creating and listing", () => {
    it("stores the task, arms its schedule in the server timezone and reports the next run", async () => {
      timezone = "America/New_York";
      const f = await fixture();
      const task = await create(f);

      expect(task).toMatchObject({ name: "Nightly report", enabled: true, timeoutSeconds: 300, consecutiveFailures: 0, lastStatus: null });
      expect(fakeQueue.upsertJobScheduler).toHaveBeenCalledWith(
        schedulerIdFor(task.id),
        { pattern: "0 3 * * *", tz: "America/New_York" },
        expect.objectContaining({ data: { taskId: task.id, trigger: "SCHEDULED" } }),
      );
      // 03:00 in New York is never 03:00 UTC.
      expect(new Date(task.nextRunAt!).getUTCHours()).not.toBe(3);

      const list = await service.list(f.user.id, f.project.id);
      expect(list).toMatchObject({ timezone: "America/New_York", supported: true, quota: { used: 1, limit: null } });
      expect(list.tasks).toHaveLength(1);
    });

    it("asks BullMQ not to keep a record of every firing, which would pile up in Redis forever", async () => {
      const f = await fixture();
      await create(f);
      const template = (fakeQueue.upsertJobScheduler.mock.calls[0] as unknown[])[2] as { opts: { removeOnComplete: boolean; removeOnFail: { count: number } } };
      expect(template.opts.removeOnComplete).toBe(true);
      expect(template.opts.removeOnFail.count).toBeGreaterThan(0);
    });

    it("a disabled task is saved but not armed and has no next run", async () => {
      const f = await fixture();
      const task = await create(f, { enabled: false });
      expect(fakeQueue.upsertJobScheduler).not.toHaveBeenCalled();
      expect(task.nextRunAt).toBeNull();
    });

    it("rejects a schedule that has the right shape but impossible values", async () => {
      const f = await fixture();
      await expectError(create(f, { schedule: "61 * * * *" }), "INVALID_SCHEDULE", 400);
      await expectError(create(f, { schedule: "0 0 31 2 *" }), "INVALID_SCHEDULE", 400);
      expect(await prisma.scheduledTask.count({ where: { projectId: f.project.id } })).toBe(0);
    });

    it.each(["STATIC", "REACT"] as const)("refuses %s projects, which have no runtime to run a command in", async (type) => {
      const f = await fixture(type);
      await expectError(create(f), "UNSUPPORTED_PROJECT_TYPE", 400);
      expect((await service.list(f.user.id, f.project.id)).supported).toBe(false);
    });

    it("keeps the command out of the audit log, which could otherwise leak a secret typed into it", async () => {
      const f = await fixture();
      const task = await create(f, { command: "curl -H 'Authorization: Bearer s3cr3t-token' https://api.example.com" });
      await service.update(f.user.id, f.project.id, task.id, { command: "echo changed s3cr3t-token-2" });
      await service.remove(f.user.id, f.project.id, task.id);

      const entries = await prisma.auditLog.findMany({ where: { targetId: task.id }, orderBy: { createdAt: "asc" } });
      expect(entries.map((e) => e.action)).toEqual(["scheduled_task.created", "scheduled_task.updated", "scheduled_task.deleted"]);
      const dump = JSON.stringify(entries);
      expect(dump).not.toContain("s3cr3t");
      expect(dump).toContain("commandChanged");
    });
  });

  describe("quota", () => {
    it("refuses creation at the limit with QUOTA_EXCEEDED and warns the user at 100%", async () => {
      const f = await fixture("NODEJS", { maxScheduledTasks: 1 });
      await create(f);
      await expectError(create(f, { name: "second" }), "QUOTA_EXCEEDED", 403);
      await vi.waitFor(() => expect(notifyUser).toHaveBeenCalledWith("quota_warning", expect.any(String), expect.objectContaining({ resource: "scheduledTask", level: 100 })));
      expect((await service.list(f.user.id, f.project.id)).quota).toEqual({ used: 1, limit: 1 });
    });

    it("counts a user's tasks across all of their projects, and unlimited means unlimited", async () => {
      const f = await fixture("NODEJS", { maxScheduledTasks: 2 });
      const second = await prisma.project.create({ data: { name: "Other", type: "NODEJS", status: "ACTIVE", userId: f.user.id } });
      await create(f);
      await service.create(f.user.id, second.id, body({ name: "b" }) as never);
      await expectError(service.create(f.user.id, second.id, body({ name: "c" }) as never), "QUOTA_EXCEEDED", 403);

      const free = await fixture();
      for (let i = 0; i < 5; i += 1) await create(free, { name: `t${i}` });
      expect((await service.list(free.user.id, free.project.id)).tasks).toHaveLength(5);
    });
  });

  describe("ownership", () => {
    it("another user gets 403 on every operation, an unknown project 404, a task from another project 404", async () => {
      const owner = await fixture();
      const stranger = await fixture();
      const task = await create(owner);
      const ids = [stranger.user.id, owner.project.id] as const;

      await expectError(service.list(...ids), "FORBIDDEN", 403);
      await expectError(service.create(...ids, body() as never), "FORBIDDEN", 403);
      await expectError(service.update(...ids, task.id, { name: "x" }), "FORBIDDEN", 403);
      await expectError(service.remove(...ids, task.id), "FORBIDDEN", 403);
      await expectError(service.runNow(...ids, task.id), "FORBIDDEN", 403);
      await expectError(service.listRuns(...ids, task.id, 10), "FORBIDDEN", 403);
      await expectError(service.previewSchedule(...ids, "* * * * *"), "FORBIDDEN", 403);

      await expectError(service.list(owner.user.id, "no-such-project"), "PROJECT_NOT_FOUND", 404);
      // The caller owns the project in the path, but the task belongs to a different project.
      await expectError(service.update(stranger.user.id, stranger.project.id, task.id, { name: "x" }), "TASK_NOT_FOUND", 404);
      await expectError(service.remove(stranger.user.id, stranger.project.id, task.id), "TASK_NOT_FOUND", 404);

      expect((await taskOf(task.id)).name).toBe("Nightly report");
      expect(fakeQueue.add).not.toHaveBeenCalled();
    });

    it("a soft-deleted project is not found", async () => {
      const f = await fixture();
      await prisma.project.update({ where: { id: f.project.id }, data: { status: "DELETED", deletedAt: new Date() } });
      await expectError(service.list(f.user.id, f.project.id), "PROJECT_NOT_FOUND", 404);
    });
  });

  describe("updating and deleting", () => {
    it("disabling removes the schedule, re-enabling restores it and starts a fresh failure streak", async () => {
      const f = await fixture();
      const task = await create(f);
      await prisma.scheduledTask.update({ where: { id: task.id }, data: { consecutiveFailures: 2 } });

      await service.update(f.user.id, f.project.id, task.id, { enabled: false });
      expect(schedulers.has(schedulerIdFor(task.id))).toBe(false);
      expect((await taskOf(task.id)).consecutiveFailures).toBe(2);

      const again = await service.update(f.user.id, f.project.id, task.id, { enabled: true });
      expect(schedulers.get(schedulerIdFor(task.id))).toEqual({ pattern: "0 3 * * *", tz: "UTC" });
      expect(again.consecutiveFailures).toBe(0);
    });

    it("changing the schedule re-arms with the new pattern; changing the command resets the streak; renaming does not", async () => {
      const f = await fixture();
      const task = await create(f);
      await prisma.scheduledTask.update({ where: { id: task.id }, data: { consecutiveFailures: 2 } });

      await service.update(f.user.id, f.project.id, task.id, { schedule: "*/10 * * * *" });
      expect(schedulers.get(schedulerIdFor(task.id))?.pattern).toBe("*/10 * * * *");
      await service.update(f.user.id, f.project.id, task.id, { name: "Renamed" });
      expect((await taskOf(task.id)).consecutiveFailures).toBe(2);
      await service.update(f.user.id, f.project.id, task.id, { command: "node other.js" });
      expect((await taskOf(task.id)).consecutiveFailures).toBe(0);
      await expectError(service.update(f.user.id, f.project.id, task.id, { schedule: "99 * * * *" }), "INVALID_SCHEDULE", 400);
      expect(schedulers.get(schedulerIdFor(task.id))?.pattern).toBe("*/10 * * * *");
    });

    it("deleting removes the task, its runs and its schedule", async () => {
      const f = await fixture();
      const task = await create(f);
      await service.execute(task.id, "SCHEDULED");
      await service.remove(f.user.id, f.project.id, task.id);

      expect(await prisma.scheduledTask.count({ where: { id: task.id } })).toBe(0);
      expect(await prisma.scheduledTaskRun.count({ where: { taskId: task.id } })).toBe(0);
      expect(schedulers.has(schedulerIdFor(task.id))).toBe(false);
    });

    it("deleting a project's tasks (project delete) removes rows and schedules", async () => {
      const f = await fixture();
      const a = await create(f);
      const b = await create(f, { name: "b" });
      await removeTasksForProject(prisma, f.project.id, logger as never);
      expect(await prisma.scheduledTask.count({ where: { projectId: f.project.id } })).toBe(0);
      expect(schedulers.has(schedulerIdFor(a.id)) || schedulers.has(schedulerIdFor(b.id))).toBe(false);
    });
  });

  describe("running", () => {
    it("records a successful run with status, exit code, output and duration, and passes the command to the container only", async () => {
      const f = await fixture();
      const task = await create(f, { command: "echo hello", timeoutSeconds: 42 });
      await service.execute(task.id, "SCHEDULED");

      const [run] = await runsOf(task.id);
      expect(run).toMatchObject({ trigger: "SCHEDULED", status: "SUCCESS", exitCode: 0, output: "hello\n" });
      expect(run!.finishedAt).not.toBeNull();
      const request = runner.mock.calls[0]![0];
      expect(request).toMatchObject({ shellCommand: "echo hello", timeoutSeconds: 42, runId: run!.id });
      expect(request.projectDir.endsWith(f.project.id)).toBe(true);
      expect((await taskOf(task.id)).lastRunAt).not.toBeNull();
      expect((await service.list(f.user.id, f.project.id)).tasks[0]!.lastStatus).toBe("SUCCESS");
    });

    it("run now is queued as MANUAL, audited, and works on a disabled task", async () => {
      const f = await fixture();
      const task = await create(f, { enabled: false });
      expect(await service.runNow(f.user.id, f.project.id, task.id)).toEqual({ queued: true });
      expect(fakeQueue.add).toHaveBeenCalledWith("scheduled-task-manual", { taskId: task.id, trigger: "MANUAL" }, expect.anything());
      expect(await prisma.auditLog.count({ where: { targetId: task.id, action: "scheduled_task.run_manual" } })).toBe(1);

      await service.execute(task.id, "MANUAL");
      expect((await runsOf(task.id))[0]).toMatchObject({ trigger: "MANUAL", status: "SUCCESS" });
    });

    it("a scheduled firing of a disabled task is dropped and its job removed", async () => {
      const f = await fixture();
      const task = await create(f, { enabled: false });
      await service.execute(task.id, "SCHEDULED");
      expect(runner).not.toHaveBeenCalled();
      expect(await runsOf(task.id)).toHaveLength(0);
      expect(fakeQueue.removeJobScheduler).toHaveBeenCalledWith(schedulerIdFor(task.id));
    });

    it("a firing for a task that no longer exists cleans up its own job without throwing", async () => {
      await expect(service.execute("gone-task", "SCHEDULED")).resolves.toBeUndefined();
      expect(fakeQueue.removeJobScheduler).toHaveBeenCalledWith(schedulerIdFor("gone-task"));
      expect(runner).not.toHaveBeenCalled();
    });

    it("never runs a task whose project was deleted or changed hands", async () => {
      const f = await fixture();
      const task = await create(f);
      await prisma.project.update({ where: { id: f.project.id }, data: { status: "DELETED", deletedAt: new Date() } });
      await service.execute(task.id, "SCHEDULED");
      expect(runner).not.toHaveBeenCalled();

      const g = await fixture();
      const other = await create(g);
      const thief = await fixture();
      await prisma.project.update({ where: { id: g.project.id }, data: { userId: thief.user.id } });
      await service.execute(other.id, "MANUAL");
      expect(runner).not.toHaveBeenCalled();
    });

    it("a task deleted while its command is running is not an error, and its lock is still released", async () => {
      const f = await fixture();
      const task = await create(f);
      runner.mockImplementationOnce(async () => {
        await prisma.scheduledTask.delete({ where: { id: task.id } });
        return ok;
      });
      await expect(service.execute(task.id, "SCHEDULED")).resolves.toBeUndefined();
      expect(redis.store.size).toBe(0);
      expect(notifyUser).not.toHaveBeenCalled();
    });

    it("a run that overlaps the previous one is recorded as SKIPPED without running, and does not free the lock", async () => {
      const f = await fixture();
      const task = await create(f);
      redis.store.set(`scheduled-task-lock:${task.id}`, "someone-else");
      await service.execute(task.id, "SCHEDULED");

      expect(runner).not.toHaveBeenCalled();
      expect((await runsOf(task.id))[0]).toMatchObject({ status: "SKIPPED", output: expect.stringContaining("still running") });
      expect(redis.store.get(`scheduled-task-lock:${task.id}`)).toBe("someone-else");
      await expectError(service.runNow(f.user.id, f.project.id, task.id), "TASK_RUNNING", 409);
      expect(fakeQueue.add).not.toHaveBeenCalled();
    });

    it("releases the lock after a run, including one whose runner blew up", async () => {
      const f = await fixture();
      const task = await create(f);
      await service.execute(task.id, "SCHEDULED");
      expect(redis.store.size).toBe(0);

      runner.mockRejectedValueOnce(new Error("spawn failed"));
      await service.execute(task.id, "SCHEDULED");
      expect(redis.store.size).toBe(0);
      expect((await runsOf(task.id)).at(-1)).toMatchObject({ status: "FAILED" });
    });

    it("a run skipped because the project isn't running is SKIPPED, not failed, and leaves the streak and last-run time alone", async () => {
      const f = await fixture();
      const task = await create(f);
      await prisma.scheduledTask.update({ where: { id: task.id }, data: { consecutiveFailures: 2 } });
      queued = [{ status: "skipped", exitCode: null, output: "", truncated: false, reason: "NOT_RUNNING" }];
      await service.execute(task.id, "SCHEDULED");

      expect((await runsOf(task.id))[0]).toMatchObject({ status: "SKIPPED", output: expect.stringContaining("isn't running") });
      const after = await taskOf(task.id);
      expect(after.consecutiveFailures).toBe(2);
      expect(after.lastRunAt).toBeNull();
      expect(notifyUser).not.toHaveBeenCalled();
    });

    it("strips NUL characters, which Postgres cannot store, and marks truncated output", async () => {
      const f = await fixture();
      const task = await create(f);
      queued = [{ status: "success", exitCode: 0, output: "a\u0000b", truncated: true, reason: null }];
      await service.execute(task.id, "SCHEDULED");
      const [run] = await runsOf(task.id);
      expect(run!.output.startsWith("ab")).toBe(true);
      expect(run!.output).toContain("[output truncated]");
    });

    it("keeps only the latest 50 runs per task, and prunes skipped runs too", async () => {
      const f = await fixture();
      const task = await create(f);
      for (let i = 0; i < 53; i += 1) {
        queued = [{ status: "success", exitCode: 0, output: `run ${i}`, truncated: false, reason: null }];
        await service.execute(task.id, "SCHEDULED");
      }
      redis.store.set(`scheduled-task-lock:${task.id}`, "busy");
      for (let i = 0; i < 3; i += 1) await service.execute(task.id, "SCHEDULED");

      const runs = await runsOf(task.id);
      expect(runs).toHaveLength(50);
      expect(runs.at(-1)!.status).toBe("SKIPPED");
      expect(runs.some((run) => run.output === "run 0")).toBe(false);
      expect((await service.listRuns(f.user.id, f.project.id, task.id, 5))).toHaveLength(5);
    });
  });

  describe("failure emails", () => {
    const failures = async (taskId: string, results: ExecResult[]) => {
      for (const result of results) {
        queued = [result];
        await service.execute(taskId, "SCHEDULED");
      }
    };
    const emails = () => notifyUser.mock.calls.filter(([event]) => event === "scheduled_task_failed");

    it("sends exactly one email on the third failure in a row, none for the fourth, and a second after a success then three more", async () => {
      const f = await fixture();
      const task = await create(f);
      await failures(task.id, [fail, fail]);
      expect(emails()).toHaveLength(0);
      await failures(task.id, [fail]);
      expect(emails()).toHaveLength(1);
      expect(emails()[0]).toEqual([
        "scheduled_task_failed",
        expect.stringContaining("@task-test.local"),
        expect.objectContaining({ taskName: "Nightly report", projectId: f.project.id, status: "FAILED", failures: 3 }),
      ]);
      await failures(task.id, [fail, fail]);
      expect(emails()).toHaveLength(1);

      await failures(task.id, [ok]);
      expect((await taskOf(task.id)).consecutiveFailures).toBe(0);
      await failures(task.id, [fail, fail, fail]);
      expect(emails()).toHaveLength(2);
    });

    it("counts timeouts as failures, ignores skipped runs in the streak, and never puts the output in the email", async () => {
      const f = await fixture();
      const task = await create(f);
      const skipped: ExecResult = { status: "skipped", exitCode: null, output: "", truncated: false, reason: "NOT_RUNNING" };
      await failures(task.id, [timeout, skipped, fail, skipped, timeout]);
      expect(emails()).toHaveLength(1);
      expect(emails()[0]![2]).toMatchObject({ status: "TIMEOUT", failures: 3 });
      expect(JSON.stringify(notifyUser.mock.calls)).not.toContain("partial");
    });

    it("stays silent when the task has notifications switched off", async () => {
      const f = await fixture();
      const task = await create(f, { notifyOnFailure: false });
      await failures(task.id, [fail, fail, fail, fail]);
      expect(emails()).toHaveLength(0);
    });
  });

  describe("schedule preview", () => {
    it("returns the next five run times in the server timezone and rejects nonsense", async () => {
      timezone = "Asia/Karachi";
      const f = await fixture();
      const preview = await service.previewSchedule(f.user.id, f.project.id, "0 9 * * *");
      expect(preview.timezone).toBe("Asia/Karachi");
      expect(preview.nextRuns).toHaveLength(5);
      // 09:00 in Karachi (UTC+5) is 04:00 UTC.
      expect(new Date(preview.nextRuns[0]!).getUTCHours()).toBe(4);
      await expectError(service.previewSchedule(f.user.id, f.project.id, "70 9 * * *"), "INVALID_SCHEDULE", 400);
    });
  });

  describe("restoring after a restart", () => {
    it("closes interrupted runs, frees stale locks, re-arms enabled tasks and drops jobs for vanished or disabled ones", async () => {
      const f = await fixture();
      const live = await create(f);
      const off = await create(f, { name: "off", enabled: false });
      const stuck = await prisma.scheduledTaskRun.create({ data: { taskId: live.id, trigger: "SCHEDULED", status: "RUNNING" } });
      redis.store.set(`scheduled-task-lock:${live.id}`, "dead-process");
      redis.store.set("unrelated-key", "keep");
      schedulers.clear();
      schedulers.set(schedulerIdFor("deleted-task"), { pattern: "* * * * *", tz: "UTC" });
      schedulers.set(schedulerIdFor(off.id), { pattern: "* * * * *", tz: "UTC" });
      schedulers.set("some-other-scheduler", { pattern: "* * * * *", tz: "UTC" });
      timezone = "Europe/London";

      const result = await service.reconcile();
      expect(result.interrupted).toBeGreaterThanOrEqual(1);
      expect((await prisma.scheduledTaskRun.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe("FAILED");
      expect(redis.store.has(`scheduled-task-lock:${live.id}`)).toBe(false);
      expect(redis.store.get("unrelated-key")).toBe("keep");
      expect(schedulers.get(schedulerIdFor(live.id))).toEqual({ pattern: "0 3 * * *", tz: "Europe/London" });
      expect(schedulers.has(schedulerIdFor("deleted-task"))).toBe(false);
      expect(schedulers.has(schedulerIdFor(off.id))).toBe(false);
      expect(schedulers.has("some-other-scheduler")).toBe(true);
    });
  });

  describe("cascade", () => {
    it("deleting the user removes their projects' tasks and runs", async () => {
      const f = await fixture();
      const task = await create(f);
      await service.execute(task.id, "SCHEDULED");
      await prisma.user.delete({ where: { id: f.user.id } });
      expect(await prisma.scheduledTask.count({ where: { id: task.id } })).toBe(0);
      expect(await prisma.scheduledTaskRun.count({ where: { taskId: task.id } })).toBe(0);
    });
  });
});
