import type { FastifyInstance, FastifyReply } from "fastify";
import { createQueue, createWorker } from "../../config/queue.js";
import { env } from "../../config/env.js";
import { AuditLogService } from "../audit-log/service.js";
import { SystemService } from "../system/service.js";
import { createContainerRunner } from "./exec.js";
import {
  CreateScheduledTaskSchema,
  ProjectIdParamSchema,
  SchedulePreviewSchema,
  ScheduledTaskRunsQuerySchema,
  TaskParamsSchema,
  UpdateScheduledTaskSchema,
} from "./schema.js";
import { SCHEDULED_TASK_QUEUE_NAME, registerScheduledTaskQueue, type ScheduledTaskJobData } from "./scheduler.js";
import { ScheduledTaskError, ScheduledTaskService } from "./service.js";

// ---------------------------------------------------------------------------
// Shared helper — handles ScheduledTaskError, re-throws everything else
// (ZodError bubbles up to the global error handler in plugins/error-handler.ts)
// ---------------------------------------------------------------------------
function handleTaskError(err: unknown, reply: FastifyReply): void {
  if (err instanceof ScheduledTaskError) {
    reply.status(err.statusCode).send({ error: err.message, code: err.code, details: {} });
    return;
  }
  throw err;
}

export async function scheduledTaskRoutes(app: FastifyInstance) {
  const auditLog = new AuditLogService(app.prisma, app.log);
  const systemService = new SystemService(app.prisma);
  const service = new ScheduledTaskService(
    app.prisma,
    app.redis,
    auditLog,
    app.log,
    createContainerRunner(app.log),
    async () => (await systemService.getSettings()).timezone,
  );

  // ---------------------------------------------------------------------------
  // BullMQ — one repeating job per task, plus on-demand manual runs
  // ---------------------------------------------------------------------------

  const queue = createQueue(SCHEDULED_TASK_QUEUE_NAME);
  const worker = createWorker<ScheduledTaskJobData>(
    SCHEDULED_TASK_QUEUE_NAME,
    async (job) => {
      await service.execute(job.data.taskId, job.data.trigger);
    },
    app,
    // A run interrupted by a restart is closed as failed at boot; letting BullMQ retry it as a
    // "stalled" job would run the user's command a second time.
    { concurrency: env.SCHEDULED_TASK_CONCURRENCY, maxStalledCount: 0 },
  );
  app.registerQueue(queue, worker);
  registerScheduledTaskQueue(queue);

  try {
    const { interrupted, armed, pruned } = await service.reconcile();
    app.log.info({ interrupted, armed, pruned }, "Scheduled tasks restored");
  } catch (err) {
    app.log.error({ err }, "Failed to restore scheduled tasks");
  }

  // GET /api/projects/:id/scheduled-tasks
  app.get("/:id/scheduled-tasks", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id } = ProjectIdParamSchema.parse(request.params);
      return await service.list(request.userId!, id);
    } catch (err) {
      handleTaskError(err, reply);
    }
  });

  // POST /api/projects/:id/scheduled-tasks
  app.post("/:id/scheduled-tasks", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id } = ProjectIdParamSchema.parse(request.params);
      const body = CreateScheduledTaskSchema.parse(request.body);
      const task = await service.create(request.userId!, id, body);
      reply.status(201);
      return task;
    } catch (err) {
      handleTaskError(err, reply);
    }
  });

  // POST /api/projects/:id/scheduled-tasks/preview — next run times for a cron expression
  app.post(
    "/:id/scheduled-tasks/preview",
    { preHandler: [app.requireAuth], config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const { id } = ProjectIdParamSchema.parse(request.params);
        const { schedule } = SchedulePreviewSchema.parse(request.body);
        return await service.previewSchedule(request.userId!, id, schedule);
      } catch (err) {
        handleTaskError(err, reply);
      }
    },
  );

  // PUT /api/projects/:id/scheduled-tasks/:taskId
  app.put("/:id/scheduled-tasks/:taskId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id, taskId } = TaskParamsSchema.parse(request.params);
      const body = UpdateScheduledTaskSchema.parse(request.body);
      return await service.update(request.userId!, id, taskId, body);
    } catch (err) {
      handleTaskError(err, reply);
    }
  });

  // DELETE /api/projects/:id/scheduled-tasks/:taskId
  app.delete("/:id/scheduled-tasks/:taskId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id, taskId } = TaskParamsSchema.parse(request.params);
      await service.remove(request.userId!, id, taskId);
      reply.status(204).send();
    } catch (err) {
      handleTaskError(err, reply);
    }
  });

  // POST /api/projects/:id/scheduled-tasks/:taskId/run — "Run now"
  app.post(
    "/:id/scheduled-tasks/:taskId/run",
    { preHandler: [app.requireAuth], config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const { id, taskId } = TaskParamsSchema.parse(request.params);
        const result = await service.runNow(request.userId!, id, taskId);
        reply.status(202);
        return result;
      } catch (err) {
        handleTaskError(err, reply);
      }
    },
  );

  // GET /api/projects/:id/scheduled-tasks/:taskId/runs
  app.get("/:id/scheduled-tasks/:taskId/runs", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id, taskId } = TaskParamsSchema.parse(request.params);
      const { limit } = ScheduledTaskRunsQuerySchema.parse(request.query);
      return { runs: await service.listRuns(request.userId!, id, taskId, limit) };
    } catch (err) {
      handleTaskError(err, reply);
    }
  });
}
