import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";
import { ARCHIVE_EXTENSIONS, ArchiveCommandError, runArchiveCommand } from "./archive.js";
import { isProtectedWriteName, safePath } from "./schema.js";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class FileError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "FileError";
  }
}

// ---------------------------------------------------------------------------
// File node shape
// ---------------------------------------------------------------------------

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  mtime?: string;
  extension?: string;
  mode?: string;
  children?: FileNode[];
}

export interface ChmodResult {
  mode: string;
  updated: number;
}

export interface ExtractResult {
  destination: string;
  files: number;
  skipped: string[];
}

export interface CompressResult {
  path: string;
  files: number;
  skipped: string[];
}

function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

function safePathOrThrow(rawPath: string, forWrite = false): string {
  try {
    return safePath(rawPath, forWrite);
  } catch (err) {
    throw new FileError(err instanceof Error ? err.message : "Invalid path", "INVALID_PATH", 400);
  }
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

function commonParentDir(relPaths: string[]): string {
  const parents = relPaths.map((rel) => path.posix.dirname(rel).split("/").filter((p) => p && p !== "."));
  const first = parents[0] ?? [];
  let length = first.length;
  for (const parts of parents) {
    let i = 0;
    while (i < length && parts[i] === first[i]) i += 1;
    length = i;
  }
  return first.slice(0, length).join("/");
}

// ---------------------------------------------------------------------------
// Max readable file size (2 MB)
// ---------------------------------------------------------------------------

const MAX_READ_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FileService {
  constructor(private prisma: PrismaClient) { }

  // ── Security: resolve + guard ──────────────────────────────────────────

  private async resolveAndGuard(
    userId: string,
    projectId: string,
    relPath: string,
    forWrite = false,
  ): Promise<string> {
    // Verify ownership
    await this.findOwnedProject(userId, projectId);

    let sanitized: string;
    try {
      sanitized = safePath(relPath, forWrite);
    } catch (err) {
      throw new FileError(
        err instanceof Error ? err.message : "Invalid path",
        "INVALID_PATH",
        400,
      );
    }
    const projectRoot = path.resolve(env.PROJECTS_DIR, projectId);
    const target = path.resolve(projectRoot, sanitized);

    // After resolve: must still be inside project root
    if (!target.startsWith(projectRoot + path.sep) && target !== projectRoot) {
      throw new FileError("Path escapes project root", "PATH_TRAVERSAL", 403);
    }

    // Follow symlinks and verify the real path stays inside root
    try {
      const real = await fs.realpath(target);
      if (!real.startsWith(projectRoot + path.sep) && real !== projectRoot) {
        throw new FileError("Symlink escapes project root", "SYMLINK_ESCAPE", 403);
      }
    } catch (err) {
      // realpath throws ENOENT for non-existent paths (ok for create ops)
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") throw err;
    }

    return target;
  }

  private projectRoot(projectId: string): string {
    return path.resolve(env.PROJECTS_DIR, projectId);
  }

  // ── List directory ─────────────────────────────────────────────────────

  async listDir(
    userId: string,
    projectId: string,
    relPath: string,
    depth = 1,
  ): Promise<FileNode[]> {
    const target = await this.resolveAndGuard(userId, projectId, relPath || "");
    return this.readDirRecursive(
      target,
      this.projectRoot(projectId),
      depth,
    );
  }

  private async readDirRecursive(
    absDir: string,
    rootDir: string,
    depth: number,
  ): Promise<FileNode[]> {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      throw new FileError("Directory not found or not accessible", "DIR_NOT_FOUND", 404);
    }

    const nodes: FileNode[] = [];

    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = path.relative(rootDir, abs).replace(/\\/g, "/");
      const isDir = entry.isDirectory();

      const node: FileNode = {
        name: entry.name,
        path: rel,
        type: isDir ? "dir" : "file",
      };

      if (!isDir) {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (ext) node.extension = ext;
      }

      try {
        const stat = await fs.stat(abs);
        node.mode = formatMode(stat.mode);
        if (!isDir) {
          node.size = stat.size;
          node.mtime = stat.mtime.toISOString();
        }
      } catch {
        // skip stat on error
      }

      if (isDir && depth > 1) {
        node.children = await this.readDirRecursive(abs, rootDir, depth - 1);
      }

      nodes.push(node);
    }

    // Dirs first, then files, alphabetical within each group
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return nodes;
  }

  // ── Read file ──────────────────────────────────────────────────────────

  async readFile(
    userId: string,
    projectId: string,
    relPath: string,
  ): Promise<string> {
    const target = await this.resolveAndGuard(userId, projectId, relPath);

    const stat = await fs.stat(target).catch(() => {
      throw new FileError("File not found", "FILE_NOT_FOUND", 404);
    });

    if (stat.isDirectory()) {
      throw new FileError("Path is a directory, not a file", "IS_DIRECTORY", 400);
    }

    if (stat.size > MAX_READ_BYTES) {
      throw new FileError(
        `File is too large to edit in browser (max ${MAX_READ_BYTES / 1024 / 1024} MB)`,
        "FILE_TOO_LARGE",
        413,
      );
    }

    const content = await fs.readFile(target, "utf-8");
    return content;
  }

  // ── Create file (never overwrites) ──────────────────────────────────────

  async createFile(
    userId: string,
    projectId: string,
    relPath: string,
    content = "",
  ): Promise<void> {
    const target = await this.resolveAndGuard(userId, projectId, relPath, true);

    const exists = await fs
      .lstat(target)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      throw new FileError(
        `A file or folder named "${path.posix.basename(relPath)}" already exists`,
        "FILE_ALREADY_EXISTS",
        409,
      );
    }

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Atomic write via temp file
    const tmp = `${target}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, target);
  }

  // ── Write file ─────────────────────────────────────────────────────────

  async writeFile(
    userId: string,
    projectId: string,
    relPath: string,
    content: string,
    createOnly = false,
  ): Promise<void> {
    const target = await this.resolveAndGuard(userId, projectId, relPath, true);

    const stat = await fs.lstat(target).catch(() => null);
    if (stat) {
      if (stat.isDirectory()) {
        throw new FileError(
          `Cannot overwrite directory "${path.posix.basename(relPath)}" with a file`,
          "IS_DIRECTORY",
          400,
        );
      }
      if (createOnly) {
        throw new FileError(
          `A file or folder named "${path.posix.basename(relPath)}" already exists`,
          "FILE_ALREADY_EXISTS",
          409,
        );
      }
    }

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Atomic write via temp file
    const tmp = `${target}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, target);
  }

  // ── Delete ─────────────────────────────────────────────────────────────

  async deleteNode(
    userId: string,
    projectId: string,
    relPath: string,
  ): Promise<void> {
    const target = await this.resolveAndGuard(userId, projectId, relPath, true);
    const root = this.projectRoot(projectId);

    // Never allow deleting the project root itself
    if (target === root) {
      throw new FileError("Cannot delete project root", "DELETE_ROOT", 400);
    }

    await fs.rm(target, { recursive: true, force: true });
  }

  // ── Rename ─────────────────────────────────────────────────────────────

  async rename(
    userId: string,
    projectId: string,
    fromRel: string,
    toRel: string,
  ): Promise<void> {
    const from = await this.resolveAndGuard(userId, projectId, fromRel, true);
    const to = await this.resolveAndGuard(userId, projectId, toRel, true);

    await fs.stat(from).catch(() => {
      throw new FileError("Source file not found", "SOURCE_NOT_FOUND", 404);
    });

    const destExists = await fs.lstat(to).then(() => true).catch(() => false);
    if (destExists) {
      throw new FileError(
        `A file or folder named "${path.posix.basename(toRel)}" already exists`,
        "DESTINATION_ALREADY_EXISTS",
        409,
      );
    }

    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
  }

  // ── Mkdir ──────────────────────────────────────────────────────────────

  async mkdir(
    userId: string,
    projectId: string,
    relPath: string,
  ): Promise<void> {
    const target = await this.resolveAndGuard(userId, projectId, relPath, true);
    const exists = await fs
      .lstat(target)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      throw new FileError(
        `A file or folder named "${path.posix.basename(relPath)}" already exists`,
        "DIRECTORY_ALREADY_EXISTS",
        409,
      );
    }
    await fs.mkdir(target, { recursive: true });
  }

  // ── Copy ───────────────────────────────────────────────────────────────

  async copy(
    userId: string,
    projectId: string,
    fromRel: string,
    toRel: string,
  ): Promise<void> {
    const from = await this.resolveAndGuard(userId, projectId, fromRel);
    const to = await this.resolveAndGuard(userId, projectId, toRel, true);

    const stat = await fs.stat(from).catch(() => {
      throw new FileError("Source not found", "SOURCE_NOT_FOUND", 404);
    });

    const destExists = await fs.stat(to).then(() => true).catch(() => false);
    if (destExists) {
      throw new FileError(
        `Destination "${path.posix.basename(toRel)}" already exists`,
        "DESTINATION_ALREADY_EXISTS",
        409,
      );
    }

    await fs.mkdir(path.dirname(to), { recursive: true });

    if (stat.isDirectory()) {
      await fs.cp(from, to, { recursive: true });
    } else {
      await fs.copyFile(from, to);
    }
  }

  // ── Move ───────────────────────────────────────────────────────────────

  async move(
    userId: string,
    projectId: string,
    fromRel: string,
    toRel: string,
  ): Promise<void> {
    const from = await this.resolveAndGuard(userId, projectId, fromRel, true);
    const to = await this.resolveAndGuard(userId, projectId, toRel, true);

    await fs.stat(from).catch(() => {
      throw new FileError("Source not found", "SOURCE_NOT_FOUND", 404);
    });

    const destExists = await fs.stat(to).then(() => true).catch(() => false);
    if (destExists) {
      throw new FileError(
        `Destination "${path.posix.basename(toRel)}" already exists`,
        "DESTINATION_ALREADY_EXISTS",
        409,
      );
    }

    await fs.mkdir(path.dirname(to), { recursive: true });
    try {
      await fs.rename(from, to);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "EXDEV") {
        await this.copy(userId, projectId, fromRel, toRel);
        await this.deleteNode(userId, projectId, fromRel);
      } else {
        throw err;
      }
    }
  }

  // ── Download (stream) ──────────────────────────────────────────────────

  async getDownloadStream(
    userId: string,
    projectId: string,
    relPath: string,
  ): Promise<{ stream: ReturnType<typeof createReadStream>; filename: string; size: number }> {
    const target = await this.resolveAndGuard(userId, projectId, relPath);

    const stat = await fs.stat(target).catch(() => {
      throw new FileError("File not found", "FILE_NOT_FOUND", 404);
    });

    if (stat.isDirectory()) {
      throw new FileError("Cannot download a directory directly, use export instead", "IS_DIRECTORY", 400);
    }

    return {
      stream: createReadStream(target),
      filename: path.basename(target),
      size: stat.size,
    };
  }

  // ── Upload (write stream) ──────────────────────────────────────────────

  async writeUploadStream(
    userId: string,
    projectId: string,
    relPath: string,
    readableStream: NodeJS.ReadableStream,
    overwrite = false,
  ): Promise<void> {
    const target = await this.resolveAndGuard(userId, projectId, relPath, true);

    const exists = await fs.lstat(target).then(() => true).catch(() => false);
    if (exists && !overwrite) {
      throw new FileError(
        `A file or folder named "${path.posix.basename(relPath)}" already exists`,
        "FILE_ALREADY_EXISTS",
        409,
      );
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    const ws = createWriteStream(target);
    await pipeline(readableStream, ws);
  }

  // ── Permissions (chmod) ────────────────────────────────────────────────

  async chmod(
    userId: string,
    projectId: string,
    relPath: string,
    mode: string,
    recursive = false,
  ): Promise<ChmodResult> {
    const target = await this.resolveAndGuard(userId, projectId, relPath);
    if (target === this.projectRoot(projectId)) {
      throw new FileError(
        "Cannot change permissions of the project root",
        "CHMOD_ROOT",
        400,
      );
    }

    const stat = await fs.lstat(target).catch(() => {
      throw new FileError("File or folder not found", "FILE_NOT_FOUND", 404);
    });
    if (stat.isSymbolicLink()) {
      throw new FileError("Cannot change permissions of a symlink", "IS_SYMLINK", 400);
    }
    if (recursive && !stat.isDirectory()) {
      throw new FileError("Recursive mode only applies to folders", "NOT_A_DIRECTORY", 400);
    }

    const numericMode = parseInt(mode, 8);

    if (!recursive) {
      await fs.chmod(target, numericMode);
      return { mode, updated: 1 };
    }

    const items = await this.collectTree(target);
    await fs.chmod(target, numericMode);
    let updated = 1;
    for (const item of items) {
      const itemMode = item.isDir
        ? numericMode
        : item.mode & 0o111
          ? numericMode
          : numericMode & 0o666;
      await fs.chmod(item.abs, itemMode);
      updated += 1;
    }
    return { mode, updated };
  }

  /** Walks a folder without following symlinks, capped at ARCHIVE_MAX_ENTRIES. */
  private async collectTree(
    rootDir: string,
  ): Promise<Array<{ abs: string; isDir: boolean; mode: number }>> {
    const items: Array<{ abs: string; isDir: boolean; mode: number }> = [];
    const pending = [rootDir];

    while (pending.length > 0) {
      const dir = pending.pop() as string;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const abs = path.join(dir, entry.name);
        const isDir = entry.isDirectory();
        const stat = await fs.lstat(abs);
        items.push({ abs, isDir, mode: stat.mode });
        if (items.length > env.ARCHIVE_MAX_ENTRIES) {
          throw new FileError(
            `Folder has more than ${env.ARCHIVE_MAX_ENTRIES} items`,
            "TOO_MANY_ENTRIES",
            413,
          );
        }
        if (isDir) pending.push(abs);
      }
    }

    return items;
  }

  // ── Extract archive ────────────────────────────────────────────────────

  async extract(
    userId: string,
    projectId: string,
    archiveRel: string,
    destinationRel: string | undefined,
    overwrite = false,
  ): Promise<ExtractResult> {
    const archive = await this.resolveAndGuard(userId, projectId, archiveRel);
    const root = this.projectRoot(projectId);

    const lowerName = archive.toLowerCase();
    if (!ARCHIVE_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
      throw new FileError(
        "Unsupported archive type (use .zip, .tar, .tar.gz or .tar.bz2)",
        "UNSUPPORTED_ARCHIVE",
        400,
      );
    }

    const archiveStat = await fs.lstat(archive).catch(() => {
      throw new FileError("Archive not found", "FILE_NOT_FOUND", 404);
    });
    if (!archiveStat.isFile()) {
      throw new FileError("Path is not a file", "NOT_A_FILE", 400);
    }

    const destRel = destinationRel
      ? safePathOrThrow(destinationRel, true)
      : path.posix.dirname(safePathOrThrow(archiveRel));
    const dest = await this.resolveAndGuard(userId, projectId, destRel, true);

    const destStat = await fs.lstat(dest).catch(() => null);
    if (destStat && !destStat.isDirectory()) {
      throw new FileError(
        "Destination exists and is not a folder",
        "DESTINATION_NOT_DIRECTORY",
        409,
      );
    }

    const staging = path.join(root, `.vexlyx-extract-${randomUUID()}`);

    try {
      await this.runArchive({
        command: "extract",
        archivePath: archive,
        stagingDir: staging,
        maxEntries: env.ARCHIVE_MAX_ENTRIES,
        maxBytes: env.ARCHIVE_MAX_EXTRACT_MB * 1024 * 1024,
      });

      const plan = await this.planExtraction(staging, root, destRel, overwrite);
      await fs.mkdir(dest, { recursive: true });

      let files = 0;
      for (const item of plan.items) {
        if (item.isDir) {
          await fs.mkdir(item.target, { recursive: true });
          continue;
        }
        await fs.mkdir(path.dirname(item.target), { recursive: true });
        await moveFile(item.abs, item.target);
        files += 1;
      }

      return { destination: destRel === "." ? "" : destRel, files, skipped: plan.skipped };
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * Last line of defence for extraction: re-checks the staged tree as it
   * really is on disk (not as the archive claims) through the same safePath
   * and root guards every other route uses, and refuses to merge into
   * anything that would be overwritten without `overwrite`.
   */
  private async planExtraction(
    staging: string,
    root: string,
    destRel: string,
    overwrite: boolean,
  ): Promise<{
    items: Array<{ abs: string; target: string; isDir: boolean }>;
    skipped: string[];
  }> {
    const items: Array<{ abs: string; target: string; isDir: boolean }> = [];
    const skipped: string[] = [];
    const conflicts: string[] = [];
    const verifiedDirs = new Set<string>();

    const walk = async (dirAbs: string, relPrefix: string): Promise<void> => {
      const entries = await fs.readdir(dirAbs, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        const abs = path.join(dirAbs, entry.name);
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

        if (entry.isSymbolicLink() || !(entry.isFile() || entry.isDirectory())) {
          throw new FileError(`Archive entry "${rel}" is not a regular file`, "ARCHIVE_UNSAFE", 400);
        }

        if (isProtectedWriteName(entry.name)) {
          skipped.push(rel);
          continue;
        }

        const projectRel = destRel === "." ? rel : `${destRel}/${rel}`;
        const safeRel = safePathOrThrow(projectRel, true);
        const target = path.resolve(root, safeRel);
        if (!target.startsWith(root + path.sep)) {
          throw new FileError("Archive entry escapes project root", "PATH_TRAVERSAL", 403);
        }

        await this.assertParentInsideRoot(path.dirname(target), root, verifiedDirs);

        const existing = await fs.lstat(target).catch(() => null);
        const isDir = entry.isDirectory();
        if (existing) {
          const sameKind = isDir ? existing.isDirectory() : existing.isFile();
          if (!sameKind || (!isDir && !overwrite)) conflicts.push(rel);
        }

        items.push({ abs, target, isDir });
        if (isDir) await walk(abs, rel);
      }
    };

    await walk(staging, "");

    if (conflicts.length > 0) {
      const shown = conflicts.slice(0, 5).join(", ");
      const more = conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : "";
      throw new FileError(
        `Extraction would overwrite existing items: ${shown}${more}`,
        "EXTRACT_CONFLICT",
        409,
      );
    }

    return { items, skipped };
  }

  /** Real (symlink-resolved) location of the nearest existing ancestor must stay inside the root. */
  private async assertParentInsideRoot(
    dir: string,
    root: string,
    verified: Set<string>,
  ): Promise<void> {
    if (verified.has(dir)) return;

    let probe = dir;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (real !== root && !real.startsWith(root + path.sep)) {
          throw new FileError("Symlink escapes project root", "SYMLINK_ESCAPE", 403);
        }
        break;
      } catch (err) {
        if (err instanceof FileError) throw err;
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }

    verified.add(dir);
  }

  // ── Compress selection ─────────────────────────────────────────────────

  async compress(
    userId: string,
    projectId: string,
    relPaths: string[],
    archiveRel?: string,
  ): Promise<CompressResult> {
    const root = this.projectRoot(projectId);

    const normalised = new Set<string>();
    for (const rel of relPaths) {
      await this.resolveAndGuard(userId, projectId, rel);
      normalised.add(safePathOrThrow(rel));
    }
    if (normalised.has(".")) {
      throw new FileError("Cannot compress the project root", "COMPRESS_ROOT", 400);
    }

    // A folder already in the selection covers anything nested inside it.
    const selection = [...normalised].filter(
      (rel) => ![...normalised].some((other) => other !== rel && rel.startsWith(`${other}/`)),
    );

    const commonParent = commonParentDir(selection);
    const sources = selection.map((rel) => ({
      abs: path.resolve(root, rel),
      arc: commonParent ? rel.slice(commonParent.length + 1) : rel,
    }));

    const archivePath =
      archiveRel !== undefined
        ? safePathOrThrow(archiveRel, true)
        : `${commonParent ? `${commonParent}/` : ""}archive-${timestamp()}.zip`;
    const output = await this.resolveAndGuard(userId, projectId, archivePath, true);

    if (await fs.lstat(output).then(() => true).catch(() => false)) {
      throw new FileError(
        `A file or folder named "${path.posix.basename(archivePath)}" already exists`,
        "FILE_ALREADY_EXISTS",
        409,
      );
    }

    await fs.mkdir(path.dirname(output), { recursive: true });
    const tmp = `${output}.${Date.now()}.tmp`;

    try {
      const result = await this.runArchive<{ files: number; skipped: string[] }>({
        command: "compress",
        sources,
        outputPath: tmp,
        maxBytes: env.ARCHIVE_MAX_EXTRACT_MB * 1024 * 1024,
        maxEntries: env.ARCHIVE_MAX_ENTRIES,
      });
      await fs.rename(tmp, output);
      return { path: archivePath, files: result.files, skipped: result.skipped };
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  private async runArchive<T extends object = object>(
    payload: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await runArchiveCommand<T>(payload);
    } catch (err) {
      if (err instanceof ArchiveCommandError) {
        throw new FileError(err.message, err.code, err.statusCode);
      }
      throw err;
    }
  }

  // ── Ownership guard ────────────────────────────────────────────────────

  private async findOwnedProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, userId: true, deletedAt: true },
    });

    if (!project || project.deletedAt !== null) {
      throw new FileError("Project not found", "PROJECT_NOT_FOUND", 404);
    }

    if (project.userId !== userId) {
      throw new FileError("You do not have access to this project", "FORBIDDEN", 403);
    }

    return project;
  }
}
