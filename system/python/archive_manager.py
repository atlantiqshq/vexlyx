#!/usr/bin/env python3
"""
archive_manager.py -- System-layer script for the File Manager's archive
support (F5.24).

Extracts and creates archives on behalf of the Fastify API, using only the
Python standard library (zipfile / tarfile) so no extra system binary or npm
package is needed.

Called via child_process.spawn with a JSON payload on stdin. Writes one JSON
result line to stdout and exits 0 on success; on error writes
{"error": ..., "code": ...} and exits 1.

Commands:
  extract   -- Safely unpacks a .zip / .tar / .tar.gz / .tar.bz2 archive into
               a staging directory. The WHOLE archive is rejected before a
               single byte is written if any entry is unsafe (zip-slip,
               absolute path, symlink, hardlink, device node, ...), and
               decompression bombs are stopped by counting bytes actually
               written, not the sizes the archive header claims. The caller
               moves the staged tree into place after its own checks.
  compress  -- Writes a .zip from a list of files/folders. Symlinks are never
               followed or stored.
"""

import json
import os
import re
import stat
import sys
import tarfile
import zipfile
import zlib
from pathlib import Path


# ---------------------------------------------------------------------------
# Stream encoding
# ---------------------------------------------------------------------------

if hasattr(sys.stdin, "reconfigure"):
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Helpers (same conventions as backup_manager.py / docker_manager.py)
# ---------------------------------------------------------------------------

CHUNK_SIZE = 1024 * 1024
DRIVE_LETTER_RE = re.compile(r"^[A-Za-z]:")


def respond(data: dict) -> None:
    print(json.dumps(data), flush=True)


def fail(message: str, code: str = "ARCHIVE_ERROR") -> None:
    print(json.dumps({"error": message, "code": code}), flush=True)
    sys.exit(1)


def require_field(payload: dict, field: str):
    value = payload.get(field)
    if value is None:
        fail(f"Missing required field: {field}", "INVALID_PAYLOAD")
    return value


# ---------------------------------------------------------------------------
# Entry normalisation + safety checks
# ---------------------------------------------------------------------------


def normalise_entry_name(raw: str) -> str:
    """Return a clean relative POSIX path for an archive entry, or fail().

    Backslashes are treated as separators on purpose: an archive built on
    Windows may carry "..\\evil", which a Linux extractor would otherwise take
    as one odd-looking filename but a Windows-aware tool as a traversal.
    """
    if "\0" in raw:
        fail(f'Archive entry "{raw!r}" contains a null byte', "ARCHIVE_UNSAFE")
    name = raw.replace("\\", "/")
    if name.startswith("/") or DRIVE_LETTER_RE.match(name):
        fail(f'Archive entry "{raw}" uses an absolute path', "ARCHIVE_UNSAFE")
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        fail(f'Archive entry "{raw}" escapes the destination (path traversal)', "ARCHIVE_UNSAFE")
    return "/".join(parts)


def resolve_inside(staging: Path, rel: str) -> Path:
    """Join rel onto staging and re-verify the result stays inside staging."""
    target = (staging / rel).resolve()
    staging_resolved = staging.resolve()
    if target != staging_resolved and staging_resolved not in target.parents:
        fail(f'Archive entry "{rel}" escapes the destination', "ARCHIVE_UNSAFE")
    return target


def normalised_file_mode(is_executable: bool) -> int:
    # Archive permission bits are deliberately NOT trusted: setuid/setgid,
    # sticky and world-write are never applied. Only "owner can execute" is
    # carried over, since scripts legitimately need it.
    return 0o755 if is_executable else 0o644


