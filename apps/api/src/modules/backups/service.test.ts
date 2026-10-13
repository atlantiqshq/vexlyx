import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { Server as SocketIOServer } from "socket.io";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { BackupService, BackupError } = await import("./service.js");
const { DeployService } = await import("../deploy/service.js");

const ACTOR_ID = "admin-1";
const SNAPSHOT_ID = "snap-1";
const PROJECT_ID = "p1";

/** Fake backup_manager.py process printing one JSON result line then exiting. */
function backupScriptSucceeds() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: () => void; end: () => void };
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: () => undefined,
    end: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "result", success: true })}\n`));
        child.emit("close", 0);
      });
    },
  };
  return child;
}

function fixture(project: { containerId: string | null }) {
  const prisma = {
    backupSnapshot: {
      findUnique: vi.fn().mockResolvedValue({
        id: SNAPSHOT_ID,
        status: "COMPLETED",
        archivePath: "/backups/snap-1.tar.gz",
        manifest: { projects: [{ id: PROJECT_ID }], databases: [], mail: [], dns: [] },
      }),
    },
    project: {
      findUnique: vi.fn().mockResolvedValue({
        id: PROJECT_ID,
        userId: "owner-1",
        deletedAt: null,
        ...project,
      }),
      update: vi.fn(),
    },
  };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const emit = vi.fn();
  const io = { to: vi.fn().mockReturnValue({ emit }) } as unknown as SocketIOServer;
  const auditLog = { log: vi.fn() };
  const service = new BackupService(
    prisma as unknown as PrismaClient,
    logger as unknown as FastifyBaseLogger,
    auditLog as never,
  );
  return { service, logger, io, emit, auditLog };
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => backupScriptSucceeds());
});

afterEach(() => vi.restoreAllMocks());

describe("BackupService.restoreItem — project container handling (#47)", () => {
  it("aborts before touching any files when the container cannot be stopped", async () => {
    const containerAction = vi
      .spyOn(DeployService.prototype, "containerAction")
      .mockRejectedValue(new Error("docker compose stop timed out"));
    const { service, logger, io, emit, auditLog } = fixture({ containerId: "c1" });

    const err = await service
      .restoreItem(ACTOR_ID, SNAPSHOT_ID, "project", PROJECT_ID, io)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BackupError);
    expect(err).toMatchObject({ code: "CONTAINER_STOP_FAILED", statusCode: 500 });
    expect((err as Error).message).toContain("docker compose stop timed out");
    expect(containerAction).toHaveBeenCalledTimes(1);
    expect(containerAction).toHaveBeenCalledWith("owner-1", PROJECT_ID, "stop");
    // restore_item (which overwrites the project's files) must never run.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID }),
      expect.stringContaining("could not be stopped"),
    );
    expect(emit).toHaveBeenCalledWith(
      "restore:completed",
      expect.objectContaining({ status: "FAILED" }),
    );
    expect(auditLog.log).not.toHaveBeenCalled();
  });

  it("stops the container, restores the files, then restarts it", async () => {
    const containerAction = vi
      .spyOn(DeployService.prototype, "containerAction")
      .mockResolvedValue({ message: "ok", containerStatus: "running" });
    const { service, io, emit, auditLog } = fixture({ containerId: "c1" });

    await service.restoreItem(ACTOR_ID, SNAPSHOT_ID, "project", PROJECT_ID, io);

    expect(containerAction.mock.calls.map((call) => call[2])).toEqual(["stop", "start"]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "restore:completed",
      expect.objectContaining({ status: "COMPLETED" }),
    );
    expect(auditLog.log).toHaveBeenCalledTimes(1);
  });

  it("restores without any container action when the project has no container", async () => {
    const containerAction = vi.spyOn(DeployService.prototype, "containerAction");
    const { service, io } = fixture({ containerId: null });

    await service.restoreItem(ACTOR_ID, SNAPSHOT_ID, "project", PROJECT_ID, io);

    expect(containerAction).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a completed restore successful but logs and reports a failed restart", async () => {
    vi.spyOn(DeployService.prototype, "containerAction").mockImplementation(
      async (_userId, _projectId, action) => {
        if (action === "start") throw new Error("port already allocated");
        return { message: "ok", containerStatus: "exited" };
      },
    );
    const { service, logger, io, emit } = fixture({ containerId: "c1" });

    await expect(
      service.restoreItem(ACTOR_ID, SNAPSHOT_ID, "project", PROJECT_ID, io),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID }),
      expect.stringContaining("could not be restarted"),
    );
    expect(emit).toHaveBeenCalledWith(
      "restore:progress",
      expect.objectContaining({ message: expect.stringContaining("could not be restarted") }),
    );
    expect(emit).toHaveBeenCalledWith(
      "restore:completed",
      expect.objectContaining({ status: "COMPLETED" }),
    );
  });
});
