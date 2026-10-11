import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.setConfig({ testTimeout: 30_000 });

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
const projectsDir = realpathSync.native(mkdtempSync(join(tmpdir(), "vexlyx-files-")));
process.env.PROJECTS_DIR = projectsDir;

const { FileService } = await import("./service.js");
type FileError = import("./service.js").FileError;

const pythonBin = process.platform === "win32" ? "python" : "python3";
const hasPython = spawnSync(pythonBin, ["--version"]).status === 0;
const isPosix = process.platform !== "win32";

const PROJECTS: Record<string, { id: string; userId: string; deletedAt: Date | null }> = {
  p1: { id: "p1", userId: "u1", deletedAt: null },
  p2: { id: "p2", userId: "u2", deletedAt: null },
  gone: { id: "gone", userId: "u1", deletedAt: new Date() },
};

const prisma = {
  project: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => PROJECTS[where.id] ?? null),
  },
};

const service = new FileService(prisma as never);
const root = join(projectsDir, "p1");

/** Builds a zip with Python so entries like "../x" (which no sane zip tool would write) can exist. */
function makeZip(zipPath: string, entries: Record<string, string>): void {
  const script = [
    "import sys, json, zipfile",
    "with zipfile.ZipFile(sys.argv[1], 'w') as z:",
    "    for n, d in json.loads(sys.argv[2]).items(): z.writestr(n, d)",
  ].join("\n");
  const result = spawnSync(pythonBin, ["-c", script, zipPath, JSON.stringify(entries)]);
  if (result.status !== 0) throw new Error(`makeZip failed: ${result.stderr.toString()}`);
}

function listAll(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [rel, ...listAll(join(dir, entry.name), rel)] : [rel];
  });
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as FileError;
  }
  throw new Error("expected promise to reject");
}

beforeEach(() => {
  rmSync(projectsDir, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(join(projectsDir, "p2"), { recursive: true });
});

afterAll(() => {
  rmSync(projectsDir, { recursive: true, force: true });
});

describe("FileService — authorization", () => {
  it("returns 403 for another user's project and 404 for a missing or deleted one", async () => {
    for (const action of [
      (p: string, u: string) => service.chmod(u, p, "a.txt", "644"),
      (p: string, u: string) => service.extract(u, p, "a.zip", undefined),
      (p: string, u: string) => service.compress(u, p, ["a.txt"]),
    ]) {
      expect((await rejection(action("p2", "u1"))).statusCode).toBe(403);
      expect((await rejection(action("nope", "u1"))).statusCode).toBe(404);
      expect((await rejection(action("gone", "u1"))).statusCode).toBe(404);
    }
  });
});

describe("FileService.listDir — modes", () => {
  it("reports a three-digit octal mode for files and folders", async () => {
    writeFileSync(join(root, "a.txt"), "a");
    mkdirSync(join(root, "dir"));
    const nodes = await service.listDir("u1", "p1", "");
    for (const node of nodes) expect(node.mode).toMatch(/^[0-7]{3}$/);
  });
});

describe.skipIf(!isPosix)("FileService.chmod", () => {
  it("changes a file to 644 and a folder to 755", async () => {
    writeFileSync(join(root, "a.txt"), "a");
    mkdirSync(join(root, "dir"));
    await service.chmod("u1", "p1", "a.txt", "600");
    await service.chmod("u1", "p1", "dir", "700");
    expect(statSync(join(root, "a.txt")).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "dir")).mode & 0o777).toBe(0o700);

    await service.chmod("u1", "p1", "a.txt", "644");
    await service.chmod("u1", "p1", "dir", "755");
    expect(statSync(join(root, "a.txt")).mode & 0o777).toBe(0o644);
    expect(statSync(join(root, "dir")).mode & 0o777).toBe(0o755);
  });

  it("is non-recursive unless asked", async () => {
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir", "child.txt"), "c");
    await service.chmod("u1", "p1", "dir/child.txt", "644");
    await service.chmod("u1", "p1", "dir", "700");
    expect(statSync(join(root, "dir", "child.txt")).mode & 0o777).toBe(0o644);
  });

  it("recursive mode keeps plain files non-executable and executables executable", async () => {
    mkdirSync(join(root, "dir/sub"), { recursive: true });
    writeFileSync(join(root, "dir/plain.txt"), "p");
    writeFileSync(join(root, "dir/sub/run.sh"), "r", { mode: 0o700 });
    const result = await service.chmod("u1", "p1", "dir", "755", true);
    expect(statSync(join(root, "dir")).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, "dir/sub")).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, "dir/plain.txt")).mode & 0o777).toBe(0o644);
    expect(statSync(join(root, "dir/sub/run.sh")).mode & 0o777).toBe(0o755);
    expect(result.updated).toBe(4);
  });

  it("recursive mode never follows a symlink out of the folder", async () => {
    const outside = join(projectsDir, "p2", "secret.txt");
    writeFileSync(outside, "s", { mode: 0o600 });
    mkdirSync(join(root, "dir"));
    symlinkSync(outside, join(root, "dir", "link"));
    await service.chmod("u1", "p1", "dir", "777", true);
    expect(statSync(outside).mode & 0o777).toBe(0o600);
  });

  it("rejects the project root, symlinks, and recursive on a file", async () => {
    writeFileSync(join(root, "a.txt"), "a");
    symlinkSync(join(root, "a.txt"), join(root, "link"));
    expect((await rejection(service.chmod("u1", "p1", "", "755"))).code).toBe("CHMOD_ROOT");
    expect((await rejection(service.chmod("u1", "p1", "link", "755"))).code).toBe("IS_SYMLINK");
    expect((await rejection(service.chmod("u1", "p1", "a.txt", "755", true))).code).toBe("NOT_A_DIRECTORY");
    expect((await rejection(service.chmod("u1", "p1", "../p2", "755"))).statusCode).toBe(400);
  });

  it("allows tightening config files that are protected from writes", async () => {
    writeFileSync(join(root, "wp-config.php"), "<?php");
    await service.chmod("u1", "p1", "wp-config.php", "640");
    expect(statSync(join(root, "wp-config.php")).mode & 0o777).toBe(0o640);
  });
});