class Budget:
    """Tracks bytes actually written so a lying header cannot bypass the cap."""

    def __init__(self, max_bytes: int) -> None:
        self.max_bytes = max_bytes
        self.written = 0

    def copy(self, src, dest_path: Path) -> None:
        with open(dest_path, "wb") as out:
            while True:
                chunk = src.read(CHUNK_SIZE)
                if not chunk:
                    break
                self.written += len(chunk)
                if self.written > self.max_bytes:
                    fail(
                        "Archive expands to more than the allowed size",
                        "ARCHIVE_TOO_LARGE",
                    )
                out.write(chunk)


# ---------------------------------------------------------------------------
# Extract
# ---------------------------------------------------------------------------


def plan_zip(zf: zipfile.ZipFile, max_entries: int, max_bytes: int) -> list:
    infos = zf.infolist()
    if len(infos) > max_entries:
        fail(f"Archive has more than {max_entries} entries", "ARCHIVE_TOO_MANY_ENTRIES")

    planned = []
    declared_total = 0
    for info in infos:
        rel = normalise_entry_name(info.filename)
        if not rel:
            continue
        unix_mode = info.external_attr >> 16
        file_type = stat.S_IFMT(unix_mode)
        if info.flag_bits & 0x1:
            fail(f'Archive entry "{info.filename}" is encrypted', "ARCHIVE_UNSUPPORTED")
        if file_type == stat.S_IFLNK:
            fail(f'Archive entry "{info.filename}" is a symlink', "ARCHIVE_UNSAFE")
        if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
            fail(f'Archive entry "{info.filename}" is a special file', "ARCHIVE_UNSAFE")

        is_dir = info.is_dir() or file_type == stat.S_IFDIR
        if not is_dir:
            declared_total += info.file_size
            if declared_total > max_bytes:
                fail(
                    "Archive expands to more than the allowed size",
                    "ARCHIVE_TOO_LARGE",
                )
        planned.append((rel, is_dir, bool(unix_mode & 0o100), info))
    return planned


def plan_tar(tar: tarfile.TarFile, max_entries: int, max_bytes: int) -> list:
    members = tar.getmembers()
    if len(members) > max_entries:
        fail(f"Archive has more than {max_entries} entries", "ARCHIVE_TOO_MANY_ENTRIES")

    planned = []
    declared_total = 0
    for member in members:
        rel = normalise_entry_name(member.name)
        if not rel:
            continue
        if member.issym() or member.islnk():
            fail(f'Archive entry "{member.name}" is a link', "ARCHIVE_UNSAFE")
        if not (member.isreg() or member.isdir()):
            fail(f'Archive entry "{member.name}" is a special file', "ARCHIVE_UNSAFE")
        if member.isreg():
            declared_total += member.size
            if declared_total > max_bytes:
                fail(
                    "Archive expands to more than the allowed size",
                    "ARCHIVE_TOO_LARGE",
                )
        planned.append((rel, member.isdir(), bool(member.mode & 0o100), member))
    return planned


def write_planned(planned: list, staging: Path, budget: Budget, opener) -> int:
    files_written = 0
    for rel, is_dir, is_exec, source in planned:
        target = resolve_inside(staging, rel)
        if is_dir:
            target.mkdir(parents=True, exist_ok=True)
            os.chmod(target, 0o755)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        stream = opener(source)
        if stream is None:
            fail(f'Archive entry "{rel}" could not be read', "ARCHIVE_CORRUPT")
        try:
            budget.copy(stream, target)
        finally:
            stream.close()
        os.chmod(target, normalised_file_mode(is_exec))
        files_written += 1
    return files_written


