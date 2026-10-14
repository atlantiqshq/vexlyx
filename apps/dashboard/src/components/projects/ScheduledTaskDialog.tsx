"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  CreateScheduledTaskSchema,
  SCHEDULE_PRESETS,
  SCHEDULED_TASK_COMMAND_MAX,
  SCHEDULED_TASK_TIMEOUT_DEFAULT,
  SCHEDULED_TASK_TIMEOUT_MAX,
  SCHEDULED_TASK_TIMEOUT_MIN,
  type SchedulePreviewResponse,
  type ScheduledTaskResponse,
} from "@vexlyx/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { scheduledTaskApi, taskErrorMessage } from "@/hooks/useScheduledTasks";
import { formatDateTime } from "@/lib/datetime";
import { CUSTOM_SCHEDULE, presetIdForSchedule, presetsForProjectType } from "@/lib/scheduledTask";

interface ScheduledTaskDialogProps {
  open: boolean;
  projectId: string;
  projectType: string;
  /** The task being edited, or null to create a new one. */
  task: ScheduledTaskResponse | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

interface Draft {
  name: string;
  command: string;
  schedule: string;
  timeoutSeconds: string;
  enabled: boolean;
  notifyOnFailure: boolean;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  command: "",
  schedule: "0 3 * * *",
  timeoutSeconds: String(SCHEDULED_TASK_TIMEOUT_DEFAULT),
  enabled: true,
  notifyOnFailure: true,
};

const PREVIEW_DELAY_MS = 400;

/** Create or edit a scheduled task. The schedule is checked by the server as you type and the next run times are shown. */
export function ScheduledTaskDialog({ open, projectId, projectType, task, onOpenChange, onSaved }: ScheduledTaskDialogProps) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [isSaving, setIsSaving] = useState(false);
  const [preview, setPreview] = useState<SchedulePreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(
      task
        ? {
            name: task.name,
            command: task.command,
            schedule: task.schedule,
            timeoutSeconds: String(task.timeoutSeconds),
            enabled: task.enabled,
            notifyOnFailure: task.notifyOnFailure,
          }
        : EMPTY_DRAFT,
    );
  }, [open, task]);

  const selectedPreset = presetIdForSchedule(draft.schedule) ?? CUSTOM_SCHEDULE;
  const stackPresets = presetsForProjectType(projectType);

  // Ask the server whether the schedule is valid and when it would next run, once typing pauses.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      scheduledTaskApi
        .preview(projectId, draft.schedule)
        .then((result) => {
          setPreview(result);
          setPreviewError(null);
        })
        .catch((err: unknown) => {
          setPreview(null);
          setPreviewError(taskErrorMessage(err, "Could not check that schedule"));
        });
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [open, projectId, draft.schedule]);

  const parsed = useMemo(
    () =>
      CreateScheduledTaskSchema.safeParse({
        name: draft.name,
        command: draft.command,
        schedule: draft.schedule,
        timeoutSeconds: Number(draft.timeoutSeconds),
        enabled: draft.enabled,
        notifyOnFailure: draft.notifyOnFailure,
      }),
    [draft],
  );
  const firstProblem = parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the form");

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const handleSave = async () => {
    if (!parsed.success) {
      toast.error(firstProblem ?? "Check the form");
      return;
    }
    setIsSaving(true);
    try {
      if (task) await scheduledTaskApi.update(projectId, task.id, parsed.data);
      else await scheduledTaskApi.create(projectId, parsed.data);
      toast.success(task ? "Task updated" : "Task created");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(taskErrorMessage(err, "Could not save the task"));
    } finally {
      setIsSaving(false);
    }
  };

  const canSave = parsed.success && !previewError && !isSaving;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{task ? "Edit scheduled task" : "New scheduled task"}</DialogTitle>
          <DialogDescription>Runs a command inside this project&apos;s container on a schedule.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!task && stackPresets.length > 0 && (
            <div className="space-y-2">
              <Label>Start from</Label>
              <div className="flex flex-wrap gap-2">
                {stackPresets.map((preset) => (
                  <Button
                    key={preset.id}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setDraft((current) => ({ ...current, name: preset.name, command: preset.command, schedule: preset.schedule }))}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              {stackPresets.some((preset) => draft.command === preset.command && preset.note) && (
                <p className="text-xs text-muted-foreground">{stackPresets.find((preset) => draft.command === preset.command)?.note}</p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="task-name">Name</Label>
            <Input id="task-name" value={draft.name} maxLength={100} placeholder="Nightly report" onChange={(e) => set("name", e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-command">Command</Label>
            <Textarea
              id="task-command"
              value={draft.command}
              rows={3}
              className="font-mono text-sm"
              placeholder="node scripts/report.js"
              onChange={(e) => set("command", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Runs with <code className="font-mono">sh -c</code> in the project&apos;s app container, starting in its working directory.{" "}
              {draft.command.length}/{SCHEDULED_TASK_COMMAND_MAX}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-schedule-preset">Schedule</Label>
            <Select
              value={selectedPreset}
              onValueChange={(value) => {
                if (value === CUSTOM_SCHEDULE) return;
                const preset = SCHEDULE_PRESETS.find((candidate) => candidate.id === value);
                if (preset) set("schedule", preset.schedule);
              }}
            >
              <SelectTrigger id="task-schedule-preset" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCHEDULE_PRESETS.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {preset.label}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_SCHEDULE}>Custom…</SelectItem>
              </SelectContent>
            </Select>
            <Input
              aria-label="Cron expression"
              value={draft.schedule}
              className="font-mono text-sm"
              placeholder="*/15 * * * *"
              onChange={(e) => set("schedule", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Five fields: minute hour day-of-month month day-of-week. Once a minute at most.</p>
            {previewError ? (
              <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
                {previewError}
              </p>
            ) : preview ? (
              <div className="rounded-lg border border-border bg-muted/40 p-2.5 text-xs text-muted-foreground">
                <p className="mb-1 font-medium text-foreground">Next runs ({preview.timezone})</p>
                <ul className="space-y-0.5">
                  {preview.nextRuns.map((run) => (
                    <li key={run}>{formatDateTime(run, preview.timezone)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-timeout">Timeout (seconds)</Label>
            <Input
              id="task-timeout"
              type="number"
              min={SCHEDULED_TASK_TIMEOUT_MIN}
              max={SCHEDULED_TASK_TIMEOUT_MAX}
              value={draft.timeoutSeconds}
              onChange={(e) => set("timeoutSeconds", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">The run and everything it started are stopped after this long.</p>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
            <div>
              <Label htmlFor="task-enabled">Enabled</Label>
              <p className="text-xs text-muted-foreground">Turn off to pause the schedule without deleting the task.</p>
            </div>
            <Switch id="task-enabled" checked={draft.enabled} onCheckedChange={(checked) => set("enabled", checked)} />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
            <div>
              <Label htmlFor="task-notify">Email me when it keeps failing</Label>
              <p className="text-xs text-muted-foreground">One email after 3 failures in a row, then none until it succeeds once.</p>
            </div>
            <Switch id="task-notify" checked={draft.notifyOnFailure} onCheckedChange={(checked) => set("notifyOnFailure", checked)} />
          </div>

          {firstProblem && (draft.name !== "" || draft.command !== "") && <p className="text-xs text-rose-600 dark:text-rose-400">{firstProblem}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={!canSave}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {task ? "Save changes" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
