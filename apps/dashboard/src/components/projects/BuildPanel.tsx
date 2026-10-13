"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import {
  Rocket,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Hammer,
  GitCommit,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/datetime";
import { useTimezone } from "@/hooks/useSystemSettings";
import { useRefreshAnimation, refreshIconClassName } from "@/hooks/useRefreshAnimation";
import { LogViewer } from "@/components/projects/LogViewer";
import { useBuildLogs } from "@/hooks/useLogs";
import { ApiRequestError } from "@/lib/api";
import {
  useTriggerBuild,
  useDeploymentPolling,
  useDeployments,
} from "@/hooks/useBuild";
import type { Deployment } from "@vexlyx/shared";

// ---------------------------------------------------------------------------
// Status display config
// ---------------------------------------------------------------------------

type DeploymentStatus = Deployment["status"];

const STATUS_CONFIG: Record<
  DeploymentStatus,
  { label: string; icon: React.ElementType; className: string }
> = {
  QUEUED: {
    label: "Queued",
    icon: Clock,
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  },
  BUILDING: {
    label: "Building",
    icon: Loader2,
    className: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20",
  },
  DEPLOYING: {
    label: "Deploying",
    icon: Loader2,
    className: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20",
  },
  RUNNING: {
    label: "Success",
    icon: CheckCircle2,
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  },
  FAILED: {
    label: "Failed",
    icon: XCircle,
    className: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20",
  },
  CANCELLED: {
    label: "Cancelled",
    icon: XCircle,
    className: "bg-slate-500/10 text-slate-500 border-slate-500/20",
  },
};

const ACTIVE_STATUSES: DeploymentStatus[] = ["QUEUED", "BUILDING", "DEPLOYING"];

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatDate(date: Date | string, timezone?: string): string {
  return formatDateTime(date, timezone);
}

// ---------------------------------------------------------------------------
// DeploymentBadge — inline status badge
// ---------------------------------------------------------------------------

