import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ScheduledTaskRunStatusSchema = z.enum([
  "RUNNING",
  "SUCCESS",
  "FAILED",
  "TIMEOUT",
  "SKIPPED",
]);

export const ScheduledTaskRunTriggerSchema = z.enum(["SCHEDULED", "MANUAL"]);

// ---------------------------------------------------------------------------
// Input Schemas
// ---------------------------------------------------------------------------

// 5-field cron regex (no seconds field)
const CRON_5_FIELD_REGEX = new RegExp(
  "^(\\*|[0-9,\\/-]+)\\s+(\\*|[0-9,\\/-]+)\\s+(\\*|[0-9,\\/-]+)\\s+(\\*|[0-9,\\/-]+)\\s+(\\*|[0-9,\\/-]+)$",
);

export const CreateScheduledTaskSchema = z.object({
  name: z.string().min(1).max(100),
  command: z.string().min(1).max(2000),
  schedule: z.string().regex(CRON_5_FIELD_REGEX, {
    message: "Invalid cron expression (5 fields only, no seconds)",
  }),
  timeoutSeconds: z.number().int().min(1).max(3600).default(300),
  enabled: z.boolean().default(true),
  notifyOnFailure: z.boolean().default(true),
});

export const UpdateScheduledTaskSchema = CreateScheduledTaskSchema.partial();

export const ScheduledTaskProjectParamSchema = z.object({
  id: z.string().cuid(),
});

export const ScheduledTaskIdParamSchema = z.object({
  id: z.string().cuid(),
  taskId: z.string().cuid(),
});

export const RunNowBodySchema = z.object({});

// ---------------------------------------------------------------------------
// Response Schemas
// ---------------------------------------------------------------------------

export const ScheduledTaskResponseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  name: z.string(),
  command: z.string(),
  schedule: z.string(),
  timeoutSeconds: z.number(),
  enabled: z.boolean(),
  notifyOnFailure: z.boolean(),
  consecutiveFailures: z.number(),
  lastRunAt: z.date().nullable(),
  nextRunAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const ScheduledTaskRunResponseSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  trigger: ScheduledTaskRunTriggerSchema,
  status: ScheduledTaskRunStatusSchema,
  exitCode: z.number().nullable(),
  output: z.string().nullable(),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
});

export const ScheduledTaskListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50).optional(),
  cursor: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateScheduledTaskInput = z.infer<typeof CreateScheduledTaskSchema>;
export type UpdateScheduledTaskInput = z.infer<typeof UpdateScheduledTaskSchema>;
export type ScheduledTaskResponse = z.infer<typeof ScheduledTaskResponseSchema>;
export type ScheduledTaskRunResponse = z.infer<typeof ScheduledTaskRunResponseSchema>;
export type ScheduledTaskRunStatus = z.infer<typeof ScheduledTaskRunStatusSchema>;
export type ScheduledTaskRunTrigger = z.infer<typeof ScheduledTaskRunTriggerSchema>;
export type ScheduledTaskListQuery = z.infer<typeof ScheduledTaskListQuerySchema>;