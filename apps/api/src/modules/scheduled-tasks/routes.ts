import type { FastifyInstance, FastifyReply } from "fastify";
import type { Prisma } from "@prisma/client";
import { ScheduledTaskService, ScheduledTaskError } from "./service.js";
import { AuditLogService } from "../audit-log/service.js";
import {
  CreateScheduledTaskSchema,
  UpdateScheduledTaskSchema,
  ScheduledTaskIdParamSchema,
  ScheduledTaskProjectParamSchema,
  RunNowBodySchema,
  ScheduledTaskListQuerySchema,
} from "./schema.js";
import { createQueue, createWorker } from "../../config/queue.js";
import { SystemService } from "../system/service.js";
import {
  SCHEDULED_TASK_QUEUE_NAME,
  registerScheduledTaskQueue,
  applyTaskSchedule,
  rescheduleAllTasks,
  unscheduleTaskJob,
} from "./scheduler.js";

type ScheduledTaskWithProject = Prisma.ScheduledTaskGetPayload<{
  include: { project: true };
}>;

// ---------------------------------------------------------------------------
// Shared error handler
// ---------------------------------------------------------------------------

function handleScheduledTaskError(err: unknown, reply: FastifyReply): void {
  if (err instanceof ScheduledTaskError) {
    reply.status(err.statusCode).send({ error: err.message, code: err.code, details: {} });
    return;
  }
  throw err;
}