describe.skipIf(!hasPython)("FileService.extract", () => {
  it("extracts into the archive's own folder by default", async () => {
    mkdirSync(join(root, "site"));
    makeZip(join(root, "site/pack.zip"), { "index.html": "hi", "css/app.css": "body{}" });
    const result = await service.extract("u1", "p1", "site/pack.zip", undefined);
    expect(result).toMatchObject({ destination: "site", files: 2, skipped: [] });
    expect(readFileSync(join(root, "site/index.html"), "utf-8")).toBe("hi");
    expect(readFileSync(join(root, "site/css/app.css"), "utf-8")).toBe("body{}");
  });

  it("extracts into a chosen destination, creating it", async () => {
    makeZip(join(root, "pack.zip"), { "a.txt": "a" });
    await service.extract("u1", "p1", "pack.zip", "deep/target");
    expect(readFileSync(join(root, "deep/target/a.txt"), "utf-8")).toBe("a");
  });

  it("rejects a zip-slip archive and leaves nothing behind", async () => {
    makeZip(join(root, "slip.zip"), { "ok.txt": "x", "../../p2/evil.txt": "pwn" });
    const err = await rejection(service.extract("u1", "p1", "slip.zip", undefined));
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("ARCHIVE_UNSAFE");
    expect(existsSync(join(projectsDir, "p2", "evil.txt"))).toBe(false);
    expect(listAll(root)).toEqual(["slip.zip"]);
  });

  it("rejects a destination outside the project root", async () => {
    makeZip(join(root, "pack.zip"), { "a.txt": "a" });
    const err = await rejection(service.extract("u1", "p1", "pack.zip", "../p2"));
    expect(err.statusCode).toBe(400);
    expect(listAll(join(projectsDir, "p2"))).toEqual([]);
  });

  it("refuses to overwrite by default and replaces when asked", async () => {
    writeFileSync(join(root, "a.txt"), "original");
    makeZip(join(root, "pack.zip"), { "a.txt": "new", "b.txt": "b" });
    const err = await rejection(service.extract("u1", "p1", "pack.zip", undefined));
    expect(err.code).toBe("EXTRACT_CONFLICT");
    expect(err.statusCode).toBe(409);
    expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("original");
    expect(existsSync(join(root, "b.txt"))).toBe(false);

    await service.extract("u1", "p1", "pack.zip", undefined, true);
    expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("new");
  });

  it("skips protected names and reports them", async () => {
    makeZip(join(root, "wp.zip"), { "wp-config.php": "<?php", ".env": "S=1", "index.php": "<?php" });
    const result = await service.extract("u1", "p1", "wp.zip", undefined);
    expect(result.skipped.sort()).toEqual([".env", "wp-config.php"]);
    expect(existsSync(join(root, "index.php"))).toBe(true);
    expect(existsSync(join(root, "wp-config.php"))).toBe(false);
    expect(existsSync(join(root, ".env"))).toBe(false);
  });

  it("rejects unsupported file types and missing archives", async () => {
    writeFileSync(join(root, "notes.txt"), "n");
    expect((await rejection(service.extract("u1", "p1", "notes.txt", undefined))).code).toBe("UNSUPPORTED_ARCHIVE");
    expect((await rejection(service.extract("u1", "p1", "ghost.zip", undefined))).statusCode).toBe(404);
  });

  it("rejects a corrupt zip with a 400", async () => {
    writeFileSync(join(root, "bad.zip"), "PK\x03\x04 definitely not a zip");
    const err = await rejection(service.extract("u1", "p1", "bad.zip", undefined));
    expect(err.statusCode).toBe(400);
  });

  it.skipIf(!isPosix)("will not write through a symlinked folder that points outside the project", async () => {
    symlinkSync(join(projectsDir, "p2"), join(root, "out"));
    makeZip(join(root, "pack.zip"), { "out/evil.txt": "pwn" });
    const err = await rejection(service.extract("u1", "p1", "pack.zip", undefined));
    expect(err.code).toBe("SYMLINK_ESCAPE");
    expect(existsSync(join(projectsDir, "p2", "evil.txt"))).toBe(false);
  });
});

