import type { Server as SocketIOServer, Socket } from "socket.io";
import type { FastifyBaseLogger } from "fastify";
import type { MonitoringService } from "./service.js";
import type { AlertThreshold, ContainerMetric, ServerMetrics, ThresholdConfig } from "@vexlyx/shared";

type MonitoringAuthorizer = (socket: Socket) => Promise<boolean>;
const subscriptionVersions = new WeakMap<Socket, number>();
const activeSubscriptions = new WeakSet<Socket>();

// ---------------------------------------------------------------------------
// Default alert thresholds (can be made configurable via env later)
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS: ThresholdConfig = {
  cpuThreshold: 80,
  ramThreshold: 85,
  diskThreshold: 90,
};

// ---------------------------------------------------------------------------
// Track active metric push intervals keyed by socket ID
// ---------------------------------------------------------------------------

const activeIntervals = new Map<string, ReturnType<typeof setInterval>>();

// ---------------------------------------------------------------------------
// Threshold alert state & cooldown tracking
// Prevents spamming alerts every 5 seconds when a metric stays above threshold.
// Alerts fire once upon crossing the threshold, with a 5-minute cooldown
// before any repeat notification, and reset once the metric drops below limit.
// ---------------------------------------------------------------------------

const ALERT_COOLDOWN_MS = 5 * 60_000; // 5 minutes
const lastAlertTimes = new Map<string, number>();
const activeBreaches = new Set<string>();

function checkThresholds(
  metrics: ServerMetrics,
  thresholds: ThresholdConfig,
): AlertThreshold[] {
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const alerts: AlertThreshold[] = [];

  const checks: Array<{
    type: "cpu" | "ram" | "disk";
    value: number;
    threshold: number;
    name: string;
  }> = [
    { type: "cpu", value: metrics.cpuPercent, threshold: thresholds.cpuThreshold, name: "CPU" },
    { type: "ram", value: metrics.ramPercent, threshold: thresholds.ramThreshold, name: "RAM" },
    { type: "disk", value: metrics.diskPercent, threshold: thresholds.diskThreshold, name: "Disk" },
  ];

  for (const { type, value, threshold, name } of checks) {
    if (value > threshold) {
      const lastAlert = lastAlertTimes.get(type) ?? 0;
      const wasActive = activeBreaches.has(type);

      // Alert if this is a new breach OR if cooldown has expired
      if (!wasActive || now - lastAlert >= ALERT_COOLDOWN_MS) {
        lastAlertTimes.set(type, now);
        activeBreaches.add(type);

        alerts.push({
          type,
          value,
          threshold,
          message: `${name} usage is ${value.toFixed(1)}% (threshold: ${threshold}%)`,
          triggeredAt: timestamp,
        });
      }
    } else {
      // Metric recovered below threshold — reset active breach state
      activeBreaches.delete(type);
    }
  }
  return alerts;
}

function invalidateSubscription(socket: Socket): number {
  const version = (subscriptionVersions.get(socket) ?? 0) + 1;
  subscriptionVersions.set(socket, version);
  activeSubscriptions.delete(socket);
  stopMetricsPush(socket.id);
  return version;
}

async function ensureAuthorized(socket: Socket, authorize: MonitoringAuthorizer, logger: FastifyBaseLogger): Promise<boolean> {
  if (!socket.connected) return false;
  try {
    if (await authorize(socket)) return true;
  } catch (err) {
    logger.error({ socketId: socket.id, err }, "Failed to authorize monitoring subscription");
  }
  invalidateSubscription(socket);
  await socket.leave("metrics");
  if (socket.connected) socket.emit("metrics:error", { code: "FORBIDDEN_ROLE", message: "Only administrators can view server monitoring" });
  return false;
}

// ---------------------------------------------------------------------------
// Push a single metrics snapshot to the metrics room
// ---------------------------------------------------------------------------

