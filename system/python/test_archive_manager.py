"""Tests for archive_manager.py (F5.24). Run: python -m unittest system/python/test_archive_manager.py"""

import io
import json
import os
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("archive_manager.py")
MAX_ENTRIES = 1000
MAX_BYTES = 10 * 1024 * 1024


def run_manager(payload: dict) -> tuple:
    proc = subprocess.run(
        [sys.executable, "-I", str(SCRIPT)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )
    last_line = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else "{}"
    return proc.returncode, json.loads(last_line)


def zip_with(path: Path, entries: dict, symlinks: dict = None) -> None:
    with zipfile.ZipFile(path, "w") as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
        for name, target in (symlinks or {}).items():
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(info, target)


def tar_with(path: Path, mode: str, entries: dict) -> None:
    with tarfile.open(path, mode) as tar:
        for name, data in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))


class ExtractTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.staging = self.root / "work" / "staging"
        self.outside = self.root / "outside"
        self.outside.mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def extract(self, archive: Path, max_entries: int = MAX_ENTRIES, max_bytes: int = MAX_BYTES):
        return run_manager(
            {
                "command": "extract",
                "archivePath": str(archive),
                "stagingDir": str(self.staging),
                "maxEntries": max_entries,
                "maxBytes": max_bytes,
            }
        )

    def assert_rejected(self, archive: Path, code: str, **kwargs) -> None:
        returncode, out = self.extract(archive, **kwargs)
        self.assertEqual(returncode, 1, out)
        self.assertEqual(out["code"], code, out)
        self.assertEqual(list(self.outside.iterdir()), [], "nothing may be written outside")

    def test_extracts_zip_with_nested_dirs(self):
        archive = self.root / "site.zip"
        zip_with(archive, {"index.html": b"hi", "assets/css/app.css": b"body{}", "empty/": b""})
        returncode, out = self.extract(archive)
        self.assertEqual(returncode, 0, out)
        self.assertEqual((self.staging / "index.html").read_bytes(), b"hi")
        self.assertEqual((self.staging / "assets/css/app.css").read_bytes(), b"body{}")
        self.assertTrue((self.staging / "empty").is_dir())
        self.assertEqual(out["files"], 2)

    def test_extracts_tar_gz_and_tar_bz2_and_plain_tar(self):
        for mode, name in (("w:gz", "a.tar.gz"), ("w:bz2", "a.tar.bz2"), ("w", "a.tar")):
            with self.subTest(name=name):
                archive = self.root / name
                tar_with(archive, mode, {"dir/file.txt": b"content"})
                staging = self.root / f"stage-{name}"
                returncode, out = run_manager(
                    {
                        "command": "extract",
                        "archivePath": str(archive),
                        "stagingDir": str(staging),
                        "maxEntries": MAX_ENTRIES,
                        "maxBytes": MAX_BYTES,
                    }
                )
                self.assertEqual(returncode, 0, out)
                self.assertEqual((staging / "dir/file.txt").read_bytes(), b"content")

    def test_rejects_parent_traversal_in_zip(self):
        archive = self.root / "slip.zip"
        zip_with(archive, {"ok.txt": b"x", "../../outside/evil.txt": b"pwn"})
        self.assert_rejected(archive, "ARCHIVE_UNSAFE")
        self.assertFalse((self.staging / "ok.txt").exists(), "nothing is written when any entry is bad")

    def test_rejects_backslash_traversal(self):
        archive = self.root / "win.zip"
        zip_with(archive, {"..\\..\\outside\\evil.txt": b"pwn"})
        self.assert_rejected(archive, "ARCHIVE_UNSAFE")

    def test_rejects_absolute_and_drive_paths(self):
        for name in ("/etc/cron.d/evil", "C:\\Windows\\evil.txt", "C:/evil.txt"):
            with self.subTest(name=name):
                archive = self.root / "abs.zip"
                zip_with(archive, {name: b"pwn"})
                self.assert_rejected(archive, "ARCHIVE_UNSAFE")

    def test_rejects_zip_symlink_entry(self):
        archive = self.root / "link.zip"
        zip_with(archive, {"ok.txt": b"x"}, symlinks={"escape": "../outside"})
        self.assert_rejected(archive, "ARCHIVE_UNSAFE")

    def test_rejects_tar_symlink_hardlink_and_traversal(self):
        for kind in ("sym", "hard", "traversal"):
            with self.subTest(kind=kind):
                archive = self.root / f"{kind}.tar"
                with tarfile.open(archive, "w") as tar:
                    info = tarfile.TarInfo("../../outside/evil" if kind == "traversal" else "link")
                    if kind == "sym":
                        info.type = tarfile.SYMTYPE
                        info.linkname = "../outside"
                    elif kind == "hard":
                        info.type = tarfile.LNKTYPE
                        info.linkname = "/etc/passwd"
                    else:
                        info.size = 1
                    tar.addfile(info, io.BytesIO(b"x") if kind == "traversal" else None)
                self.assert_rejected(archive, "ARCHIVE_UNSAFE")

    def test_rejects_tar_device_node(self):
        archive = self.root / "dev.tar"
        with tarfile.open(archive, "w") as tar:
            info = tarfile.TarInfo("null")
            info.type = tarfile.CHRTYPE
            tar.addfile(info)
        self.assert_rejected(archive, "ARCHIVE_UNSAFE")

    def test_rejects_too_many_entries(self):
        archive = self.root / "many.zip"
        zip_with(archive, {f"f{i}.txt": b"x" for i in range(20)})
        self.assert_rejected(archive, "ARCHIVE_TOO_MANY_ENTRIES", max_entries=10)

    def test_rejects_archive_that_declares_too_large(self):
        archive = self.root / "big.zip"
        zip_with(archive, {"big.bin": b"\0" * 5000})
        self.assert_rejected(archive, "ARCHIVE_TOO_LARGE", max_bytes=1000)

    def test_stops_a_zip_whose_header_understates_its_size(self):
        archive = self.root / "bomb.zip"
        zip_with(archive, {"bomb.bin": b"\0" * 200_000})
        data = bytearray(archive.read_bytes())
        # Overwrite the uncompressed size (offset 22 in the local header and
        # 24 in the central directory) with a tiny lie.
        local_sig = data.find(b"PK\x03\x04")
        central_sig = data.find(b"PK\x01\x02")
        data[local_sig + 22 : local_sig + 26] = (10).to_bytes(4, "little")
        data[central_sig + 24 : central_sig + 28] = (10).to_bytes(4, "little")
        archive.write_bytes(bytes(data))
        returncode, out = self.extract(archive, max_bytes=50_000)
        self.assertEqual(returncode, 1, out)
        self.assertIn(out["code"], ("ARCHIVE_TOO_LARGE", "ARCHIVE_CORRUPT"))

    def test_corrupt_and_non_archives_fail_cleanly(self):
        junk = self.root / "junk.zip"
        junk.write_bytes(b"this is not an archive")
        returncode, out = self.extract(junk)
        self.assertEqual(returncode, 1)
        self.assertEqual(out["code"], "ARCHIVE_UNSUPPORTED")

        truncated = self.root / "cut.zip"
        zip_with(truncated, {"a.txt": b"hello" * 1000})
        truncated.write_bytes(truncated.read_bytes()[:-30])
        returncode, out = self.extract(truncated)
        self.assertEqual(returncode, 1)

    @unittest.skipIf(os.name == "nt", "POSIX mode bits")
    def test_archive_permission_bits_are_normalised(self):
        archive = self.root / "perms.zip"
        with zipfile.ZipFile(archive, "w") as zf:
            for name, mode in (("suid.sh", 0o4777), ("plain.txt", 0o666), ("run.sh", 0o755)):
                info = zipfile.ZipInfo(name)
                info.external_attr = (stat.S_IFREG | mode) << 16
                zf.writestr(info, b"x")
        returncode, out = self.extract(archive)
        self.assertEqual(returncode, 0, out)
        self.assertEqual(stat.S_IMODE((self.staging / "suid.sh").stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((self.staging / "plain.txt").stat().st_mode), 0o644)
        self.assertEqual(stat.S_IMODE((self.staging / "run.sh").stat().st_mode), 0o755)


class CompressTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / "site/assets").mkdir(parents=True)
        (self.root / "site/index.html").write_text("hi")
        (self.root / "site/assets/app.css").write_text("css")
        (self.root / "notes.txt").write_text("notes")
        (self.root / "other.txt").write_text("other")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def compress(self, sources: list, output: Path, **overrides):
        payload = {
            "command": "compress",
            "sources": [{"abs": str(self.root / rel), "arc": arc} for rel, arc in sources],
            "outputPath": str(output),
            "maxBytes": MAX_BYTES,
            "maxEntries": MAX_ENTRIES,
        }
        payload.update(overrides)
        return run_manager(payload)

    def test_archive_contains_exactly_the_selection(self):
        out_path = self.root / "out.zip"
        returncode, out = self.compress([("site", "site"), ("notes.txt", "notes.txt")], out_path)
        self.assertEqual(returncode, 0, out)
        with zipfile.ZipFile(out_path) as zf:
            names = set(zf.namelist())
        self.assertEqual(
            names,
            {"site/", "site/index.html", "site/assets/", "site/assets/app.css", "notes.txt"},
        )
        self.assertNotIn("other.txt", names)

    def test_output_archive_never_includes_itself(self):
        out_path = self.root / "site" / "self.zip"
        returncode, out = self.compress([("site", "site")], out_path)
        self.assertEqual(returncode, 0, out)
        with zipfile.ZipFile(out_path) as zf:
            self.assertNotIn("site/self.zip", zf.namelist())

    @unittest.skipIf(os.name == "nt", "symlinks need privileges on Windows")
    def test_symlinks_are_skipped_not_followed(self):
        os.symlink(self.root / "notes.txt", self.root / "site" / "link.txt")
        out_path = self.root / "out.zip"
        returncode, out = self.compress([("site", "site")], out_path)
        self.assertEqual(returncode, 0, out)
        self.assertIn("site/link.txt", out["skipped"])
        with zipfile.ZipFile(out_path) as zf:
            self.assertNotIn("site/link.txt", zf.namelist())

    def test_missing_source_and_size_cap_fail(self):
        returncode, out = self.compress([("ghost.txt", "ghost.txt")], self.root / "a.zip")
        self.assertEqual((returncode, out["code"]), (1, "ARCHIVE_SOURCE_NOT_FOUND"))
        returncode, out = self.compress([("site", "site")], self.root / "b.zip", maxBytes=1)
        self.assertEqual((returncode, out["code"]), (1, "ARCHIVE_TOO_LARGE"))


if __name__ == "__main__":
    unittest.main()
