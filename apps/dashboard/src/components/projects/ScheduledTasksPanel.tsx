"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CalendarClock, History, Loader2, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { Project, ScheduledTaskResponse } from "@vexlyx/shared";
import { QuotaBadge } from "@/components/quota/QuotaBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { scheduledTaskApi, taskErrorMessage, useScheduledTasks } from "@/hooks/useScheduledTasks";
import { refreshIconClassName, useRefreshAnimation } from "@/hooks/useRefreshAnimation";
import { formatDateTime } from "@/lib/datetime";
import { describeSchedule, STATUS_BADGE_CLASS, STATUS_LABEL } from "@/lib/scheduledTask";
import { cn } from "@/lib/utils";
import { ScheduledTaskDialog } from "./ScheduledTaskDialog";
import { ScheduledTaskRunsSheet } from "./ScheduledTaskRunsSheet";

interface ScheduledTasksPanelProps {
  project: Project;
}

/** Wait this long, then look again, so a run started with "Run now" shows up without a manual refresh. */
const RUN_NOW_RECHECK_MS = [1200, 3500, 8000];

export function ScheduledTasksPanel({ project }: ScheduledTasksPanelProps) {
  const { data, isLoading, refetch, invalidate } = useScheduledTasks(project.id);
  const { isRefreshing, refresh } = useRefreshAnimation();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ScheduledTaskResponse | null>(null);
  const [historyTask, setHistoryTask] = useState<ScheduledTaskResponse | null>(null);
  const [deleting, setDeleting] = useState<ScheduledTaskResponse | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const tasks = data?.tasks ?? [];
  const timezone = data?.timezone ?? "UTC";
  const supported = data?.supported ?? true;
  const quota = data?.quota;
  const atLimit = quota?.limit != null && quota.used >= quota.limit;

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (task: ScheduledTaskResponse) => {
    setEditing(task);
    setDialogOpen(true);
  };

  const handleToggle = async (task: ScheduledTaskResponse, enabled: boolean) => {
    setBusyTaskId(task.id);
    try {
      await scheduledTaskApi.update(project.id, task.id, { enabled });
      await invalidate();
      toast.success(enabled ? `"${task.name}" is on` : `"${task.name}" is paused`);
    } catch (err) {
      toast.error(taskErrorMessage(err, "Could not change the task"));
    } finally {
      setBusyTaskId(null);
    }
  };

  const handleRunNow = async (task: ScheduledTaskResponse) => {
    setBusyTaskId(task.id);
    try {
      await scheduledTaskApi.runNow(project.id, task.id);
      toast.success(`"${task.name}" is running`);
      for (const delay of RUN_NOW_RECHECK_MS) setTimeout(() => void invalidate(), delay);
    } catch (err) {
      toast.error(taskErrorMessage(err, "Could not start the task"));
    } finally {
      setBusyTaskId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    setIsDeleting(true);
    try {
      await scheduledTaskApi.remove(project.id, deleting.id);
      toast.success(`"${deleting.name}" deleted`);
      setDeleting(null);
      await invalidate();
    } catch (err) {
      toast.error(taskErrorMessage(err, "Could not delete the task"));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Card className="border border-border">
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base font-semibold text-foreground">
            <CalendarClock className="h-4 w-4 text-primary" />
            Scheduled Tasks
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Run a command inside this project&apos;s container on a schedule, with run history and failure emails.
          </CardDescription>
        </div>

        <div className="flex items-center gap-2">
          <QuotaBadge label="Tasks" usage={quota ? { used: quota.used, limit: quota.limit } : undefined} isLoading={isLoading} />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            aria-label="Refresh scheduled tasks"
            disabled={isRefreshing || isLoading}
            onClick={() => void refresh(() => refetch())}
          >
            <RefreshCw className={refreshIconClassName(isRefreshing, "h-3.5 w-3.5")} />
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={!supported || atLimit}
            title={atLimit ? "You've reached your scheduled task limit" : undefined}
            onClick={openCreate}
          >
            <Plus className="h-3.5 w-3.5" />
            Add task
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : !supported ? (
          <div className="rounded-lg border border-dashed border-border/80 p-6 text-center">
            <CalendarClock className="mx-auto mb-2 h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm font-medium text-foreground">Nothing to run commands in</p>
            <p className="mx-auto mt-0.5 max-w-sm text-xs text-muted-foreground">
              Static sites are served as plain files, so there is no runtime to schedule commands in.
            </p>
          </div>
        ) : tasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/80 p-6 text-center">
            <CalendarClock className="mx-auto mb-2 h-8 w-8 text-muted-foreground/60" />
            <p className="text-sm font-medium text-foreground">No scheduled tasks yet</p>
            <p className="mx-auto mt-0.5 max-w-sm text-xs text-muted-foreground">
              Run a nightly script, the Laravel scheduler, or WordPress cron on a real schedule.
            </p>
            <Button variant="outline" size="sm" className="mt-3 text-xs" disabled={atLimit} onClick={openCreate}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Create your first task
            </Button>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {tasks.map((task) => (
              <li key={task.id} className={cn("space-y-2 rounded-lg border border-border bg-card p-3", !task.enabled && "opacity-70")}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">{task.name}</span>
                    {task.lastStatus && (
                      <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px] font-semibold", STATUS_BADGE_CLASS[task.lastStatus])}>
                        {task.lastStatus === "RUNNING" && <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />}
                        {STATUS_LABEL[task.lastStatus]}
                      </Badge>
                    )}
                    {!task.enabled && (
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                        Paused
                      </Badge>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <Switch
                      checked={task.enabled}
                      disabled={busyTaskId === task.id}
                      aria-label={`${task.enabled ? "Pause" : "Enable"} ${task.name}`}
                      onCheckedChange={(checked) => void handleToggle(task, checked)}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      aria-label={`Run ${task.name} now`}
                      title="Run now"
                      disabled={busyTaskId === task.id || task.lastStatus === "RUNNING"}
                      onClick={() => void handleRunNow(task)}
                    >
                      <Play className="h-3 w-3" />
                    </Button>
                    <Button variant="outline" size="icon" className="h-7 w-7" aria-label={`Run history for ${task.name}`} title="Run history" onClick={() => setHistoryTask(task)}>
                      <History className="h-3 w-3" />
                    </Button>
                    <Button variant="outline" size="icon" className="h-7 w-7" aria-label={`Edit ${task.name}`} title="Edit" onClick={() => openEdit(task)}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7 border-destructive/40 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                      aria-label={`Delete ${task.name}`}
                      title="Delete"
                      onClick={() => setDeleting(task)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>

                <code className="block truncate rounded bg-muted px-2 py-1 font-mono text-xs text-foreground" title={task.command}>
                  {task.command}
                </code>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span title={task.schedule}>{describeSchedule(task.schedule)}</span>
                  <span>•</span>
                  <span>{task.nextRunAt ? `Next: ${formatDateTime(task.nextRunAt, timezone)}` : "Not scheduled"}</span>
                  {task.lastRunAt && (
                    <>
                      <span>•</span>
                      <span>Last run: {formatDateTime(task.lastRunAt, timezone)}</span>
                    </>
                  )}
                  {task.consecutiveFailures > 0 && (
                    <>
                      <span>•</span>
                      <span className="font-medium text-rose-600 dark:text-rose-400">
                        {task.consecutiveFailures} {task.consecutiveFailures === 1 ? "failure" : "failures"} in a row
                      </span>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {supported && tasks.length > 0 && <p className="text-xs text-muted-foreground">Times are shown in the server timezone ({timezone}).</p>}
      </CardContent>

      <ScheduledTaskDialog
        open={dialogOpen}
        projectId={project.id}
        projectType={project.type}
        task={editing}
        onOpenChange={setDialogOpen}
        onSaved={() => void invalidate()}
      />

      <ScheduledTaskRunsSheet projectId={project.id} task={historyTask} timezone={timezone} onOpenChange={(open) => !open && setHistoryTask(null)} />

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" />
              Delete &ldquo;{deleting?.name}&rdquo;?
            </DialogTitle>
            <DialogDescription>The schedule stops and its run history is deleted. A run that is already in progress is not interrupted.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)} disabled={isDeleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={isDeleting}>
              {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
