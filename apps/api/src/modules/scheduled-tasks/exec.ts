import { spawn } from "node:child_process";
import { z } from "zod";
import type { FastifyBaseLogger } from "fastify";
import { env } from "../../config/env.js";
import { getDockerManagerScriptPath } from "../deploy/service.js";
import { SCHEDULED_TASK_OUTPUT_MAX_BYTES } from "@vexlyx/shared";

export interface ExecRequest {
  projectDir: string;
  shellCommand: string;
  runId: string;
  timeoutSeconds: number;
}

const ExecResultSchema = z.object({
  status: z.enum(["success", "failed", "timeout", "skipped"]),
  exitCode: z.number().int().nullable(),
  output: z.string(),
  truncated: z.boolean(),
  reason: z.string().nullable().optional(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;

export type TaskRunner = (request: ExecRequest) => Promise<ExecResult>;

/** The Python side enforces the timeout itself; this is only a backstop if it stops answering. */
const RUNNER_GRACE_SECONDS = 90;

const failed = (output: string): ExecResult => ({ status: "failed", exitCode: null, output, truncated: false, reason: null });

/** Runs one command in the project's container through docker_manager.py's `exec` action. */
export function createContainerRunner(logger: FastifyBaseLogger): TaskRunner {
  return (request) =>
    new Promise<ExecResult>((resolve) => {
      const pythonBin = env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
      const child = spawn(pythonBin, [getDockerManagerScriptPath()], { stdio: ["pipe", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (result: ExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(backstop);
        resolve(result);
      };

      const backstop = setTimeout(() => {
        child.kill("SIGKILL");
        settle(failed("The command runner stopped responding and was stopped."));
      }, (request.timeoutSeconds + RUNNER_GRACE_SECONDS) * 1000);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        logger.error({ err }, "docker_manager.py spawn error");
        settle(failed(`Could not start the command runner: ${err.message}`));
      });
      child.on("close", () => {
        const lastLine = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
        let parsed: unknown;
        try {
          parsed = JSON.parse(lastLine);
        } catch {
          logger.warn({ stderr: stderr.slice(0, 500) }, "docker_manager.py exec returned no result");
          settle(failed("The command runner returned no result."));
          return;
        }
        const result = ExecResultSchema.safeParse(parsed);
        if (result.success) {
          settle(result.data);
          return;
        }
        const message = (parsed as { error?: unknown } | null)?.error;
        settle(failed(`Could not run the command: ${typeof message === "string" ? message : "unexpected runner response"}`));
      });

      child.stdin.write(
        JSON.stringify({
          command: "exec",
          projectDir: request.projectDir,
          shellCommand: request.shellCommand,
          runId: request.runId,
          timeoutSeconds: request.timeoutSeconds,
          maxOutputBytes: SCHEDULED_TASK_OUTPUT_MAX_BYTES,
        }),
      );
      child.stdin.end();
    });
}