export async function scheduledTaskRoutes(app: FastifyInstance) {
  const auditLog = new AuditLogService(app.prisma, app.log);
  const service = new ScheduledTaskService(app.prisma, app.log, auditLog, app.redis);
  const systemService = new SystemService(app.prisma);

  // ---------------------------------------------------------------------------
  // BullMQ — one queue for both scheduled triggers and worker-side execution
  // ---------------------------------------------------------------------------

  const taskQueue = createQueue(SCHEDULED_TASK_QUEUE_NAME);
  registerScheduledTaskQueue(taskQueue);

  const taskWorker = createWorker<{ taskId: string; trigger: "SCHEDULED" | "MANUAL" }>(
    SCHEDULED_TASK_QUEUE_NAME,
    async (job) => {
      const { taskId, trigger } = job.data;
      const task = await app.prisma.scheduledTask.findUnique({
        where: { id: taskId },
        include: { project: true },
      });
      if (!task || !task.enabled) return;
      try {
        await service.executeTask(task as ScheduledTaskWithProject, trigger);
      } catch (err) {
        // executeTask already recorded the FAILED run; a scheduled trigger
        // must not retry the job (that would double-count the streak).
        app.log.error({ err, taskId }, "Scheduled task execution failed");
      }
    },
    app,
    { concurrency: 5 },
  );

  app.registerQueue(taskQueue, taskWorker);

  // Re-arm every enabled task on boot and refresh its persisted nextRunAt.
  // Missed runs while the API was down are not back-filled (documented).
  const { timezone } = await systemService.getSettings();
  const armedCount = await rescheduleAllTasks(app.prisma, timezone);
  app.log.info({ count: armedCount, timezone }, "Scheduled tasks armed");

  // ---------------------------------------------------------------------------
  // GET /api/projects/:id/scheduled-tasks — list tasks
  // ---------------------------------------------------------------------------

  app.get("/:id/scheduled-tasks", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id } = ScheduledTaskProjectParamSchema.parse(request.params);
      const tasks = await service.list(id, request.userId!, request.userRole!);
      return { tasks };
    } catch (err) {
      handleScheduledTaskError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/projects/:id/scheduled-tasks — create task
  // ---------------------------------------------------------------------------

  app.post("/:id/scheduled-tasks", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id } = ScheduledTaskProjectParamSchema.parse(request.params);
      const body = CreateScheduledTaskSchema.parse(request.body);
      const task = await service.create(id, request.userId!, request.userRole!, body);

      if (task.enabled) {
        const { timezone: tz } = await systemService.getSettings();
        const nextRunAt = await applyTaskSchedule(taskQueue, app.prisma, task, tz);
        reply.status(201);
        return { ...task, nextRunAt };
      }

      reply.status(201);
      return task;
    } catch (err) {
      handleScheduledTaskError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/projects/:id/scheduled-tasks/:taskId — task detail
  // ---------------------------------------------------------------------------

  app.get("/:id/scheduled-tasks/:taskId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id, taskId } = ScheduledTaskIdParamSchema.parse(request.params);
      const task = await app.prisma.scheduledTask.findUnique({ where: { id: taskId } });
      if (!task || task.projectId !== id) {
        reply.status(404).send({ error: "Task not found", code: "TASK_NOT_FOUND", details: {} });
        return;
      }
      // list() performs the same ownership/role access check for the project
      await service.list(id, request.userId!, request.userRole!);
      return task;
    } catch (err) {
      handleScheduledTaskError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // PUT /api/projects/:id/scheduled-tasks/:taskId — update task
  // ---------------------------------------------------------------------------

  app.put("/:id/scheduled-tasks/:taskId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id, taskId } = ScheduledTaskIdParamSchema.parse(request.params);
      const body = UpdateScheduledTaskSchema.parse(request.body);

      const currentTask = await app.prisma.scheduledTask.findUnique({ where: { id: taskId } });
      if (!currentTask || currentTask.projectId !== id) {
        reply.status(404).send({ error: "Task not found", code: "TASK_NOT_FOUND", details: {} });
        return;
      }

      const updated = await service.update(taskId, request.userId!, request.userRole!, body);

      // Re-arm the scheduler whenever the schedule or enabled state changed
      if (body.schedule !== undefined || body.enabled !== undefined) {
        const { timezone: tz } = await systemService.getSettings();
        const nextRunAt = await applyTaskSchedule(taskQueue, app.prisma, updated, tz);
        return { ...updated, nextRunAt };
      }

      return updated;
    } catch (err) {
      handleScheduledTaskError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/projects/:id/scheduled-tasks/:taskId — delete task
  // ---------------------------------------------------------------------------

  app.delete("/:id/scheduled-tasks/:taskId", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id, taskId } = ScheduledTaskIdParamSchema.parse(request.params);
      const task = await app.prisma.scheduledTask.findUnique({ where: { id: taskId } });
      if (!task || task.projectId !== id) {
        reply.status(404).send({ error: "Task not found", code: "TASK_NOT_FOUND", details: {} });
        return;
      }
      await service.delete(taskId, request.userId!, request.userRole!);
      await unscheduleTaskJob(taskQueue, taskId);
      reply.status(204);
      return null;
    } catch (err) {
      handleScheduledTaskError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/projects/:id/scheduled-tasks/:taskId/run — run now
  // ---------------------------------------------------------------------------

  app.post("/:id/scheduled-tasks/:taskId/run", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id, taskId } = ScheduledTaskIdParamSchema.parse(request.params);
      const task = await app.prisma.scheduledTask.findUnique({ where: { id: taskId } });
      if (!task || task.projectId !== id) {
        reply.status(404).send({ error: "Task not found", code: "TASK_NOT_FOUND", details: {} });
        return;
      }
      RunNowBodySchema.parse(request.body ?? {});
      const run = await service.runNow(taskId, request.userId!, request.userRole!);
      reply.status(200);
      return { message: "Task execution finished", run };
    } catch (err) {
      handleScheduledTaskError(err, reply);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/projects/:id/scheduled-tasks/:taskId/runs — run history
  // ---------------------------------------------------------------------------

  app.get("/:id/scheduled-tasks/:taskId/runs", { preHandler: [app.requireAuth] }, async (request, reply) => {
    try {
      const { id, taskId } = ScheduledTaskIdParamSchema.parse(request.params);
      const task = await app.prisma.scheduledTask.findUnique({ where: { id: taskId } });
      if (!task || task.projectId !== id) {
        reply.status(404).send({ error: "Task not found", code: "TASK_NOT_FOUND", details: {} });
        return;
      }
      const { limit } = ScheduledTaskListQuerySchema.parse(request.query);
      const runs = await service.getRuns(taskId, request.userId!, request.userRole!, limit);
      return { runs };
    } catch (err) {
      handleScheduledTaskError(err, reply);
    }
  });
}
