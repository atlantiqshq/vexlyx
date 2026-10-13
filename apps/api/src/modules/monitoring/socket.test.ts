import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server, Socket } from "socket.io";
import type { FastifyBaseLogger } from "fastify";
import type { MonitoringService } from "./service.js";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const serverMetrics = { cpuPercent: 95, ramPercent: 10, diskPercent: 10 };
const containerMetrics = [{ name: "other-tenant-container" }];
const logger = { error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function fixture(allowed = true) {
  const { registerMonitoringSocketHandlers, runMetricsCollectorJob } = await import("./socket.js");
  const handlers = new Map<string, () => Promise<void> | void>();
  const socket = {
    id: "s1", connected: true, rooms: new Set<string>(), data: {},
    on: vi.fn((event: string, handler: () => Promise<void> | void) => { handlers.set(event, handler); }),
    emit: vi.fn(),
    join: vi.fn(async (room: string) => { socket.rooms.add(room); }),
    leave: vi.fn(async (room: string) => { socket.rooms.delete(room); }),
  };
  const io = {
    on: vi.fn((_event: string, handler: (client: Socket) => void) => { handler(socket as unknown as Socket); }),
    sockets: { sockets: new Map([[socket.id, socket]]) },
    to: vi.fn(() => { throw new Error("Sensitive room broadcasts are forbidden"); }),
  };
  const service = {
    getServerMetrics: vi.fn().mockResolvedValue(serverMetrics),
    getContainerMetrics: vi.fn().mockResolvedValue(containerMetrics),
    saveSnapshot: vi.fn().mockResolvedValue(undefined),
    pruneOldSnapshots: vi.fn().mockResolvedValue(undefined),
  };
  const authorize = vi.fn().mockResolvedValue(allowed);
  registerMonitoringSocketHandlers(io as unknown as Server, service as unknown as MonitoringService, logger, authorize);
  return {
    socket, service, authorize,
    event: async (name: string) => { await handlers.get(name)!(); },
    collect: () => runMetricsCollectorJob(io as unknown as Server, service as unknown as MonitoringService, logger, authorize),
  };
}

function expectNoMetrics(socket: Awaited<ReturnType<typeof fixture>>["socket"]) {
  expect(socket.emit.mock.calls.filter(([event]) => ["metrics:server", "metrics:containers", "alert:threshold"].includes(event))).toEqual([]);
}

describe("monitoring socket authorization", () => {
  it("denies unauthorized subscriptions without collecting or starting a timer", async () => {
    const { event, socket, service } = await fixture(false);
    await event("subscribe:metrics");
    expect(socket.rooms.has("metrics")).toBe(false);
    expect(socket.emit).toHaveBeenCalledWith("metrics:error", expect.objectContaining({ code: "FORBIDDEN_ROLE" }));
    expect(service.getServerMetrics).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expectNoMetrics(socket);
  });

  it("sends immediate metrics only after authorization is rechecked", async () => {
    const { event, socket, authorize } = await fixture();
    await event("subscribe:metrics");
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(socket.rooms.has("metrics")).toBe(true);
    expect(socket.emit).toHaveBeenCalledWith("metrics:server", serverMetrics);
    expect(socket.emit).toHaveBeenCalledWith("metrics:containers", containerMetrics);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("rejects access revoked during initial collection", async () => {
    const { event, socket, authorize } = await fixture();
    authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
    await event("subscribe:metrics");
    expectNoMetrics(socket);
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.rooms.has("metrics")).toBe(false);
  });

  it("retries an initial collection failure for an authorized administrator", async () => {
    const { event, socket, service } = await fixture();
    service.getServerMetrics.mockRejectedValueOnce(new Error("collector unavailable"));
    await event("subscribe:metrics");
    expectNoMetrics(socket);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.emit).toHaveBeenCalledWith("metrics:server", serverMetrics);
  });

  it("preserves the newest subscription when an older room join completes late", async () => {
    const { event, socket } = await fixture();
    let finishJoin!: () => void;
    socket.join.mockImplementationOnce(async (room) => {
      await new Promise<void>((resolve) => { finishJoin = resolve; });
      socket.rooms.add(room);
    });
    const older = event("subscribe:metrics");
    await vi.waitFor(() => expect(socket.join).toHaveBeenCalledTimes(1));
    await event("subscribe:metrics");
    finishJoin();
    await older;
    expect(socket.rooms.has("metrics")).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(socket.emit.mock.calls.filter(([name]) => name === "metrics:server")).toHaveLength(1);
  });

  it.each(["unsubscribe:metrics", "disconnect"])("cancels a pending subscription on %s", async (cancelEvent) => {
    const { event, socket, service } = await fixture();
    let complete!: (value: typeof serverMetrics) => void;
    service.getServerMetrics.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const pending = event("subscribe:metrics");
    await vi.waitFor(() => expect(service.getServerMetrics).toHaveBeenCalled());
    if (cancelEvent === "disconnect") socket.connected = false;
    await event(cancelEvent);
    complete(serverMetrics);
    await pending;
    expectNoMetrics(socket);
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.rooms.has("metrics")).toBe(false);
  });

  it.each(["interval", "collector"])("stops metrics and threshold alerts after revocation via %s", async (source) => {
    const { event, socket, authorize, collect, service } = await fixture();
    await event("subscribe:metrics");
    socket.emit.mockClear();
    authorize.mockResolvedValue(false);
    if (source === "interval") await vi.advanceTimersByTimeAsync(5_000);
    else await collect();
    expectNoMetrics(socket);
    expect(socket.rooms.has("metrics")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    if (source === "collector") expect(service.saveSnapshot).toHaveBeenCalledWith(serverMetrics);
  });

  it.each(["interval", "collector"])("fails closed on authorization errors via %s", async (source) => {
    const { event, socket, authorize, collect } = await fixture();
    await event("subscribe:metrics");
    socket.emit.mockClear();
    authorize.mockRejectedValue(new Error("authorization store unavailable"));
    if (source === "interval") await vi.advanceTimersByTimeAsync(5_000);
    else await collect();
    expectNoMetrics(socket);
    expect(socket.rooms.has("metrics")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends collector updates and threshold alerts to authorized subscribers", async () => {
    const { event, socket, collect, service } = await fixture();
    await event("subscribe:metrics");
    socket.emit.mockClear();
    await collect();
    expect(socket.emit).toHaveBeenCalledWith("metrics:server", serverMetrics);
    expect(socket.emit).toHaveBeenCalledWith("metrics:containers", containerMetrics);
    expect(socket.emit).toHaveBeenCalledWith("alert:threshold", expect.objectContaining({ type: "cpu", value: 95 }));
    expect(service.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(service.pruneOldSnapshots).toHaveBeenCalledTimes(1);
  });
});
