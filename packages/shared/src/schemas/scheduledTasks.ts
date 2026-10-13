import { z } from "zod";

// ---------------------------------------------------------------------------
// Limits (F5.28)
// ---------------------------------------------------------------------------

export const SCHEDULED_TASK_NAME_MAX = 100;
export const SCHEDULED_TASK_COMMAND_MAX = 2000;
export const SCHEDULED_TASK_TIMEOUT_MIN = 1;
export const SCHEDULED_TASK_TIMEOUT_MAX = 3600;
export const SCHEDULED_TASK_TIMEOUT_DEFAULT = 300;
/** Only this many of the newest runs are kept per task. */
export const SCHEDULED_TASK_RUNS_KEPT = 50;
/** Output beyond this many bytes is cut off, keeping the start. */
export const SCHEDULED_TASK_OUTPUT_MAX_BYTES = 64 * 1024;
/** A failure email goes out when a task fails this many times in a row. */
export const SCHEDULED_TASK_FAILURE_EMAIL_AFTER = 3;

/** Project types where there is no runtime to run a command in. */
export const SCHEDULED_TASK_UNSUPPORTED_PROJECT_TYPES = ["STATIC", "REACT"] as const;

export const ScheduledTaskTriggerSchema = z.enum(["SCHEDULED", "MANUAL"]);
export type ScheduledTaskTrigger = z.infer<typeof ScheduledTaskTriggerSchema>;

export const ScheduledTaskStatusSchema = z.enum(["RUNNING", "SUCCESS", "FAILED", "TIMEOUT", "SKIPPED"]);
export type ScheduledTaskStatus = z.infer<typeof ScheduledTaskStatusSchema>;

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

const CRON_FIELD = /^[0-9A-Za-z*/,\-?]+$/;

/**
 * Five-field cron expression (minute hour day-of-month month day-of-week).
 * Seconds fields and @macros are rejected on purpose: the fastest schedule is once a minute.
 * This only checks the shape; the API checks the values with a real cron parser.
 */
export const CronExpressionSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .refine((value) => value.split(" ").length === 5, "Use five fields: minute hour day-of-month month day-of-week")
  .refine((value) => value.split(" ").every((field) => CRON_FIELD.test(field)), "Contains characters a cron expression can't have");

const taskName = z
  .string()
  .trim()
  .min(1, "Give the task a name")
  .max(SCHEDULED_TASK_NAME_MAX, `Must be at most ${SCHEDULED_TASK_NAME_MAX} characters`);

const taskCommand = z
  .string()
  .trim()
  .min(1, "Enter the command to run")
  .max(SCHEDULED_TASK_COMMAND_MAX, `Must be at most ${SCHEDULED_TASK_COMMAND_MAX} characters`)
  // Newlines and tabs are fine in a shell command; other control characters never are.
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), "Contains control characters");

const timeoutSeconds = z
  .number()
  .int()
  .min(SCHEDULED_TASK_TIMEOUT_MIN, `Must be at least ${SCHEDULED_TASK_TIMEOUT_MIN} second`)
  .max(SCHEDULED_TASK_TIMEOUT_MAX, `Must be at most ${SCHEDULED_TASK_TIMEOUT_MAX} seconds`);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const CreateScheduledTaskSchema = z.object({
  name: taskName,
  command: taskCommand,
  schedule: CronExpressionSchema,
  timeoutSeconds: timeoutSeconds.default(SCHEDULED_TASK_TIMEOUT_DEFAULT),
  enabled: z.boolean().default(true),
  notifyOnFailure: z.boolean().default(true),
});
export type CreateScheduledTaskInput = z.infer<typeof CreateScheduledTaskSchema>;

export const UpdateScheduledTaskSchema = z
  .object({
    name: taskName,
    command: taskCommand,
    schedule: CronExpressionSchema,
    timeoutSeconds,
    enabled: z.boolean(),
    notifyOnFailure: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change");
export type UpdateScheduledTaskInput = z.infer<typeof UpdateScheduledTaskSchema>;

export const SchedulePreviewSchema = z.object({ schedule: CronExpressionSchema });
export type SchedulePreviewInput = z.infer<typeof SchedulePreviewSchema>;

export const ScheduledTaskRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(SCHEDULED_TASK_RUNS_KEPT).default(20),
});
export type ScheduledTaskRunsQuery = z.infer<typeof ScheduledTaskRunsQuerySchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface ScheduledTaskRunResponse {
  id: string;
  taskId: string;
  trigger: ScheduledTaskTrigger;
  status: ScheduledTaskStatus;
  exitCode: number | null;
  output: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface ScheduledTaskResponse {
  id: string;
  projectId: string;
  name: string;
  command: string;
  schedule: string;
  timeoutSeconds: number;
  enabled: boolean;
  notifyOnFailure: boolean;
  consecutiveFailures: number;
  lastRunAt: string | null;
  /** Status of the most recent run, or null if it has never run. */
  lastStatus: ScheduledTaskStatus | null;
  /** Next scheduled run, or null while the task is disabled. */
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTaskListResponse {
  tasks: ScheduledTaskResponse[];
  /** Server timezone the schedules are evaluated in (F5.13). */
  timezone: string;
  quota: { used: number; limit: number | null };
  /** False for project types with no runtime to run commands in. */
  supported: boolean;
}

export interface SchedulePreviewResponse {
  timezone: string;
  /** The next few run times, ISO 8601. */
  nextRuns: string[];
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export interface SchedulePreset {
  id: string;
  label: string;
  schedule: string;
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { id: "every-minute", label: "Every minute", schedule: "* * * * *" },
  { id: "hourly", label: "Every hour", schedule: "0 * * * *" },
  { id: "daily", label: "Every day at 03:00", schedule: "0 3 * * *" },
  { id: "weekly", label: "Every Sunday at 03:00", schedule: "0 3 * * 0" },
];

export interface TaskPreset {
  id: string;
  label: string;
  name: string;
  command: string;
  schedule: string;
  /** Project types the preset applies to. */
  projectTypes: string[];
  /** Shown under the preset in the dialog. */
  note?: string;
}

export const TASK_PRESETS: TaskPreset[] = [
  {
    id: "laravel-schedule",
    label: "Laravel scheduler",
    name: "Laravel scheduler",
    command: "php artisan schedule:run",
    schedule: "* * * * *",
    projectTypes: ["PHP"],
    note: "Laravel needs this to run every minute to fire its own scheduled jobs.",
  },
  {
    id: "wordpress-cron",
    label: "WordPress cron",
    name: "WordPress cron",
    command: "php wp-cron.php",
    schedule: "*/5 * * * *",
    projectTypes: ["WORDPRESS"],
    note: "Runs WordPress's scheduled events on a real schedule. Add define('DISABLE_WP_CRON', true); to wp-config.php so it doesn't also run on page views.",
  },
];
