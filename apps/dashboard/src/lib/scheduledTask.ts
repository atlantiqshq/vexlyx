import { SCHEDULE_PRESETS, TASK_PRESETS, type ScheduledTaskStatus, type TaskPreset } from "@vexlyx/shared";

export const CUSTOM_SCHEDULE = "custom";

/** The preset whose cron expression matches exactly, or null for a hand-written schedule. */
export function presetIdForSchedule(schedule: string): string | null {
  const normalised = schedule.trim().replace(/\s+/g, " ");
  return SCHEDULE_PRESETS.find((preset) => preset.schedule === normalised)?.id ?? null;
}

/** Short human wording for a schedule: the preset's name, or the expression itself. */
export function describeSchedule(schedule: string): string {
  const id = presetIdForSchedule(schedule);
  const preset = SCHEDULE_PRESETS.find((candidate) => candidate.id === id);
  return preset ? preset.label : schedule;
}

/** Stack-specific starting points (Laravel, WordPress) that apply to this project type. */
export function presetsForProjectType(projectType: string): TaskPreset[] {
  return TASK_PRESETS.filter((preset) => preset.projectTypes.includes(projectType));
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "running";
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} m ${String(rest).padStart(2, "0")} s`;
}

export const STATUS_LABEL: Record<ScheduledTaskStatus, string> = {
  RUNNING: "Running",
  SUCCESS: "Succeeded",
  FAILED: "Failed",
  TIMEOUT: "Timed out",
  SKIPPED: "Skipped",
};

/** Tailwind classes for a status badge, using only the design system's semantic colours. */
export const STATUS_BADGE_CLASS: Record<ScheduledTaskStatus, string> = {
  RUNNING: "bg-primary/10 text-primary border-primary/20",
  SUCCESS: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  FAILED: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",
  TIMEOUT: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",
  SKIPPED: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
};
