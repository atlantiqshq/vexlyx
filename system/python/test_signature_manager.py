"""Tests for signature_manager.py (F5.31). Run: python -m unittest system/python/test_signature_manager.py"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("signature_manager.py")


class ManagerTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.dir = self.root / "signatures"
        self.env = {**os.environ, "VEXLYX_SIGNATURES_DIR": str(self.dir)}

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def run_manager(self, command: str, payload: dict) -> tuple:
        proc = subprocess.run(
            [sys.executable, "-I", str(SCRIPT), command],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            env=self.env,
        )
        out = json.loads(proc.stdout.strip().splitlines()[-1]) if proc.stdout.strip() else {}
        return proc.returncode, out

    def names(self) -> list:
        return sorted(p.name for p in self.dir.iterdir()) if self.dir.exists() else []

    def test_writes_one_json_file_per_mailbox(self):
        code, out = self.run_manager(
            "sync",
            {"files": [{"address": "ada@example.com", "data": {"v": 1, "address": "ada@example.com"}}], "remove": []},
        )
        self.assertEqual(code, 0, out)
        self.assertEqual(out, {"written": 1, "removed": 0})
        self.assertEqual(json.loads((self.dir / "ada@example.com.json").read_text()), {"v": 1, "address": "ada@example.com"})

    def test_leaves_no_temporary_file_behind_and_replaces_in_place(self):
        for version in ("a", "b"):
            self.run_manager("sync", {"files": [{"address": "ada@example.com", "data": {"version": version}}]})
        self.assertEqual(self.names(), ["ada@example.com.json"])
        self.assertEqual(json.loads((self.dir / "ada@example.com.json").read_text())["version"], "b")

    @unittest.skipIf(os.name == "nt", "POSIX mode bits")
    def test_files_are_readable_by_the_other_containers(self):
        self.run_manager("sync", {"files": [{"address": "ada@example.com", "data": {}}]})
        self.assertEqual((self.dir / "ada@example.com.json").stat().st_mode & 0o777, 0o644)

    def test_normalises_the_address_to_lower_case(self):
        self.run_manager("sync", {"files": [{"address": "Ada@Example.COM", "data": {}}]})
        self.assertEqual(self.names(), ["ada@example.com.json"])

    def test_removes_listed_files_and_ignores_missing_ones(self):
        self.run_manager("sync", {"files": [{"address": "a@example.com", "data": {}}, {"address": "b@example.com", "data": {}}]})
        code, out = self.run_manager("sync", {"files": [], "remove": ["a@example.com", "ghost@example.com"]})
        self.assertEqual((code, out["removed"]), (0, 1))
        self.assertEqual(self.names(), ["b@example.com.json"])

    def test_rejects_addresses_that_could_escape_the_directory_and_writes_nothing(self):
        for bad in ("../evil@example.com", "a/b@example.com", "a\\b@example.com", ".hidden@example.com", "a@../example.com", "a@example.com/../x", "", "no-at-sign", "a@b", "a b@example.com", "a@example.com\n"):
            with self.subTest(address=bad):
                code, out = self.run_manager(
                    "sync", {"files": [{"address": "good@example.com", "data": {}}, {"address": bad, "data": {}}]}
                )
                self.assertEqual(code, 1, out)
                self.assertEqual(out["code"], "INVALID_ADDRESS")
                self.assertEqual(self.names(), [], "a bad entry must change nothing, even the good one")
        self.assertFalse((self.root / "evil@example.com.json").exists())

    def test_rejects_a_bad_address_in_the_remove_list_without_writing(self):
        code, out = self.run_manager("sync", {"files": [{"address": "a@example.com", "data": {}}], "remove": ["../x@example.com"]})
        self.assertEqual(code, 1)
        self.assertEqual(self.names(), [])

    def test_prune_domain_keeps_only_the_listed_addresses_of_that_domain(self):
        self.run_manager(
            "sync",
            {"files": [{"address": a, "data": {}} for a in ("a@example.com", "b@example.com", "c@other.org")]},
        )
        code, out = self.run_manager("prune_domain", {"domain": "example.com", "keep": ["a@example.com"]})
        self.assertEqual((code, out), (0, {"removed": 1}))
        self.assertEqual(self.names(), ["a@example.com.json", "c@other.org.json"])

    def test_prune_domain_does_not_treat_a_suffix_as_the_domain(self):
        self.run_manager("sync", {"files": [{"address": "a@notexample.com", "data": {}}]})
        self.run_manager("prune_domain", {"domain": "example.com", "keep": []})
        self.assertEqual(self.names(), ["a@notexample.com.json"])

    def test_prune_domain_rejects_a_bad_domain(self):
        code, _ = self.run_manager("prune_domain", {"domain": "../x", "keep": []})
        self.assertEqual(code, 1)

    def test_global_switch(self):
        self.assertEqual(self.run_manager("set_global", {"enabled": False})[1], {"enabled": False})
        self.assertEqual(json.loads((self.dir / "_global.json").read_text()), {"v": 1, "enabled": False})
        self.run_manager("set_global", {"enabled": True})
        self.assertTrue(json.loads((self.dir / "_global.json").read_text())["enabled"])

    def test_stats_is_none_when_the_container_is_not_reachable(self):
        code, out = self.run_manager("stats", {"container": "vexlyx-definitely-not-running"})
        self.assertEqual((code, out), (0, {"stats": None}))

    def test_stats_rejects_an_unsafe_container_name(self):
        code, _ = self.run_manager("stats", {"container": "x; rm -rf /"})
        self.assertEqual(code, 1)

    def test_unknown_command_fails_cleanly(self):
        code, out = self.run_manager("explode", {})
        self.assertEqual((code, out["code"]), (1, "UNKNOWN_COMMAND"))


if __name__ == "__main__":
    unittest.main()
