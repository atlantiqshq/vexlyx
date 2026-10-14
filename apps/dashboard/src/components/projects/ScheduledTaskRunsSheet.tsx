"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ScheduledTaskResponse, ScheduledTaskRunResponse } from "@vexlyx/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useScheduledTaskRuns } from "@/hooks/useScheduledTasks";
import { refreshIconClassName, useRefreshAnimation } from "@/hooks/useRefreshAnimation";
import { formatDateTime } from "@/lib/datetime";
import { formatDuration, STATUS_BADGE_CLASS, STATUS_LABEL } from "@/lib/scheduledTask";
import { cn } from "@/lib/utils";

interface ScheduledTaskRunsSheetProps {
  projectId: string;
  /** The task whose history is shown; null keeps the sheet closed. */
  task: ScheduledTaskResponse | null;
  timezone: string;
  onOpenChange: (open: boolean) => void;
}

function RunRow({ run, timezone, defaultOpen }: { run: ScheduledTaskRunResponse; timezone: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const hasOutput = run.output.length > 0;

  return (
    <li className="rounded-lg border border-border bg-card">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
        aria-expanded={open}
        disabled={!hasOutput}
        onClick={() => setOpen((current) => !current)}
      >
        <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px] font-semibold", STATUS_BADGE_CLASS[run.status])}>
          {STATUS_LABEL[run.status]}
        </Badge>
        <span className="text-xs text-foreground">{formatDateTime(run.startedAt, timezone)}</span>
        <span className="text-xs text-muted-foreground">
          {run.trigger === "MANUAL" ? "Run now" : "Scheduled"} · {formatDuration(run.durationMs)}
          {run.exitCode !== null && ` · exit ${run.exitCode}`}
        </span>
      </button>
      {open && hasOutput && (
        // The terminal is dark in both themes, like the log viewer.
        <pre className="max-h-72 overflow-auto rounded-b-lg border-t border-border bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-100 whitespace-pre-wrap break-words">
          {run.output}
        </pre>
      )}
    </li>
  );
}

/** A task's recent runs, newest first, with what each one printed. */
export function ScheduledTaskRunsSheet({ projectId, task, timezone, onOpenChange }: ScheduledTaskRunsSheetProps) {
  const { runs, isLoading, refetch } = useScheduledTaskRuns(projectId, task?.id ?? null);
  const { isRefreshing, refresh } = useRefreshAnimation();

  return (
    <Sheet open={task !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{task?.name ?? "Run history"}</SheetTitle>
          <SheetDescription>The latest 50 runs. Output is only visible to you.</SheetDescription>
        </SheetHeader>

        <div className="space-y-3 px-4 pb-6">
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              aria-label="Refresh run history"
              disabled={isRefreshing}
              onClick={() => void refresh(() => refetch())}
            >
              <RefreshCw className={refreshIconClassName(isRefreshing, "h-3.5 w-3.5")} />
            </Button>
          </div>

          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full rounded-lg" />
              <Skeleton className="h-12 w-full rounded-lg" />
              <Skeleton className="h-12 w-full rounded-lg" />
            </div>
          ) : !runs || runs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/80 p-6 text-center">
              <p className="text-sm font-medium text-foreground">No runs yet</p>
              <p className="mx-auto mt-0.5 max-w-xs text-xs text-muted-foreground">
                The first run appears here when the schedule fires, or right away if you use Run now.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {runs.map((run, index) => (
                <RunRow key={run.id} run={run} timezone={timezone} defaultOpen={index === 0} />
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
