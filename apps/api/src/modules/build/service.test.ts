import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUILD_FAILURE_PREFIX, readBuildFailure } from "./diagnostics.js";
import { TriggerBuildBodySchema } from "./schema.js";

const state = vi.hoisted(() => ({
  responses: [] as Array<{ stdout: string[]; code: number; delayMs?: number }>,
  payloads: [] as Array<Record<string, unknown>>,
  emit: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: () => true,
  readdirSync: () => ["package.json"],
}));
vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = new EventEmitter();
    const response = state.responses.shift();
    if (!response) throw new Error("Unexpected system command");
    return Object.assign(child, {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: {
        write: (payload: string) => state.payloads.push(JSON.parse(payload)),
        end: () =>
          queueMicrotask(() => {
            for (const chunk of response.stdout)
              (child as unknown as { stdout: EventEmitter }).stdout.emit(
                "data",
                Buffer.from(chunk),
              );
            if (response.delayMs)
              setTimeout(
                () => child.emit("close", response.code),
                response.delayMs,
              );
            else child.emit("close", response.code);
          }),
      },
    });
  },
}));
vi.mock("../../config/env.js", () => ({
  env: { PROJECTS_DIR: "/projects", NIXPACKS_IMAGE_PREFIX: "vexlyx" },
}));
vi.mock("../deploy/service.js", () => ({
  runDockerDeploy: vi.fn(),
  runDockerStatus: vi.fn(),
}));
vi.mock("../git/service.js", () => ({ runGitManager: vi.fn() }));
vi.mock("../env/service.js", () => ({
  EnvService: class {
    getDecryptedMap = async () => ({});
  },
}));
vi.mock("../github/service.js", () => ({
  getGitHubInstallationToken: vi.fn(),
}));
vi.mock("../cleanup/service.js", () => ({
  CleanupService: class {
    getSettings = async () => null;
  },
}));
vi.mock("../../plugins/socket.js", () => ({
  getIO: () => ({ to: () => ({ emit: state.emit }) }),
}));

