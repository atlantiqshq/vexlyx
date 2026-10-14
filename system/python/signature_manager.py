#!/usr/bin/env python3
"""
signature_manager.py -- System-layer script for mail signatures (F5.31).

The API resolves each mailbox's signature and hands the result to this script,
which keeps one small JSON file per mailbox in a directory that is mounted
read-only into Roundcube (its signature plugin) and Postfix (the optional
server-side filter). Neither container ever needs database credentials.

Called as `signature_manager.py <command>` with a JSON payload on stdin. Writes
one JSON result to stdout; exits 1 on error.

Commands:
  sync          -- Writes the given mailbox files and removes the listed ones.
  prune_domain  -- Removes every file of a domain except the listed addresses.
  set_global    -- Writes the global on/off switch for server-side enforcement.
  stats         -- Reads the mail-server filter's counters from the Postfix container.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

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


def respond(data: dict) -> None:
    print(json.dumps(data), flush=True)


def fail(message: str, code: str = "SIGNATURE_ERROR") -> None:
    print(json.dumps({"error": message, "code": code}), flush=True)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Paths and validation
# ---------------------------------------------------------------------------

# The address becomes part of a file name, so only characters that can never form
# a path separator or traversal are accepted: no slash, backslash, colon or leading dot.
# Always matched with fullmatch(): a plain "$" also accepts a trailing newline.
ADDRESS_RE = re.compile(r"^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,}$")
DOMAIN_RE = re.compile(r"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,}$")
CONTAINER_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$")
GLOBAL_FILE = "_global.json"
STATS_PATH = "/var/lib/vexlyx/signature_stats.json"


def get_signatures_dir() -> Path:
    override = os.environ.get("VEXLYX_SIGNATURES_DIR")
    if override:
        base = Path(override)
    else:
        candidates = [
            Path.cwd() / "docker" / "mail-data" / "signatures",
            Path.cwd().parent / "docker" / "mail-data" / "signatures",
            Path.cwd().parent.parent / "docker" / "mail-data" / "signatures",
        ]
        base = next((c for c in candidates if c.parent.exists()), candidates[0])
    base.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(base, 0o755)
    except OSError:
        pass
    return base


def normalise_address(raw) -> str:
    address = str(raw).lower()
    if not ADDRESS_RE.fullmatch(address):
        fail(f"Invalid mailbox address: {raw!r}", "INVALID_ADDRESS")
    return address


def file_for(directory: Path, address: str) -> Path:
    path = directory / f"{address}.json"
    if path.resolve().parent != directory.resolve():
        fail(f"Refusing to write outside the signatures directory: {address!r}", "INVALID_ADDRESS")
    return path


def write_atomic(path: Path, content: str) -> None:
    # Written beside the target and renamed, so a reader never sees a half-written file.
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(content, encoding="utf-8", newline="\n")
    try:
        # The containers that read these files run as different users than the API.
        os.chmod(temp, 0o644)
    except OSError:
        pass
    os.replace(temp, path)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_sync(payload: dict) -> dict:
    directory = get_signatures_dir()
    files = payload.get("files", [])
    remove = payload.get("remove", [])

    # Validate everything first so a bad entry changes nothing.
    planned = []
    for entry in files:
        address = normalise_address(entry.get("address", ""))
        data = entry.get("data")
        if not isinstance(data, dict):
            fail(f"Missing file contents for {address}", "INVALID_PAYLOAD")
        planned.append((file_for(directory, address), json.dumps(data, separators=(",", ":"))))
    doomed = [file_for(directory, normalise_address(a)) for a in remove]

    for path, content in planned:
        write_atomic(path, content)

    removed = 0
    keep = {path for path, _ in planned}
    for path in doomed:
        if path in keep:
            continue
        try:
            path.unlink()
            removed += 1
        except FileNotFoundError:
            pass
    return {"written": len(planned), "removed": removed}


def cmd_prune_domain(payload: dict) -> dict:
    directory = get_signatures_dir()
    domain = str(payload.get("domain", "")).lower()
    if not DOMAIN_RE.fullmatch(domain):
        fail(f"Invalid domain: {domain!r}", "INVALID_DOMAIN")
    keep = {normalise_address(a) for a in payload.get("keep", [])}

    removed = 0
    for path in directory.glob(f"*@{domain}.json"):
        address = path.name[: -len(".json")]
        if address not in keep:
            path.unlink(missing_ok=True)
            removed += 1
    return {"removed": removed}


def cmd_set_global(payload: dict) -> dict:
    directory = get_signatures_dir()
    enabled = bool(payload.get("enabled", True))
    write_atomic(directory / GLOBAL_FILE, json.dumps({"v": 1, "enabled": enabled}))
    return {"enabled": enabled}


def cmd_stats(payload: dict) -> dict:
    container = str(payload.get("container", "vexlyx-postfix"))
    if not CONTAINER_RE.fullmatch(container):
        fail("Invalid container name", "INVALID_PAYLOAD")
    try:
        result = subprocess.run(
            ["docker", "exec", container, "cat", STATS_PATH],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"stats": None}
    if result.returncode != 0:
        return {"stats": None}
    try:
        return {"stats": json.loads(result.stdout)}
    except json.JSONDecodeError:
        return {"stats": None}


COMMANDS = {
    "sync": cmd_sync,
    "prune_domain": cmd_prune_domain,
    "set_global": cmd_set_global,
    "stats": cmd_stats,
}


def main() -> None:
    if len(sys.argv) < 2:
        fail("Missing command argument", "INVALID_ARGUMENTS")
    command = sys.argv[1]
    handler = COMMANDS.get(command)
    if handler is None:
        fail(f"Unknown command: {command}", "UNKNOWN_COMMAND")

    payload = {}
    raw = sys.stdin.read().strip() if not sys.stdin.isatty() else ""
    if raw:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            fail("Invalid JSON payload", "INVALID_PAYLOAD")

    try:
        respond(handler(payload))
    except SystemExit:
        raise
    except Exception as exc:  # report, never traceback, to the API
        fail(str(exc), "EXECUTION_ERROR")


if __name__ == "__main__":
    main()
