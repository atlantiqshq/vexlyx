import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Prisma, PrismaClient, ScheduledTaskStatus } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import {
  SCHEDULED_TASK_FAILURE_EMAIL_AFTER,
  SCHEDULED_TASK_RUNS_KEPT,
  SCHEDULED_TASK_UNSUPPORTED_PROJECT_TYPES,
  type CreateScheduledTaskInput,
  type SchedulePreviewResponse,
  type ScheduledTaskListResponse,
  type ScheduledTaskResponse,
  type ScheduledTaskRunResponse,
  type UpdateScheduledTaskInput,
} from "@vexlyx/shared";
import { env } from "../../config/env.js";
import { assertUnderQuota, notifyQuotaThreshold } from "../../utils/quota.js";
import type { AuditLogService } from "../audit-log/service.js";
import { notifyUser } from "../system-email/notifier.js";
import { explainInvalidSchedule, nextRuns } from "./cron.js";
import type { ExecResult, TaskRunner } from "./exec.js";
import { armTask, disarmTask, enqueueManualRun, pruneOrphanSchedulers, rearmAllTasks } from "./scheduler.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ScheduledTaskError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "ScheduledTaskError";
  }
}

// ---------------------------------------------------------------------------
// Collaborators
// ---------------------------------------------------------------------------

/** The slice of ioredis this service uses, so tests can supply a small fake. */
export interface TaskRedis {
  set(key: string, value: string, mode: "PX", ttl: number, nx: "NX"): Promise<unknown>;
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  scan(cursor: string, match: "MATCH", pattern: string, count: "COUNT", n: number): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<unknown>;
}

const LOCK_PREFIX = "scheduled-task-lock:";
const lockKey = (taskId: string) => `${LOCK_PREFIX}${taskId}`;
/** A lock that outlives its run only if the API died; this is how long a crashed run can block the next one. */
const LOCK_GRACE_SECONDS = 120;
const RELEASE_LOCK = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
const NEXT_RUNS_SHOWN = 5;

const SKIP_MESSAGES: Record<string, string> = {
  NOT_RUNNING: "Skipped: the project's container isn't running.",
  NOT_DEPLOYED: "Skipped: the project hasn't been deployed yet.",
};

const STATUS_FROM_EXEC: Record<ExecResult["status"], ScheduledTaskStatus> = {
  success: "SUCCESS",
  failed: "FAILED",
  timeout: "TIMEOUT",
  skipped: "SKIPPED",
};

type TaskWithLastRun = Prisma.ScheduledTaskGetPayload<{ include: { runs: { select: { status: true } } } }>;

const RUN_INCLUDE = {
  project: { select: { id: true, name: true, userId: true, status: true, deletedAt: true } },
  user: { select: { email: true, name: true } },
} satisfies Prisma.ScheduledTaskInclude;

type TaskForRun = Prisma.ScheduledTaskGetPayload<{ include: typeof RUN_INCLUDE }>;

const LAST_RUN_INCLUDE = { runs: { orderBy: { startedAt: "desc" }, take: 1, select: { status: true } } } satisfies Prisma.ScheduledTaskInclude;

/** Prisma's "record not found" (P2025) and foreign-key (P2003) errors: the row was deleted underneath us. */
const isRowGone = (err: unknown) =>
  typeof err === "object" && err !== null && "code" in err && ((err as { code: unknown }).code === "P2025" || (err as { code: unknown }).code === "P2003");

/** Postgres text columns reject NUL, which a command's output can contain. */
const stripNul = (text: string) => text.split("\u0000").join("");

export class ScheduledTaskService {
  constructor(
    private prisma: PrismaClient,
    private redis: TaskRedis,
    private auditLog: AuditLogService,
    private logger: FastifyBaseLogger,
    private runner: TaskRunner,
    private getTimezone: () => Promise<string>,
  ) {}

  // -------------------------------------------------------------------------
  // Ownership
  // -------------------------------------------------------------------------

