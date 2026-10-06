#!/usr/bin/env python3
"""Synchronize the mail TLS key pair from Traefik's ACME storage."""

import argparse
import base64
import json
import os
import sys
import tempfile
from pathlib import Path


def find_certificate(acme_data: dict, hostname: str) -> tuple[bytes, bytes]:
    for resolver in acme_data.values():
        if not isinstance(resolver, dict):
            continue
        for item in resolver.get("Certificates", []):
            domain = item.get("domain", {})
            names = [domain.get("main", ""), *domain.get("sans", [])]
            if hostname not in names:
                continue
            try:
                return (
                    base64.b64decode(item["certificate"], validate=True),
                    base64.b64decode(item["key"], validate=True),
                )
            except (KeyError, ValueError) as exc:
                raise ValueError(f"ACME certificate for {hostname} is malformed") from exc
    raise LookupError(f"No ACME certificate found for {hostname}")


def atomic_write(path: Path, content: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(descriptor, "wb") as temporary_file:
            temporary_file.write(content)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.chmod(temporary_name, mode)
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def synchronize(acme_path: Path, output_dir: Path, hostname: str) -> bool:
    acme_data = json.loads(acme_path.read_text(encoding="utf-8"))
    certificate, private_key = find_certificate(acme_data, hostname)
    certificate_path = output_dir / "cert.pem"
    private_key_path = output_dir / "key.pem"
    changed = (
        not certificate_path.exists()
        or not private_key_path.exists()
        or certificate_path.read_bytes() != certificate
        or private_key_path.read_bytes() != private_key
    )
    if changed:
        atomic_write(certificate_path, certificate, 0o644)
        atomic_write(private_key_path, private_key, 0o600)
    return changed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--acme", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--hostname", required=True)
    args = parser.parse_args()

    try:
        changed = synchronize(args.acme, args.output, args.hostname)
    except (OSError, json.JSONDecodeError, LookupError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps({"success": True, "changed": changed, "hostname": args.hostname}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