const { BuildService, createBuildProcessor } = await import("./service.js");
const failure = {
  code: "INVALID_PNPM_WORKSPACE",
  message: "pnpm-workspace.yaml has no packages list",
  details: { file: "pnpm-workspace.yaml", remediation: 'Add packages: ["."]' },
};
const deployment = {
  id: "d1",
  projectId: "p1",
  status: "QUEUED",
  commitHash: null,
  commitMsg: null,
  buildLogs: null as string | null,
  duration: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function setup() {
  const prisma = {
    project: {
      findUnique: vi.fn(async () => ({
        id: "p1",
        userId: "u1",
        name: "app",
        type: "NEXTJS",
        gitUrl: null,
        buildCmd: null,
        startCmd: null,
        deletedAt: null,
      })),
      update: vi.fn(),
    },
    deployment: {
      update: vi.fn(async (_args: unknown) => undefined),
      create: vi.fn(async () => deployment),
      findUnique: vi.fn(async () => deployment),
    },
  };
  const logger = { error: vi.fn(), info: vi.fn() };
  return {
    prisma,
    processor: createBuildProcessor(prisma as never, logger as never),
    service: new BuildService(prisma as never),
  };
}

const job = {
  name: "build",
  data: {
    deploymentId: "d1",
    projectId: "p1",
    userId: "u1",
    projectDir: "/projects/p1",
    imageName: "test",
    buildCmd: null,
  },
};

beforeEach(() => {
  state.responses = [];
  state.payloads = [];
  state.emit.mockClear();
});

describe("build preflight diagnostics", () => {
  it("waits for an older log write before persisting the final structured failure", async () => {
    vi.useFakeTimers();
    try {
      const { prisma, processor } = setup();
      let releaseWrite: (() => void) | undefined;
      prisma.deployment.update.mockImplementation(async (args: unknown) => {
        const update = args as { data: { status?: string } };
        if (update.data.status === undefined)
          await new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
      });
      state.responses = [
        {
          stdout: [
            JSON.stringify({
              error: failure.message,
              code: failure.code,
              details: failure.details,
            }),
          ],
          code: 1,
          delayMs: 500,
        },
      ];
      const outcome = processor(job).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(250);
      expect(releaseWrite).toBeDefined();
      await vi.advanceTimersByTimeAsync(500);
      expect(prisma.deployment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "FAILED" }),
        }),
      );
      releaseWrite?.();
      expect(await outcome).toMatchObject({ code: failure.code });
      expect(prisma.deployment.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "FAILED",
            buildLogs: expect.stringContaining(BUILD_FAILURE_PREFIX),
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains structured plan failures in deployment status, logs, polling, and live events", async () => {
    const { prisma, processor, service } = setup();
    state.responses = [
      {
        stdout: [
          JSON.stringify({
            error: failure.message,
            code: failure.code,
            details: failure.details,
          }),
        ],
        code: 1,
      },
    ];
    await expect(processor(job)).rejects.toMatchObject({
      code: failure.code,
      details: failure.details,
    });
    expect(state.payloads.map((payload) => payload.command)).toEqual(["plan"]);
    const final = prisma.deployment.update.mock.calls.at(
      -1,
    )?.[0] as unknown as { data: { status: string; buildLogs: string } };
    expect(final.data.status).toBe("FAILED");
    expect(readBuildFailure(final.data.buildLogs)).toEqual(failure);
    prisma.deployment.findUnique.mockResolvedValue({
      ...deployment,
      ...final.data,
    });
    expect((await service.getDeployment("u1", "p1", "d1")).failure).toEqual(
      failure,
    );
    expect(state.emit).toHaveBeenCalledWith(
      "log:build",
      expect.objectContaining({
        line: expect.stringContaining(BUILD_FAILURE_PREFIX),
      }),
    );
  });

  it.each([true, false])(
    "preserves split build errors with a trailing newline: %s",
    async (newline) => {
      const { processor } = setup();
      const error = JSON.stringify({
        error: failure.message,
        code: failure.code,
        details: failure.details,
      });
      state.responses = [
        {
          stdout: [
            JSON.stringify({
              framework: "nextjs",
              buildCmd: "pnpm run build",
              startCmd: "pnpm run start",
              detectedType: "NEXTJS",
            }),
          ],
          code: 0,
        },
        {
          stdout: [error.slice(0, 20), error.slice(20) + (newline ? "\n" : "")],
          code: 1,
        },
      ];
      await expect(
        processor({
          ...job,
          data: { ...job.data, installCmd: "pnpm install" },
        }),
      ).rejects.toMatchObject({ code: failure.code, details: failure.details });
      expect(state.payloads[0]?.installCmd).toBe("pnpm install");
      expect(state.payloads[1]?.installCmd).toBe("pnpm install");
    },
  );

  it("keeps absent overrides absent and forwards only explicit overrides into the queue", async () => {
    const { service } = setup();
    const enqueue = vi.fn();
    await service.triggerBuild("u1", "p1", {}, enqueue);
    expect(enqueue.mock.calls[0]?.[0]).not.toHaveProperty("installCmd");
    await service.triggerBuild(
      "u1",
      "p1",
      { installCmd: "pnpm install --offline" },
      enqueue,
    );
    expect(enqueue.mock.calls[1]?.[0]).toHaveProperty(
      "installCmd",
      "pnpm install --offline",
    );
  });

  it("rejects another user's deployment access", async () => {
    await expect(
      setup().service.getDeployment("u2", "p1", "d1"),
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
  });

  it("does not manufacture diagnostics for old or malformed logs", () => {
    for (const logs of [
      null,
      "old failure",
      BUILD_FAILURE_PREFIX + "{",
      BUILD_FAILURE_PREFIX + '{"code":42}',
      BUILD_FAILURE_PREFIX + JSON.stringify(failure) + "\n[vexlyx:error] A later failure\n",
    ]) {
      expect(readBuildFailure(logs)).toBeNull();
    }
  });

  it("validates explicit install overrides", () => {
    expect(TriggerBuildBodySchema.parse({})).toEqual({});
    expect(TriggerBuildBodySchema.safeParse({ installCmd: " " }).success).toBe(
      false,
    );
    expect(TriggerBuildBodySchema.safeParse({ installCmd: 42 }).success).toBe(
      false,
    );
  });
});
