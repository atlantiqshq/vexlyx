import type { Queue } from "bullmq";
import type { PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// Module-level singleton so other modules (system/routes.ts, on a timezone
// change per F5.13) can re-upsert every task scheduler without a circular
// import back into scheduled-tasks/routes.ts. Mirrors backups/scheduler.ts.
// ---------------------------------------------------------------------------

export const SCHEDULED_TASK_QUEUE_NAME = "scheduled-task-runner";
export const SCHEDULED_TASK_PREFIX = "scheduled-task:";

let _queue: Queue | null = null;

export function registerScheduledTaskQueue(queue: Queue): void {
  _queue = queue;
}

export function getScheduledTaskQueue(): Queue | null {
  return _queue;
}

function schedulerId(taskId: string): string {
  return `${SCHEDULED_TASK_PREFIX}${taskId}`;
}

async function nextRunFor(queue: Queue, taskId: string): Promise<Date | null> {
  const schedulers = await queue.getJobSchedulers(0, -1, true);
  const scheduler = schedulers.find((s) => s.key === schedulerId(taskId));
  return scheduler?.next ? new Date(scheduler.next) : null;
}

/**
 * Upserts the task's BullMQ job scheduler and returns the next run time
 * (read back from BullMQ so DST/`tz` handling matches what will actually
 * fire), or null when the pattern is invalid.
 */
export async function scheduleTaskJob(
  queue: Queue,
  taskId: string,
  cron: string,
  tz: string,
): Promise<Date | null> {
  await queue.upsertJobScheduler(
    schedulerId(taskId),
    { pattern: cron, tz },
    { name: `scheduled-task:${taskId}`, data: { taskId, trigger: "SCHEDULED" } },
  );
  return nextRunFor(queue, taskId);
}

export async function unscheduleTaskJob(queue: Queue, taskId: string): Promise<void> {
  await queue.removeJobScheduler(schedulerId(taskId)).catch(() => undefined);
}

/**
 * Applies a task's current `enabled`/`schedule` state to BullMQ and persists
 * the result to `nextRunAt` so the dashboard can show it. Used by
 * create/update routes.
 */
export async function applyTaskSchedule(
  queue: Queue,
  prisma: PrismaClient,
  task: { id: string; schedule: string; enabled: boolean },
  tz: string,
): Promise<Date | null> {
  if (!task.enabled) {
    await unscheduleTaskJob(queue, task.id);
    await prisma.scheduledTask.update({
      where: { id: task.id },
      data: { nextRunAt: null },
    });
    return null;
  }

  const next = await scheduleTaskJob(queue, task.id, task.schedule, tz);
  await prisma.scheduledTask.update({
    where: { id: task.id },
    data: { nextRunAt: next },
  });
  return next;
}

/**
 * Re-arms every enabled task's scheduler and refreshes each `nextRunAt`.
 * Called at API boot and from system/routes.ts when the server timezone
 * changes (F5.13). Missed runs while the API was down are not back-filled.
 */
export async function rescheduleAllTasks(
  prisma: PrismaClient,
  tz: string,
): Promise<number> {
  if (!_queue) return 0;

  const tasks = await prisma.scheduledTask.findMany({
    where: { enabled: true },
    select: { id: true, schedule: true },
  });

  for (const task of tasks) {
    const next = await scheduleTaskJob(_queue, task.id, task.schedule, tz);
    await prisma.scheduledTask.update({
      where: { id: task.id },
      data: { nextRunAt: next },
    });
  }

  return tasks.length;
}
