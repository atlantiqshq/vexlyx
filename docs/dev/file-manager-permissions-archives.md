# File Manager: Permissions & Archives (F5.24)

> **Status:** 🟢 COMPLETED
> **Feature:** F5.24 — change file/folder permissions, extract uploaded archives and compress a selection, all from the File Manager with no shell access.

---

## What it does

- **Permissions:** view and edit a file or folder's mode from the tree's **Permissions…** action. A checkbox grid (owner/group/other × read/write/execute) and a raw octal input stay in sync. The current mode is shown beside every item in the tree.
- **Extract:** **Extract here…** on a `.zip`, `.tar`, `.tar.gz`/`.tgz` or `.tar.bz2`/`.tbz2` unpacks it on the server into the archive's folder or a folder you choose.
- **Compress:** Ctrl/Cmd+click several items (or use **Compress…** on one) to create a `.zip` inside the project. Download it with the normal Download button, or from the toast.

## How it works

```
Dashboard dialogs ──► POST /api/files/:id/{chmod,extract,compress}
                          │  routes.ts → FileService (service.ts)
                          │     ownership check, safePath, root + symlink guard
                          ▼
                     archive.ts ── spawn ──► system/python/archive_manager.py
                                              (stdlib zipfile / tarfile)
```

### Archive engine: Python stdlib

Extraction and compression run in `system/python/archive_manager.py` using only `zipfile`/`tarfile`. No npm package and no system binary (`zip`/`unzip`) is needed — the API image already ships Python, and the backup and WordPress-import code already use `tarfile`. See the decision-log row in `CLAUDE.md`.

### Permissions

`POST /api/files/:id/chmod` — body `{ path, mode, recursive? }`.

- `mode` is exactly three octal digits (`000`–`777`). Setuid, setgid and sticky bits are rejected.
- Non-recursive by default. `recursive: true` only applies to folders; the dashboard asks for an explicit confirmation first.
- Recursive mode applies the mode to folders as given. Files keep execute bits only if they already had any (so `755` on a folder never makes every file executable). Symlinks are skipped, never followed.
- The project root cannot be changed, and symlinks cannot be targeted directly.
- Unlike writes, chmod is allowed on `.env*` and `wp-config.php`: tightening those to `640`/`600` is a main reason to want chmod.

### Extract

`POST /api/files/:id/extract` — body `{ path, destination?, overwrite? }` → `{ destination, files, skipped }`.

1. `archive_manager.py` **pre-scans** every entry and rejects the whole archive (`ARCHIVE_UNSAFE`) on: `..`, absolute or drive-letter paths, backslash tricks, symlinks, hardlinks, device nodes, encrypted entries. Entry count and total size are capped (below).
2. It extracts into a staging folder inside the project (`.vexlyx-extract-<uuid>`). Size is enforced on bytes **actually written**, so an archive whose header understates its size is still stopped.
3. The API walks the staged tree and runs every path through the same `safePath` guard plus the project-root and symlink checks used by every other route. It also checks that no existing folder in the destination is a symlink pointing outside the project.
4. If anything would be overwritten and `overwrite` is false, it stops with `409 EXTRACT_CONFLICT`. Otherwise the files are moved into place.
5. The staging folder is always deleted; on any failure nothing reaches the destination.

Archive permission bits are not trusted: files become `644` (or `755` if the archive marks them user-executable), folders `755`; setuid/setgid/sticky and world-write are never applied.

`.env*` and `wp-config.php` entries are **skipped and reported** in `skipped` rather than failing the archive, so a WordPress site backup can still be extracted. Existing protected files are never overwritten.

### Compress

`POST /api/files/:id/compress` — body `{ paths[], archivePath? }` → `{ path, files, skipped }`.

- Every source goes through `safePath` and the root guard. Items already inside a selected folder are ignored.
- Names inside the zip are relative to the selection's common parent folder.
- Without `archivePath`, the archive is `archive-<YYYYMMDDHHMMSS>.zip` beside the selection. Existing names return `409`.
- Symlinks are skipped and reported. The zip is written to a temp file and renamed into place.

### Limits

| Env variable | Default | Meaning |
|---|---|---|
| `ARCHIVE_MAX_ENTRIES` | `100000` | Max entries per archive (and items touched by a recursive chmod) |
| `ARCHIVE_MAX_EXTRACT_MB` | `5120` | Max total uncompressed size when extracting, or total input size when compressing |

Operations are synchronous and time out after 10 minutes.

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `ARCHIVE_UNSAFE` | 400 | Archive contains an unsafe entry |
| `ARCHIVE_UNSUPPORTED` / `UNSUPPORTED_ARCHIVE` | 400 | Not a supported archive |
| `ARCHIVE_CORRUPT` | 400 | Archive is damaged or unreadable |
| `ARCHIVE_TOO_LARGE` / `ARCHIVE_TOO_MANY_ENTRIES` / `TOO_MANY_ENTRIES` | 413 | Over a configured limit |
| `EXTRACT_CONFLICT` | 409 | Extraction would overwrite existing files |
| `FILE_ALREADY_EXISTS` | 409 | Archive name already taken |
| `INVALID_PATH` | 400 | Path rejected by `safePath` |
| `FORBIDDEN` / `PROJECT_NOT_FOUND` | 403 / 404 | Not your project / no such project |

## How to test

```bash
# API (Vitest) — POSIX-only cases (real chmod, symlinks) run on Linux/macOS and are skipped on Windows
cd apps/api && pnpm exec vitest run src/modules/files

# Python archive engine
python -m unittest system/python/test_archive_manager.py

# Dashboard helpers
cd apps/dashboard && pnpm exec vitest run src/lib/filePermissions.test.ts
```

Manual check on a real host: upload a `.zip` and extract it; upload a zip-slip archive and confirm nothing lands outside the project; compress a selection and `unzip -l` the result; set `644`/`755` and confirm with `stat`; confirm a recursive chmod requires the confirmation step.

## How to extend

- **New archive format:** add its extension to `ARCHIVE_EXTENSIONS` in `files/archive.ts` and `lib/filePermissions.ts`, and handle it in `cmd_extract`. Keep the pre-scan-then-write structure.
- **New compress format:** add a format field to `CompressBodySchema` and a branch in `cmd_compress`.