async function pushMetrics(
  io: SocketIOServer,
  service: MonitoringService,
  logger: FastifyBaseLogger,
  authorize: MonitoringAuthorizer,
  checkAlerts = true,
): Promise<ServerMetrics | null> {
  try {
    const [server, containers] = await Promise.all([
      service.getServerMetrics(),
      service.getContainerMetrics(),
    ]);

    const alerts = checkAlerts ? checkThresholds(server, DEFAULT_THRESHOLDS) : [];
    // Never broadcast sensitive data to a room whose membership may be stale.
    for (const socket of io.sockets.sockets.values()) {
      if (!activeSubscriptions.has(socket) || !socket.rooms.has("metrics")) continue;
      const version = subscriptionVersions.get(socket);
      if (!await ensureAuthorized(socket, authorize, logger)) continue;
      if (!socket.connected || !activeSubscriptions.has(socket) || !socket.rooms.has("metrics") || version !== subscriptionVersions.get(socket)) continue;
      socket.emit("metrics:server", server);
      socket.emit("metrics:containers", containers);
      for (const alert of alerts) socket.emit("alert:threshold", alert);
    }

    return server;
  } catch (err) {
    logger.error({ err }, "Failed to collect metrics for Socket.io push");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Start per-socket metrics push interval (5-second cadence)
// ---------------------------------------------------------------------------

function startMetricsPush(
  socketId: string,
  io: SocketIOServer,
  service: MonitoringService,
  logger: FastifyBaseLogger,
  authorize: MonitoringAuthorizer,
): void {
  if (activeIntervals.has(socketId)) return;

  const interval = setInterval(() => {
    void pushMetrics(io, service, logger, authorize);
  }, 5_000);

  activeIntervals.set(socketId, interval);
}

function stopMetricsPush(socketId: string): void {
  const interval = activeIntervals.get(socketId);
  if (interval) {
    clearInterval(interval);
    activeIntervals.delete(socketId);
  }
}

// ---------------------------------------------------------------------------
// Register socket event handlers
// ---------------------------------------------------------------------------

export function registerMonitoringSocketHandlers(
  io: SocketIOServer,
  service: MonitoringService,
  logger: FastifyBaseLogger,
  authorize: MonitoringAuthorizer,
): void {
  io.on("connection", (socket) => {
    // --- Subscribe to live metrics ---
    socket.on("subscribe:metrics", async () => {
      const version = invalidateSubscription(socket);
      const isCurrent = () => socket.connected && subscriptionVersions.get(socket) === version;
      if (!await ensureAuthorized(socket, authorize, logger) || !isCurrent()) return;

      // Send an immediate snapshot on join so the client doesn't wait 5s
      let initial: [ServerMetrics, ContainerMetric[]] | null = null;
      try {
        initial = await Promise.all([
          service.getServerMetrics(),
          service.getContainerMetrics(),
        ]);
      } catch (err) {
        logger.error({ socketId: socket.id, err }, "Initial metrics push failed");
      }

      // Collection can take seconds; recheck before joining or sending data.
      // An authorized subscription still retries after a collector failure.
      if (!await ensureAuthorized(socket, authorize, logger) || !isCurrent()) return;
      await socket.join("metrics");
      if (!isCurrent()) {
        if (!activeSubscriptions.has(socket)) await socket.leave("metrics");
        return;
      }
      activeSubscriptions.add(socket);
      if (initial) {
        socket.emit("metrics:server", initial[0]);
        socket.emit("metrics:containers", initial[1]);
      }

      if (!isCurrent()) return;
      startMetricsPush(socket.id, io, service, logger, authorize);
      logger.debug({ socketId: socket.id }, "Subscribed to metrics");
    });

    // --- Unsubscribe from live metrics ---
    socket.on("unsubscribe:metrics", async () => {
      invalidateSubscription(socket);
      await socket.leave("metrics");
      logger.debug({ socketId: socket.id }, "Unsubscribed from metrics");
    });

    // --- Cleanup on disconnect ---
    socket.on("disconnect", () => {
      invalidateSubscription(socket);
    });
  });
}

// ---------------------------------------------------------------------------
// Background collector — called by BullMQ repeatable job every 60 seconds
// Saves a DB snapshot AND pushes live update to all subscribed sockets.
// ---------------------------------------------------------------------------

export async function runMetricsCollectorJob(
  io: SocketIOServer,
  service: MonitoringService,
  logger: FastifyBaseLogger,
  authorize: MonitoringAuthorizer,
): Promise<void> {
  const server = await pushMetrics(io, service, logger, authorize, true);

  if (server) {
    try {
      await service.saveSnapshot(server);
    } catch (err) {
      logger.error({ err }, "Failed to persist metric snapshot");
    }

    try {
      // Prune >30d old snapshots once per collection cycle
      await service.pruneOldSnapshots();
    } catch (err) {
      logger.error({ err }, "Failed to prune old metric snapshots");
    }
  }
}