  private async ownedProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, type: true, status: true, userId: true, deletedAt: true },
    });
    if (!project || project.deletedAt !== null || project.status === "DELETED") {
      throw new ScheduledTaskError("Project not found", "PROJECT_NOT_FOUND", 404);
    }
    if (project.userId !== userId) {
      throw new ScheduledTaskError("You do not have access to this project", "FORBIDDEN", 403);
    }
    return project;
  }

  private async ownedTask(userId: string, projectId: string, taskId: string) {
    const project = await this.ownedProject(userId, projectId);
    const task = await this.prisma.scheduledTask.findFirst({ where: { id: taskId, projectId } });
    if (!task) throw new ScheduledTaskError("Scheduled task not found", "TASK_NOT_FOUND", 404);
    return { project, task };
  }

  private async assertScheduleIsValid(schedule: string, tz: string): Promise<void> {
    const problem = explainInvalidSchedule(schedule, tz);
    if (problem) throw new ScheduledTaskError(`That schedule isn't valid: ${problem}`, "INVALID_SCHEDULE", 400);
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private toResponse(task: TaskWithLastRun, tz: string): ScheduledTaskResponse {
    return {
      id: task.id,
      projectId: task.projectId,
      name: task.name,
      command: task.command,
      schedule: task.schedule,
      timeoutSeconds: task.timeoutSeconds,
      enabled: task.enabled,
      notifyOnFailure: task.notifyOnFailure,
      consecutiveFailures: task.consecutiveFailures,
      lastRunAt: task.lastRunAt?.toISOString() ?? null,
      lastStatus: task.runs[0]?.status ?? null,
      nextRunAt: task.enabled ? (nextRuns(task.schedule, tz, 1)[0]?.toISOString() ?? null) : null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    };
  }

  private toRunResponse(run: Prisma.ScheduledTaskRunGetPayload<object>): ScheduledTaskRunResponse {
    return {
      id: run.id,
      taskId: run.taskId,
      trigger: run.trigger,
      status: run.status,
      exitCode: run.exitCode,
      output: run.output,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
    };
  }

  // -------------------------------------------------------------------------
  // Management (called from routes)
  // -------------------------------------------------------------------------

  async list(userId: string, projectId: string): Promise<ScheduledTaskListResponse> {
    const project = await this.ownedProject(userId, projectId);
    const tz = await this.getTimezone();
    const [tasks, used, user] = await Promise.all([
      this.prisma.scheduledTask.findMany({ where: { projectId }, include: LAST_RUN_INCLUDE, orderBy: { createdAt: "asc" } }),
      this.prisma.scheduledTask.count({ where: { userId } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { maxScheduledTasks: true } }),
    ]);
    return {
      tasks: tasks.map((task) => this.toResponse(task, tz)),
      timezone: tz,
      quota: { used, limit: user?.maxScheduledTasks ?? null },
      supported: !(SCHEDULED_TASK_UNSUPPORTED_PROJECT_TYPES as readonly string[]).includes(project.type),
    };
  }

  async create(userId: string, projectId: string, input: CreateScheduledTaskInput): Promise<ScheduledTaskResponse> {
    const project = await this.ownedProject(userId, projectId);
    if ((SCHEDULED_TASK_UNSUPPORTED_PROJECT_TYPES as readonly string[]).includes(project.type)) {
      throw new ScheduledTaskError(
        "Static sites have no runtime to run commands in, so they can't have scheduled tasks.",
        "UNSUPPORTED_PROJECT_TYPE",
        400,
      );
    }
    await assertUnderQuota(this.prisma, userId, "scheduledTask", (message, code, status) => new ScheduledTaskError(message, code, status));

    const tz = await this.getTimezone();
    await this.assertScheduleIsValid(input.schedule, tz);

    const task = await this.prisma.scheduledTask.create({
      data: {
        projectId,
        userId,
        name: input.name,
        command: input.command,
        schedule: input.schedule,
        timeoutSeconds: input.timeoutSeconds,
        enabled: input.enabled,
        notifyOnFailure: input.notifyOnFailure,
      },
      include: LAST_RUN_INCLUDE,
    });

    if (task.enabled) {
      try {
        await armTask(task, tz);
      } catch (err) {
        await this.prisma.scheduledTask.delete({ where: { id: task.id } });
        throw err;
      }
    }

    await this.auditLog.log(userId, "scheduled_task.created", { type: "ScheduledTask", id: task.id }, {
      after: { name: task.name, schedule: task.schedule, enabled: task.enabled, timeoutSeconds: task.timeoutSeconds, projectId },
    });
    void notifyQuotaThreshold(this.prisma, userId, "scheduledTask");
    return this.toResponse(task, tz);
  }

  async update(userId: string, projectId: string, taskId: string, input: UpdateScheduledTaskInput): Promise<ScheduledTaskResponse> {
    const { task: before } = await this.ownedTask(userId, projectId, taskId);
    const tz = await this.getTimezone();
    if (input.schedule !== undefined) await this.assertScheduleIsValid(input.schedule, tz);

    const commandChanged = input.command !== undefined && input.command !== before.command;
    const reEnabled = input.enabled === true && !before.enabled;
    const task = await this.prisma.scheduledTask.update({
      where: { id: taskId },
      data: {
        ...input,
        // A new command or a fresh enable is a fresh start: the old failure streak described something else.
        ...(commandChanged || reEnabled ? { consecutiveFailures: 0 } : {}),
      },
      include: LAST_RUN_INCLUDE,
    });

    if (task.enabled) await armTask(task, tz);
    else await disarmTask(task.id);

    await this.auditLog.log(userId, "scheduled_task.updated", { type: "ScheduledTask", id: taskId }, {
      before: { name: before.name, schedule: before.schedule, enabled: before.enabled, timeoutSeconds: before.timeoutSeconds, notifyOnFailure: before.notifyOnFailure },
      after: {
        name: task.name,
        schedule: task.schedule,
        enabled: task.enabled,
        timeoutSeconds: task.timeoutSeconds,
        notifyOnFailure: task.notifyOnFailure,
        commandChanged,
      },
    });
    return this.toResponse(task, tz);
  }

  async remove(userId: string, projectId: string, taskId: string): Promise<void> {
    const { task } = await this.ownedTask(userId, projectId, taskId);
    await disarmTask(taskId);
    await this.prisma.scheduledTask.delete({ where: { id: taskId } });
    await this.auditLog.log(userId, "scheduled_task.deleted", { type: "ScheduledTask", id: taskId }, {
      before: { name: task.name, schedule: task.schedule, enabled: task.enabled, projectId },
    });
  }

  /** Queues an immediate run. Refuses if the task is already running, rather than recording a skipped run. */
  async runNow(userId: string, projectId: string, taskId: string): Promise<{ queued: true }> {
    const { task } = await this.ownedTask(userId, projectId, taskId);
    if (await this.redis.get(lockKey(task.id))) {
      throw new ScheduledTaskError("This task is already running. Wait for it to finish.", "TASK_RUNNING", 409);
    }
    await enqueueManualRun(task.id);
    await this.auditLog.log(userId, "scheduled_task.run_manual", { type: "ScheduledTask", id: taskId }, {
      after: { name: task.name, projectId },
    });
    return { queued: true };
  }

  async listRuns(userId: string, projectId: string, taskId: string, limit: number): Promise<ScheduledTaskRunResponse[]> {
    await this.ownedTask(userId, projectId, taskId);
    const runs = await this.prisma.scheduledTaskRun.findMany({ where: { taskId }, orderBy: { startedAt: "desc" }, take: limit });
    return runs.map((run) => this.toRunResponse(run));
  }

  async previewSchedule(userId: string, projectId: string, schedule: string): Promise<SchedulePreviewResponse> {
    await this.ownedProject(userId, projectId);
    const tz = await this.getTimezone();
    await this.assertScheduleIsValid(schedule, tz);
    return { timezone: tz, nextRuns: nextRuns(schedule, tz, NEXT_RUNS_SHOWN).map((date) => date.toISOString()) };
  }

  // -------------------------------------------------------------------------
  // Execution (called by the queue worker)
  // -------------------------------------------------------------------------

  /**
   * Runs one task and records the outcome. Safe to call for any task id: a task that no longer
   * exists, is disabled (scheduled runs only) or whose project changed hands is dropped and its
   * repeating job removed, which is how stale jobs clean themselves up.
   */
  async execute(taskId: string, trigger: "SCHEDULED" | "MANUAL"): Promise<void> {
    const task = await this.prisma.scheduledTask.findUnique({ where: { id: taskId }, include: RUN_INCLUDE });

    const orphaned = !task || task.project.deletedAt !== null || task.project.status === "DELETED" || task.project.userId !== task.userId;
    if (orphaned || (trigger === "SCHEDULED" && !task.enabled)) {
      await disarmTask(taskId);
      return;
    }

    const token = randomUUID();
    const acquired = await this.redis.set(lockKey(task.id), token, "PX", (task.timeoutSeconds + LOCK_GRACE_SECONDS) * 1000, "NX");
    if (!acquired) {
      await this.recordSkipped(task.id, trigger, "Skipped: the previous run is still running.");
      return;
    }

    try {
      await this.runLocked(task, trigger);
    } finally {
      await this.redis.eval(RELEASE_LOCK, 1, lockKey(task.id), token).catch((err: unknown) => {
        this.logger.error({ err, taskId }, "Failed to release the scheduled task lock");
      });
    }
  }

  private async runLocked(task: TaskForRun, trigger: "SCHEDULED" | "MANUAL"): Promise<void> {
    const run = await this.prisma.scheduledTaskRun
      .create({ data: { taskId: task.id, trigger, status: "RUNNING" } })
      .catch((err: unknown) => {
        if (isRowGone(err)) return null; // deleted between loading it and starting
        throw err;
      });
    if (!run) return;

    let result: ExecResult;
    try {
      result = await this.runner({
        projectDir: resolve(env.PROJECTS_DIR, task.projectId),
        shellCommand: task.command,
        runId: run.id,
        timeoutSeconds: task.timeoutSeconds,
      });
    } catch (err) {
      this.logger.error({ err, taskId: task.id }, "Scheduled task runner threw");
      result = { status: "failed", exitCode: null, output: "The command could not be run.", truncated: false, reason: null };
    }

    const status = STATUS_FROM_EXEC[result.status];
    const output =
      result.status === "skipped"
        ? (SKIP_MESSAGES[result.reason ?? ""] ?? "Skipped.")
        : stripNul(result.output) + (result.truncated ? "\n[output truncated]" : "");

    // The task (and with it this run) may have been deleted while the command ran, e.g. its project
    // was removed. That is not an error: there is nowhere left to record the outcome.
    const saved = await this.prisma.scheduledTaskRun
      .update({ where: { id: run.id }, data: { status, exitCode: result.exitCode, output, finishedAt: new Date() } })
      .catch((err: unknown) => {
        if (isRowGone(err)) return null;
        throw err;
      });
    if (!saved) return;

    if (status !== "SKIPPED") await this.recordOutcome(task, status as "SUCCESS" | "FAILED" | "TIMEOUT");
    await this.pruneRuns(task.id);
  }

  private async recordOutcome(task: TaskForRun, status: "SUCCESS" | "FAILED" | "TIMEOUT"): Promise<void> {
    const updated = await this.prisma.scheduledTask
      .update({
        where: { id: task.id },
        data: {
          lastRunAt: new Date(),
          consecutiveFailures: status === "SUCCESS" ? 0 : { increment: 1 },
        },
        select: { consecutiveFailures: true, notifyOnFailure: true },
      })
      .catch(() => null); // deleted while it ran
    if (!updated || status === "SUCCESS") return;

    // Exactly on the threshold, so a streak sends one email and the next one needs a success in between.
    if (updated.notifyOnFailure && updated.consecutiveFailures === SCHEDULED_TASK_FAILURE_EMAIL_AFTER) {
      notifyUser("scheduled_task_failed", task.user.email, {
        name: task.user.name,
        taskName: task.name,
        projectName: task.project.name,
        projectId: task.project.id,
        status,
        failures: updated.consecutiveFailures,
      });
    }
  }

  private async recordSkipped(taskId: string, trigger: "SCHEDULED" | "MANUAL", message: string): Promise<void> {
    await this.prisma.scheduledTaskRun
      .create({ data: { taskId, trigger, status: "SKIPPED", output: message, finishedAt: new Date() } })
      .catch(() => null); // task deleted in the meantime
    await this.pruneRuns(taskId);
  }

  private async pruneRuns(taskId: string): Promise<void> {
    const stale = await this.prisma.scheduledTaskRun.findMany({
      where: { taskId },
      orderBy: { startedAt: "desc" },
      skip: SCHEDULED_TASK_RUNS_KEPT,
      select: { id: true },
    });
    if (stale.length > 0) await this.prisma.scheduledTaskRun.deleteMany({ where: { id: { in: stale.map((run) => run.id) } } });
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  /**
   * Brings the database and the queue back in step after a start: runs that were in flight when the
   * API stopped are closed as failed, locks they held are released (nothing can still be running),
   * every enabled task is re-armed in the current timezone, and jobs for vanished tasks are removed.
   * Runs missed while the API was down are not made up.
   */
  async reconcile(): Promise<{ interrupted: number; armed: number; pruned: number }> {
    const interrupted = await this.prisma.scheduledTaskRun.updateMany({
      where: { status: "RUNNING" },
      data: { status: "FAILED", finishedAt: new Date(), output: "Interrupted: the panel restarted while this run was in progress." },
    });

    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", `${LOCK_PREFIX}*`, "COUNT", 100);
      cursor = next;
      if (keys.length > 0) await this.redis.del(...keys);
    } while (cursor !== "0");

    const tz = await this.getTimezone();
    const armed = await rearmAllTasks(this.prisma, tz);
    const pruned = await pruneOrphanSchedulers(this.prisma);
    return { interrupted: interrupted.count, armed, pruned };
  }
}
