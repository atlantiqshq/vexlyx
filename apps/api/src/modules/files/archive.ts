import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../../config/env.js";

export class ArchiveCommandError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "ArchiveCommandError";
  }
}

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

const STATUS_BY_CODE: Record<string, number> = {
  ARCHIVE_UNSAFE: 400,
  ARCHIVE_UNSUPPORTED: 400,
  ARCHIVE_CORRUPT: 400,
  ARCHIVE_EMPTY: 400,
  ARCHIVE_NOT_FOUND: 404,
  ARCHIVE_SOURCE_NOT_FOUND: 404,
  ARCHIVE_TOO_LARGE: 413,
  ARCHIVE_TOO_MANY_ENTRIES: 413,
};

export const ARCHIVE_EXTENSIONS = [".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2"];

function getArchiveScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/archive_manager.py"),
    resolve(currentDir, "../../../../system/python/archive_manager.py"),
    resolve(process.cwd(), "../../system/python/archive_manager.py"),
    resolve(process.cwd(), "system/python/archive_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0] ?? resolve(process.cwd(), "system/python/archive_manager.py");
}

interface ArchiveManagerLine {
  done?: boolean;
  error?: string;
  code?: string;
}

export function runArchiveCommand<T extends object>(
  payload: Record<string, unknown>,
): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const pythonBin = env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
    const child = spawn(pythonBin, [getArchiveScriptPath()], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill();
      if (settled) return;
      settled = true;
      reject(new ArchiveCommandError("Archive operation timed out", "ARCHIVE_TIMEOUT", 504));
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(
        new ArchiveCommandError(
          `Failed to start archive helper: ${err.message}`,
          "ARCHIVE_SPAWN_ERROR",
          500,
        ),
      );
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      const lastLine = stdout.trim().split("\n").pop() ?? "";
      let parsed: ArchiveManagerLine | null = null;
      try {
        parsed = JSON.parse(lastLine) as ArchiveManagerLine;
      } catch {
        parsed = null;
      }

      if (parsed?.error) {
        const code = parsed.code ?? "ARCHIVE_ERROR";
        reject(new ArchiveCommandError(parsed.error, code, STATUS_BY_CODE[code] ?? 500));
        return;
      }
      if (exitCode !== 0 || !parsed?.done) {
        reject(
          new ArchiveCommandError(
            `Archive helper failed${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
            "ARCHIVE_ERROR",
            500,
          ),
        );
        return;
      }
      resolvePromise(parsed as T);
    });

    child.stdin.end(JSON.stringify(payload));
  });
}