describe.skipIf(!hasPython)("FileService.compress", () => {
  function entryNames(zipPath: string): string[] {
    const script = "import sys, zipfile; print('\\n'.join(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))";
    return spawnSync(pythonBin, ["-c", script, zipPath]).stdout.toString().trim().split(/\r?\n/);
  }

  it("zips exactly the selection, relative to its common folder", async () => {
    mkdirSync(join(root, "site/assets"), { recursive: true });
    writeFileSync(join(root, "site/index.html"), "hi");
    writeFileSync(join(root, "site/assets/app.css"), "css");
    writeFileSync(join(root, "site/notes.txt"), "n");
    writeFileSync(join(root, "site/other.txt"), "o");

    const result = await service.compress("u1", "p1", ["site/assets", "site/notes.txt"], "site/out.zip");
    expect(result).toMatchObject({ path: "site/out.zip", files: 2 });
    expect(entryNames(join(root, "site/out.zip"))).toEqual(["assets/", "assets/app.css", "notes.txt"]);
  });

  it("ignores items already covered by a selected folder", async () => {
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir/a.txt"), "a");
    const result = await service.compress("u1", "p1", ["dir", "dir/a.txt"], "out.zip");
    expect(result.files).toBe(1);
    expect(entryNames(join(root, "out.zip"))).toEqual(["dir/", "dir/a.txt"]);
  });

  it("picks a default archive name beside the selection", async () => {
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir/a.txt"), "a");
    const result = await service.compress("u1", "p1", ["dir/a.txt"]);
    expect(result.path).toMatch(/^dir\/archive-\d{14}\.zip$/);
    expect(existsSync(join(root, result.path))).toBe(true);
  });

  it("refuses to overwrite an existing archive and leaves no temp file", async () => {
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "out.zip"), "existing");
    const err = await rejection(service.compress("u1", "p1", ["a.txt"], "out.zip"));
    expect(err.statusCode).toBe(409);
    expect(readFileSync(join(root, "out.zip"), "utf-8")).toBe("existing");
    expect(listAll(root).sort()).toEqual(["a.txt", "out.zip"]);
  });

  it("rejects traversal, the project root, and missing sources", async () => {
    expect((await rejection(service.compress("u1", "p1", ["../p2"]))).statusCode).toBe(400);
    expect((await rejection(service.compress("u1", "p1", [""]))).code).toBe("COMPRESS_ROOT");
    expect((await rejection(service.compress("u1", "p1", ["ghost.txt"]))).statusCode).toBe(404);
  });

  it.skipIf(!isPosix)("skips symlinks instead of following them", async () => {
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir/a.txt"), "a");
    symlinkSync(join(projectsDir, "p2"), join(root, "dir/out"));
    const result = await service.compress("u1", "p1", ["dir"], "out.zip");
    expect(result.skipped).toEqual(["dir/out"]);
    expect(entryNames(join(root, "out.zip"))).toEqual(["dir/", "dir/a.txt"]);
  });
});
