"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useSocket } from "@/hooks/useSocket";
import {
  Activity,
  Cpu,
  Network,
  RefreshCw,
  Server,
  Clock,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useRefreshAnimation, refreshIconClassName } from "@/hooks/useRefreshAnimation";
import {
  useServerMetrics,
  useContainerMetrics,
  useMetricHistory,
  useThresholdAlerts,
} from "@/hooks/useMonitoring";
import { ResourceGauge } from "./ResourceGauge";
import { UsageBar } from "./UsageBar";
import { PerCoreCpuBars } from "./PerCoreCpuBars";
import { MetricHistoryChart } from "./MetricHistoryChart";
import { ContainerMetricsTable } from "./ContainerMetricsTable";
import { ThresholdAlertBadge } from "./ThresholdAlertBadge";
import { DiskUsageCard } from "./DiskUsageCard";
import { CleanupSettingsCard } from "./CleanupSettingsCard";
import type { MetricsRange } from "@vexlyx/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// ---------------------------------------------------------------------------
// Sub-section: Live gauges row
// ---------------------------------------------------------------------------

function LiveGaugesSection() {
  const { metrics, isConnected } = useServerMetrics();

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Server className="h-4 w-4 text-muted-foreground" />
          Live Server Metrics
        </CardTitle>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              isConnected ? "bg-emerald-500" : "bg-amber-500",
            )}
            title={isConnected ? "Connected via WebSocket" : "Polling via REST"}
          />
          <span className="text-xs text-muted-foreground">
            {isConnected ? "Live" : "Polling"}
          </span>
        </div>
      </CardHeader>

      <CardContent>
        {!metrics ? (
          <div className="flex items-center justify-center gap-8 py-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-28 rounded-full" />
            ))}
          </div>
        ) : (
          <>
            {/* Gauges row */}
            <div className="flex flex-wrap items-start justify-center gap-8 pb-6 pt-2">
              <ResourceGauge
                label="CPU"
                value={metrics.cpuPercent}
                warnAt={70}
                dangerAt={90}
              />
              <ResourceGauge
                label="RAM"
                value={metrics.ramPercent}
                warnAt={75}
                dangerAt={90}
              />
            </div>

            {metrics.cpuPerCore.length > 1 ? (
              <PerCoreCpuBars cores={metrics.cpuPerCore} className="pb-5" />
            ) : (
              metrics.cpuCoreCount > 1 && (
                <p className="pb-5 text-xs text-muted-foreground">
                  Per-core breakdown unavailable — install{" "}
                  <code className="rounded bg-muted px-1 py-0.5">psutil</code> on the server to
                  enable it.
                </p>
              )
            )}

            <Separator className="mb-5" />

            {/* Usage bars */}
            <div className="space-y-4">
              <UsageBar
                label="Disk"
                used={metrics.diskUsed}
                total={metrics.diskTotal}
                percent={metrics.diskPercent}
                warnAt={70}
                dangerAt={90}
              />
              <UsageBar
                label="RAM"
                used={metrics.ramUsed}
                total={metrics.ramTotal}
                percent={metrics.ramPercent}
                warnAt={75}
                dangerAt={90}
              />
            </div>

            <Separator className="my-5" />

            {/* System info row */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Uptime
                </p>
                <p className="text-sm font-semibold tabular-nums">
                  {formatUptime(metrics.uptimeSeconds)}
                </p>
              </div>
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Activity className="h-3 w-3" /> Load (1m)
                </p>
                <p className="text-sm font-semibold tabular-nums">
                  {metrics.loadAvg1.toFixed(2)}
                </p>
              </div>
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Network className="h-3 w-3" /> Net In
                </p>
                <p className="text-sm font-semibold tabular-nums">
                  {formatBytes(metrics.netRxBytes)}
                </p>
              </div>
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Network className="h-3 w-3" /> Net Out
                </p>
                <p className="text-sm font-semibold tabular-nums">
                  {formatBytes(metrics.netTxBytes)}
                </p>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sub-section: Historical chart with range tabs
// ---------------------------------------------------------------------------

const RANGE_OPTIONS: { label: string; value: MetricsRange }[] = [
  { label: "1h", value: "1h" },
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
];

function HistorySection() {
  const [range, setRange] = useState<MetricsRange>("24h");
  const { data, isLoading, refetch } = useMetricHistory(range);
  const { isRefreshing, refresh } = useRefreshAnimation();
  const handleRefresh = () => refresh(() => refetch());

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Historical Usage
        </CardTitle>

        <div className="flex items-center gap-2">
          <Tabs
            value={range}
            onValueChange={(v) => setRange(v as MetricsRange)}
          >
            <TabsList className="h-7">
              {RANGE_OPTIONS.map((opt) => (
                <TabsTrigger
                  key={opt.value}
                  value={opt.value}
                  className="px-2.5 text-xs"
                >
                  {opt.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => void handleRefresh()}
            aria-label="Refresh historical data"
          >
            <RefreshCw className={refreshIconClassName(isRefreshing, "h-3.5 w-3.5")} />
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        <div className="mb-3 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-indigo-500" /> CPU
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500" /> RAM
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-amber-500" /> Disk
          </span>
        </div>
        <MetricHistoryChart
          snapshots={data?.snapshots ?? []}
          range={range}
          isLoading={isLoading}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sub-section: Per-container metrics table
// ---------------------------------------------------------------------------

function ContainersSection() {
  const { containers } = useContainerMetrics();
  const { isRefreshing, refresh } = useRefreshAnimation();

  const handleRefresh = () => refresh(async () => {});

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Cpu className="h-4 w-4 text-muted-foreground" />
          Container Resources
          <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
            {containers.length}
          </span>
        </CardTitle>

        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={handleRefresh}
          aria-label="Refresh container metrics"
        >
          <RefreshCw className={refreshIconClassName(isRefreshing, "h-3.5 w-3.5")} />
        </Button>
      </CardHeader>

      <CardContent>
        <ContainerMetricsTable containers={containers} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main MonitoringPage component
// ---------------------------------------------------------------------------

/**
 * Full monitoring page — assembles gauges, history chart, container table,
 * and threshold alert badges. All real-time data via Socket.io.
 */
export function MonitoringPage() {
  const { user, isLoading } = useAuth();
  const [revoked, setRevoked] = useState(false);
  if (isLoading) return null;
  if (user?.role !== "ADMIN" || revoked) {
    return (
      <Card>
        <CardContent className="py-16 text-center">
          <p className="text-sm font-medium">Access restricted</p>
          <p className="text-xs text-muted-foreground">Only administrators can view server monitoring.</p>
        </CardContent>
      </Card>
    );
  }
  return <MonitoringContent onAccessRevoked={() => setRevoked(true)} />;
}

function MonitoringContent({ onAccessRevoked }: { onAccessRevoked: () => void }) {
  const socket = useSocket();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!socket) return;
    const revoke = () => {
      queryClient.removeQueries({ queryKey: ["monitoring"] });
      onAccessRevoked();
    };
    socket.on("metrics:error", revoke);
    return () => { socket.off("metrics:error", revoke); };
  }, [socket, queryClient, onAccessRevoked]);
  const { activeAlerts, dismissAlert } = useThresholdAlerts();

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Monitoring</h1>
          <p className="text-muted-foreground">
            Real-time server and container resource usage.
          </p>
        </div>

        {activeAlerts.length > 0 && (
          <ThresholdAlertBadge
            alerts={activeAlerts}
            onDismiss={dismissAlert}
          />
        )}
      </div>

      {/* Two-column grid on large screens */}
      <div className="grid gap-6 lg:grid-cols-2">
        <LiveGaugesSection />
        <HistorySection />
      </div>

      {/* Full-width container table */}
      <ContainersSection />

      {/* F5.15 — Docker disk usage + cleanup */}
      <div className="grid gap-6 lg:grid-cols-2">
        <DiskUsageCard />
        <CleanupSettingsCard />
      </div>
    </div>
  );
}
