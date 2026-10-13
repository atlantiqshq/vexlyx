import type { Queue } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";

// ---------------------------------------------------------------------------
// Module-level singleton so other modules (system/routes.ts on a timezone
// change, projects/service.ts when a project is deleted) can re-arm or remove
// task schedules without a circular import back into scheduled-tasks/routes.ts.
// Mirrors backups/scheduler.ts and cleanup/scheduler.ts, with one BullMQ job
// scheduler per task instead of a single one.
// ---------------------------------------------------------------------------

export const SCHEDULED_TASK_QUEUE_NAME = "scheduled-tasks";
const SCHEDULER_PREFIX = "scheduled-task:";

export const schedulerIdFor = (taskId: string) => `${SCHEDULER_PREFIX}${taskId}`;

export interface SchedulableTask {
  id: string;
  schedule: string;
}

export interface ScheduledTaskJobData {
  taskId: string;
  trigger: "SCHEDULED" | "MANUAL";
}

let _queue: Queue | null = null;

export function registerScheduledTaskQueue(queue: Queue): void {
  _queue = queue;
}

/** Creates or replaces the repeating job for one task. No-op until the queue has registered itself. */
export async function armTask(task: SchedulableTask, tz: string): Promise<void> {
  if (!_queue) return;
  await _queue.upsertJobScheduler(
    schedulerIdFor(task.id),
    { pattern: task.schedule, tz },
    {
      name: "scheduled-task-run",
      data: { taskId: task.id, trigger: "SCHEDULED" } satisfies ScheduledTaskJobData,
      // The outcome lives in the database (ScheduledTaskRun). Without this BullMQ keeps a record of
      // every firing in Redis forever: 1,440 a day for an every-minute task.
      opts: { removeOnComplete: true, removeOnFail: { count: 20 } },
    },
  );
}

export async function disarmTask(taskId: string): Promise<void> {
  if (!_queue) return;
  await _queue.removeJobScheduler(schedulerIdFor(taskId));
}

/** Queues one immediate run ("Run now"). */
export async function enqueueManualRun(taskId: string): Promise<void> {
  if (!_queue) throw new Error("The scheduled task queue is not running");
  await _queue.add(
    "scheduled-task-manual",
    { taskId, trigger: "MANUAL" } satisfies ScheduledTaskJobData,
    { removeOnComplete: true, removeOnFail: { count: 100 } },
  );
}

/** Re-arms every enabled task, e.g. at boot or after the server timezone changed. */
export async function rearmAllTasks(prisma: PrismaClient, tz: string): Promise<number> {
  const tasks = await prisma.scheduledTask.findMany({ where: { enabled: true }, select: { id: true, schedule: true } });
  for (const task of tasks) await armTask(task, tz);
  return tasks.length;
}

/**
 * Removes repeating jobs whose task is gone or disabled. Needed because deleting a user or a
 * project row cascades in the database but knows nothing about BullMQ.
 */
export async function pruneOrphanSchedulers(prisma: PrismaClient): Promise<number> {
  if (!_queue) return 0;
  const schedulers = await _queue.getJobSchedulers(0, -1);
  const known = schedulers.map((s) => s.key).filter((key) => key.startsWith(SCHEDULER_PREFIX));
  if (known.length === 0) return 0;

  const live = await prisma.scheduledTask.findMany({
    where: { enabled: true, id: { in: known.map((key) => key.slice(SCHEDULER_PREFIX.length)) } },
    select: { id: true },
  });
  const liveKeys = new Set(live.map((task) => schedulerIdFor(task.id)));

  let removed = 0;
  for (const key of known) {
    if (liveKeys.has(key)) continue;
    await _queue.removeJobScheduler(key);
    removed += 1;
  }
  return removed;
}

/**
 * Deletes a project's tasks and their repeating jobs. Called when the project is deleted, since a
 * soft delete keeps the project row (so the database cascade never runs). Never throws: a failure
 * here must not stop the project from being deleted, and any leftover job removes itself the next
 * time it fires because its task no longer exists.
 */
export async function removeTasksForProject(prisma: PrismaClient, projectId: string, logger: FastifyBaseLogger): Promise<void> {
  try {
    const tasks = await prisma.scheduledTask.findMany({ where: { projectId }, select: { id: true } });
    for (const task of tasks) await disarmTask(task.id);
    if (tasks.length > 0) await prisma.scheduledTask.deleteMany({ where: { projectId } });
  } catch (err) {
    logger.error({ projectId, err }, "Failed to remove scheduled tasks for a deleted project");
  }
}