function DeploymentBadge({ status }: { status: DeploymentStatus }) {
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;
  const isSpinning = status === "BUILDING" || status === "DEPLOYING";

  return (
    <Badge
      variant="outline"
      className={cn("flex items-center gap-1 text-xs font-medium", cfg.className)}
    >
      <Icon className={cn("h-3 w-3", isSpinning && "animate-spin")} />
      {cfg.label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// DeploymentRow — single row in the history list
// ---------------------------------------------------------------------------

interface DeploymentRowProps {
  projectId: string;
  deployment: Deployment;
  isActive: boolean;
}

function DeploymentRow({ projectId, deployment, isActive }: DeploymentRowProps) {
  const [expanded, setExpanded] = useState(isActive);
  const timezone = useTimezone();

  const { deployment: polled } = useDeploymentPolling(
    deployment.projectId,
    isActive ? deployment.id : null,
  );

  const displayDeployment = polled ?? deployment;

  // Real-time build logs via Socket.io
  const { lines, isConnected } = useBuildLogs(
    projectId,
    expanded ? deployment.id : null,
    displayDeployment.buildLogs,
  );

  return (
    <div className="border-b border-border last:border-0">
      <div
        className="flex items-center justify-between gap-4 py-3"
        role="row"
      >
        <div className="flex items-center gap-3 min-w-0">
          <DeploymentBadge status={displayDeployment.status} />
          <span className="truncate font-mono text-xs text-muted-foreground">
            {displayDeployment.id.slice(0, 8)}…
          </span>
          {displayDeployment.commitHash && (
            <span
              className="hidden items-center gap-1 font-mono text-[11px] text-muted-foreground md:inline-flex bg-slate-100 dark:bg-slate-800/80 px-1.5 py-0.5 rounded border border-border"
              title={displayDeployment.commitMsg ?? undefined}
            >
              <GitCommit className="h-3 w-3 text-indigo-500 shrink-0" />
              {displayDeployment.commitHash.slice(0, 7)}
              {displayDeployment.commitMsg && (
                <span className="max-w-[150px] truncate text-[11px] font-sans text-muted-foreground ml-1">
                  — {displayDeployment.commitMsg}
                </span>
              )}
            </span>
          )}
          <span className="hidden text-xs text-muted-foreground sm:block">
            {formatDate(displayDeployment.createdAt, timezone)}
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-muted-foreground">
            {formatDuration(displayDeployment.duration)}
          </span>
          <Button
            id={`toggle-logs-${deployment.id}`}
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={expanded ? "Collapse logs" : "Expand logs"}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {displayDeployment.status === "FAILED" && displayDeployment.failure && (
        <div role="alert" className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">{displayDeployment.failure.message}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {displayDeployment.failure.code}
            {displayDeployment.failure.details.file && ` · ${displayDeployment.failure.details.file}`}
          </p>
          {displayDeployment.failure.details.remediation && (
            <p className="mt-2 text-foreground">{displayDeployment.failure.details.remediation}</p>
          )}
        </div>
      )}

      {expanded && (
        <LogViewer
          lines={lines}
          title="Build Output"
          isLive={isActive}
          isConnected={isConnected}
          maxHeightClass="max-h-80"
          className="mt-0 mb-3"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BuildPanel — main component
// ---------------------------------------------------------------------------

interface BuildPanelProps {
  projectId: string;
  buildCmd: string | null | undefined;
  onDeploySuccess?: () => void;
  refreshTrigger?: number;
}

export function BuildPanel({
  projectId,
  buildCmd,
  onDeploySuccess,
  refreshTrigger,
}: BuildPanelProps) {
  const { triggerBuild, isTriggering } = useTriggerBuild(projectId);
  const { deployments, isLoading, refetch } = useDeployments(projectId);
  const { isRefreshing, refresh } = useRefreshAnimation();

  const handleRefresh = () =>
    refresh(async () => {
      await refetch();
      toast.success("Deployments refreshed");
    });

  // Re-fetch when external triggers occur (e.g. Save & Deploy in DockerfilePanel)
  useEffect(() => {
    if (refreshTrigger !== undefined && refreshTrigger > 0) {
      void refetch();
    }
  }, [refreshTrigger, refetch]);

  const [activePollId, setActivePollId] = useState<string | null>(null);

  const { deployment: activeDeployment } = useDeploymentPolling(
    projectId,
    activePollId,
  );

  // When active deployment finishes, refresh deployment list and notify parent
  useEffect(() => {
    if (!activeDeployment) return;

    if (activeDeployment.status === "RUNNING") {
      void refetch();
      if (onDeploySuccess) onDeploySuccess();
    } else if (activeDeployment.status === "FAILED" || activeDeployment.status === "CANCELLED") {
      void refetch();
    }
  }, [activeDeployment?.status, onDeploySuccess, refetch]);

  // When deployments load or change, sync activePollId with the latest in-progress deployment
  useEffect(() => {
    const latest = deployments[0];
    if (latest && ACTIVE_STATUSES.includes(latest.status)) {
      setActivePollId(latest.id);
    } else if (latest && !ACTIVE_STATUSES.includes(latest.status) && activePollId === latest.id) {
      setActivePollId(null);
    }
  }, [deployments, activePollId]);

  const handleDeploy = async () => {
    // No client-side git/type gate here — the backend already accepts any
    // project with either a connected git repo OR local source files (e.g.
    // uploaded via the File Manager), so let it decide and surface its own
    // error message rather than duplicating (and getting out of sync with)
    // that check on the client.
    try {
      const deployment = await triggerBuild(buildCmd ?? undefined);
      if (deployment) {
        setActivePollId(deployment.id);
        toast.success("Build queued — logs will appear below.");
        await refetch();
      }
    } catch (err) {
      const message =
        err instanceof ApiRequestError
          ? err.message
          : "Failed to trigger build. Check that the project is installed or connected.";
      toast.error(message);
    }
  };

  const currentStatus = activeDeployment?.status ?? deployments[0]?.status;
  const isDeploying =
    isTriggering ||
    (currentStatus ? ACTIVE_STATUSES.includes(currentStatus) : false);

  return (
    <Card className="border border-border" id="build-panel">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Hammer className="h-3.5 w-3.5" />
            Deployments
          </span>

          <div className="flex items-center gap-2">
            <Button
              id="refresh-deployments-btn"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Refresh deployments"
              title="Refresh deployments"
              onClick={() => void handleRefresh()}
              disabled={isLoading || isRefreshing}
            >
              <RefreshCw className={refreshIconClassName(isRefreshing, "h-3.5 w-3.5")} />
            </Button>

            <Button
              id="trigger-build-btn"
              size="sm"
              onClick={() => void handleDeploy()}
              disabled={isDeploying}
              className="h-7 gap-1.5"
            >
              {isDeploying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Rocket className="h-3.5 w-3.5" />
              )}
              {isDeploying ? "Building…" : "Deploy"}
            </Button>
          </div>
        </CardTitle>
      </CardHeader>

      <Separator />

      <CardContent className="pt-0">
        {isLoading ? (
          <div className="space-y-3 py-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-32" />
              </div>
            ))}
          </div>
        ) : deployments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Rocket className="h-8 w-8 text-muted-foreground/40" />
            <p className="mt-3 text-sm font-medium text-foreground">No deployments yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Click &quot;Deploy&quot; above to trigger your first build.
            </p>
          </div>
        ) : (
          <div role="table" aria-label="Deployment history">
            {deployments.map((d) => (
              <DeploymentRow
                key={d.id}
                projectId={projectId}
                deployment={d}
                isActive={d.id === activePollId || ACTIVE_STATUSES.includes(d.status)}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