def cmd_extract(payload: dict) -> None:
    archive_path = Path(require_field(payload, "archivePath"))
    staging = Path(require_field(payload, "stagingDir"))
    max_entries = int(require_field(payload, "maxEntries"))
    max_bytes = int(require_field(payload, "maxBytes"))

    if not archive_path.is_file():
        fail("Archive not found", "ARCHIVE_NOT_FOUND")

    staging.mkdir(parents=True, exist_ok=True)
    budget = Budget(max_bytes)

    try:
        if zipfile.is_zipfile(archive_path):
            with zipfile.ZipFile(archive_path) as zf:
                planned = plan_zip(zf, max_entries, max_bytes)
                files = write_planned(planned, staging, budget, lambda info: zf.open(info))
        elif tarfile.is_tarfile(archive_path):
            with tarfile.open(archive_path, "r:*") as tar:
                planned = plan_tar(tar, max_entries, max_bytes)
                files = write_planned(planned, staging, budget, lambda member: tar.extractfile(member))
        else:
            fail("File is not a supported archive (zip, tar, tar.gz, tar.bz2)", "ARCHIVE_UNSUPPORTED")
            return
    except (zipfile.BadZipFile, tarfile.TarError, EOFError, zlib.error, RuntimeError, OSError) as exc:
        fail(f"Archive is corrupt or unreadable: {exc}", "ARCHIVE_CORRUPT")
        return

    respond({"done": True, "files": files, "bytes": budget.written})


# ---------------------------------------------------------------------------
# Compress
# ---------------------------------------------------------------------------


def cmd_compress(payload: dict) -> None:
    sources = require_field(payload, "sources")
    output_path = Path(require_field(payload, "outputPath"))
    max_bytes = int(require_field(payload, "maxBytes"))
    max_entries = int(require_field(payload, "maxEntries"))

    output_resolved = output_path.resolve()
    entries = []  # (absolute path, archive name, is_dir)
    skipped = []
    total_bytes = 0

    def add_entry(abs_path: Path, arcname: str) -> None:
        nonlocal total_bytes
        if abs_path.is_symlink():
            skipped.append(arcname)
            return
        if abs_path.resolve() == output_resolved:
            return
        if abs_path.is_dir():
            entries.append((abs_path, arcname + "/", True))
            try:
                children = sorted(os.listdir(abs_path))
            except OSError as exc:
                fail(f'Cannot read folder "{arcname}": {exc}', "ARCHIVE_IO_ERROR")
                return
            for child in children:
                add_entry(abs_path / child, f"{arcname}/{child}")
        elif abs_path.is_file():
            total_bytes += abs_path.stat().st_size
            if total_bytes > max_bytes:
                fail("Selection is larger than the allowed archive size", "ARCHIVE_TOO_LARGE")
            entries.append((abs_path, arcname, False))
        else:
            skipped.append(arcname)
        if len(entries) > max_entries:
            fail(f"Selection has more than {max_entries} entries", "ARCHIVE_TOO_MANY_ENTRIES")

    for source in sources:
        abs_path = Path(source["abs"])
        if not abs_path.exists() and not abs_path.is_symlink():
            fail(f'"{source["arc"]}" does not exist', "ARCHIVE_SOURCE_NOT_FOUND")
        add_entry(abs_path, source["arc"])

    if not entries:
        fail("Nothing to compress (selection is empty or only contains symlinks)", "ARCHIVE_EMPTY")

    files = 0
    try:
        with zipfile.ZipFile(
            output_path, "w", compression=zipfile.ZIP_DEFLATED, strict_timestamps=False
        ) as zf:
            for abs_path, arcname, is_dir in entries:
                zf.write(abs_path, arcname)
                if not is_dir:
                    files += 1
    except OSError as exc:
        if output_path.exists():
            output_path.unlink()
        fail(f"Could not write archive: {exc}", "ARCHIVE_IO_ERROR")
        return

    respond({"done": True, "files": files, "skipped": skipped})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

COMMANDS = {
    "extract": cmd_extract,
    "compress": cmd_compress,
}


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
    except json.JSONDecodeError:
        fail("Invalid JSON payload", "INVALID_PAYLOAD")
        return

    command = payload.get("command")
    handler = COMMANDS.get(command)
    if handler is None:
        fail(f"Unknown command: {command}", "UNKNOWN_COMMAND")
        return
    handler(payload)


if __name__ == "__main__":
    main()
