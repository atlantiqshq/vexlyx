import { z } from "zod";
import {
  CreateScheduledTaskSchema,
  SchedulePreviewSchema,
  ScheduledTaskRunsQuerySchema,
  UpdateScheduledTaskSchema,
} from "@vexlyx/shared";

export { CreateScheduledTaskSchema, SchedulePreviewSchema, ScheduledTaskRunsQuerySchema, UpdateScheduledTaskSchema };

export const ProjectIdParamSchema = z.object({ id: z.string().min(1) });
export const TaskParamsSchema = z.object({ id: z.string().min(1), taskId: z.string().min(1) });
