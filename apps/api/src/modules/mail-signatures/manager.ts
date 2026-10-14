import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../../config/env.js";

export class SignatureManagerError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
    this.name = "SignatureManagerError";
  }
}

const TIMEOUT_MS = 60_000;

function getScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/signature_manager.py"),
    resolve(currentDir, "../../../../system/python/signature_manager.py"),
    resolve(process.cwd(), "../../system/python/signature_manager.py"),
    resolve(process.cwd(), "system/python/signature_manager.py"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/** Runs one command of signature_manager.py with a JSON payload on stdin and returns its JSON answer. */
export function runSignatureManager<T extends object>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const pythonBin = env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
    const child = spawn(pythonBin, [getScriptPath(), command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        ...(env.SIGNATURES_DIR ? { VEXLYX_SIGNATURES_DIR: resolve(env.SIGNATURES_DIR) } : {}),
      },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new SignatureManagerError("signature_manager timed out", "TIMEOUT")));
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    child.on("error", (err) =>
      finish(() => reject(new SignatureManagerError(`Failed to start signature_manager: ${err.message}`, "SPAWN_ERROR"))),
    );
    child.on("close", (code) =>
      finish(() => {
        let parsed: (T & { error?: string; code?: string }) | null = null;
        try {
          parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "") as T & { error?: string; code?: string };
        } catch {
          parsed = null;
        }
        if (parsed?.error) {
          reject(new SignatureManagerError(parsed.error, parsed.code ?? "MANAGER_ERROR"));
        } else if (code !== 0 || !parsed) {
          reject(new SignatureManagerError(`signature_manager failed (code ${code}): ${stderr.trim().slice(-300)}`, "PROCESS_ERROR"));
        } else {
          resolvePromise(parsed);
        }
      }),
    );

    child.stdin.end(JSON.stringify(payload));
  });
}
