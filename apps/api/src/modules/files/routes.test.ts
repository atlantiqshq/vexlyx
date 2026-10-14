import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.setConfig({ testTimeout: 30_000 });

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/vexlyx_test";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-characters-long";
const projectsDir = realpathSync.native(mkdtempSync(join(tmpdir(), "vexlyx-files-routes-")));
process.env.PROJECTS_DIR = projectsDir;

const { fileRoutes } = await import("./routes.js");
const { errorHandlerPlugin } = await import("../../plugins/error-handler.js");

const pythonBin = process.platform === "win32" ? "python" : "python3";
const hasPython = spawnSync(pythonBin, ["--version"]).status === 0;
const isPosix = process.platform !== "win32";
const root = join(projectsDir, "p1");

const PROJECTS: Record<string, { id: string; userId: string; deletedAt: Date | null }> = {
  p1: { id: "p1", userId: "u1", deletedAt: null },
  p2: { id: "p2", userId: "u2", deletedAt: null },
};

/** Builds the app with a requireAuth that behaves like the real one: 401 when signed out. */
async function buildApp(userId: string | null) {
  const app = Fastify();
  app.decorate("prisma", {
    project: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => PROJECTS[where.id] ?? null) },
  } as never);
  app.decorate("requireAuth", (async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!userId) {
      return reply.status(401).send({ error: "Authentication required", code: "UNAUTHORIZED", details: {} });
    }
  }) as never);
  app.decorateRequest("userId", null);
  app.addHook("onRequest", async (request) => {
    request.userId = userId;
  });
  await app.register(errorHandlerPlugin);
  await app.register(fileRoutes, { prefix: "/api/files" });
  return app as unknown as FastifyInstance;
}

function makeZip(zipPath: string, entries: Record<string, string>): void {
  const script = [
    "import sys, json, zipfile",
    "with zipfile.ZipFile(sys.argv[1], 'w') as z:",
    "    for n, d in json.loads(sys.argv[2]).items(): z.writestr(n, d)",
  ].join("\n");
  const result = spawnSync(pythonBin, ["-c", script, zipPath, JSON.stringify(entries)]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}

const ROUTES: Array<{ name: string; url: string; payload: Record<string, unknown> }> = [
  { name: "chmod", url: "chmod", payload: { path: "a.txt", mode: "644" } },
  { name: "extract", url: "extract", payload: { path: "a.zip" } },
  { name: "compress", url: "compress", payload: { paths: ["a.txt"] } },
];

beforeEach(() => {
  rmSync(projectsDir, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  mkdirSync(join(projectsDir, "p2"), { recursive: true });
});

afterAll(() => {
  rmSync(projectsDir, { recursive: true, force: true });
});

describe("file archive & permission routes — auth", () => {
  it.each(ROUTES)("$name returns 401 when signed out", async ({ url, payload }) => {
    const app = await buildApp(null);
    const res = await app.inject({ method: "POST", url: `/api/files/p1/${url}`, payload });
    expect(res.statusCode).toBe(401);
  });

  it.each(ROUTES)("$name returns 403 for another user's project", async ({ url, payload }) => {
    const app = await buildApp("u1");
    const res = await app.inject({ method: "POST", url: `/api/files/p2/${url}`, payload });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it.each(ROUTES)("$name returns 404 for an unknown project", async ({ url, payload }) => {
    const app = await buildApp("u1");
    const res = await app.inject({ method: "POST", url: `/api/files/missing/${url}`, payload });
    expect(res.statusCode).toBe(404);
  });
});

describe("file archive & permission routes — validation", () => {
  it.each(["999", "7777", "abc", "64", "4755", ""])("chmod rejects mode %j", async (mode) => {
    const app = await buildApp("u1");
    const res = await app.inject({ method: "POST", url: "/api/files/p1/chmod", payload: { path: "a.txt", mode } });
    expect(res.statusCode).toBe(400);
  });

  it("compress rejects an empty selection and a non-zip archive name", async () => {
    const app = await buildApp("u1");
    const empty = await app.inject({ method: "POST", url: "/api/files/p1/compress", payload: { paths: [] } });
    expect(empty.statusCode).toBe(400);
    const wrongExt = await app.inject({
      method: "POST",
      url: "/api/files/p1/compress",
      payload: { paths: ["a.txt"], archivePath: "out.exe" },
    });
    expect(wrongExt.statusCode).toBe(400);
  });

  it("extract rejects a missing path", async () => {
    const app = await buildApp("u1");
    const res = await app.inject({ method: "POST", url: "/api/files/p1/extract", payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe.skipIf(!isPosix)("chmod route", () => {
  it("changes the mode on disk", async () => {
    writeFileSync(join(root, "a.txt"), "a");
    const app = await buildApp("u1");
    const res = await app.inject({ method: "POST", url: "/api/files/p1/chmod", payload: { path: "a.txt", mode: "600" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: "600", updated: 1 });
    expect(statSync(join(root, "a.txt")).mode & 0o777).toBe(0o600);
  });
});

describe.skipIf(!hasPython)("archive routes — end to end", () => {
  it("extracts an uploaded zip", async () => {
    makeZip(join(root, "site.zip"), { "index.html": "hello", "img/logo.txt": "logo" });
    const app = await buildApp("u1");
    const res = await app.inject({ method: "POST", url: "/api/files/p1/extract", payload: { path: "site.zip" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ files: 2, skipped: [] });
    expect(readFileSync(join(root, "img/logo.txt"), "utf-8")).toBe("logo");
  });

  it("rejects a zip-slip archive with a 400 and writes nothing outside the project", async () => {
    makeZip(join(root, "slip.zip"), { "../../p2/evil.txt": "pwn" });
    const app = await buildApp("u1");
    const res = await app.inject({ method: "POST", url: "/api/files/p1/extract", payload: { path: "slip.zip" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "ARCHIVE_UNSAFE" });
    expect(existsSync(join(projectsDir, "p2", "evil.txt"))).toBe(false);
  });

  it("compresses a selection into a zip inside the project", async () => {
    writeFileSync(join(root, "a.txt"), "a");
    writeFileSync(join(root, "b.txt"), "b");
    const app = await buildApp("u1");
    const res = await app.inject({
      method: "POST",
      url: "/api/files/p1/compress",
      payload: { paths: ["a.txt", "b.txt"], archivePath: "both.zip" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ path: "both.zip", files: 2 });
    expect(existsSync(join(root, "both.zip"))).toBe(true);
  });
});
