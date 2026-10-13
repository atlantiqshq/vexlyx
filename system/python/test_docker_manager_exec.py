"""Tests for docker_manager.py's `exec` action (F5.28). Run: python -m unittest system/python/test_docker_manager_exec.py

The Docker CLI is faked, so these check what is passed to it (argument list, environment marker,
service name) and how timeouts, caps and skips are handled. The real container behaviour is
covered by the live test described in docs/dev/scheduled-tasks.md.
"""

import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import docker_manager as dm  # noqa: E402


class PayloadRejected(Exception):
    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


class FakeProc:
    def __init__(self, output=b"", returncode=0, hang=False):
        self.stdout = io.BytesIO(output)
        self.returncode = returncode
        self.hang = hang
        self.killed = False

    def wait(self, timeout=None):
        if self.hang and not self.killed:
            raise subprocess.TimeoutExpired("docker", timeout)
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9


class ExecTests(unittest.TestCase):
    def setUp(self):
        self.project = tempfile.TemporaryDirectory()
        deploy = Path(self.project.name) / "deploy"
        deploy.mkdir()
        (deploy / "docker-compose.yml").write_text("services:\n  app: {}\n")
        self.results = []
        self.calls = []
        self.state = "running"
        self.container = "abc123"
        self.proc = FakeProc(b"hello\n")
        self.popen_args = None

        def fake_run(args, **kwargs):
            self.calls.append(list(args))
            if args[1:3] == ["compose", "ps"]:
                return subprocess.CompletedProcess(args, 0, stdout=self.container + "\n" if self.container else "", stderr="")
            if args[1] == "inspect":
                return subprocess.CompletedProcess(args, 0, stdout=self.state + "\n", stderr="")
            return subprocess.CompletedProcess(args, 0, stdout=b"", stderr=b"")

        def fake_popen(args, **kwargs):
            self.popen_args = list(args)
            return self.proc

        def fake_fail(message, code="DOCKER_ERROR"):
            raise PayloadRejected(message, code)

        for patcher in (
            mock.patch.object(dm, "get_docker_binary", return_value="docker"),
            mock.patch.object(dm, "respond", side_effect=self.results.append),
            mock.patch.object(dm, "fail", side_effect=fake_fail),
            mock.patch.object(dm.subprocess, "run", side_effect=fake_run),
            mock.patch.object(dm.subprocess, "Popen", side_effect=fake_popen),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self.project.cleanup)

    def payload(self, **overrides):
        data = {"projectDir": self.project.name, "shellCommand": "echo hello", "runId": "run1", "timeoutSeconds": 30}
        data.update(overrides)
        return data

    def run_exec(self, **overrides):
        dm.cmd_exec(self.payload(**overrides))
        return self.results[-1]

    def test_runs_the_command_as_one_argument_of_sh_c_inside_the_container(self):
        result = self.run_exec()
        self.assertEqual(self.popen_args, ["docker", "exec", "-e", "VX_TASK_RUN=run1", "abc123", "sh", "-c", "echo hello"])
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(result["output"], "hello\n")
        self.assertFalse(result["truncated"])

    def test_shell_metacharacters_are_never_split_or_interpreted_on_the_host(self):
        nasty = "echo hi; rm -rf / && $(whoami) | tee `id` > /tmp/x"
        self.run_exec(shellCommand=nasty)
        self.assertEqual(self.popen_args[-3:], ["sh", "-c", nasty])
        self.assertEqual(len(self.popen_args), 8)

    def test_always_targets_the_app_service_even_for_wordpress_where_the_primary_service_is_web(self):
        self.run_exec(projectType="WORDPRESS")
        ps = [call for call in self.calls if call[1:3] == ["compose", "ps"]]
        self.assertEqual(ps, [["docker", "compose", "ps", "-q", "app"]])

    def test_nonzero_exit_is_a_failure_with_its_exit_code(self):
        self.proc = FakeProc(b"boom\n", returncode=3)
        result = self.run_exec()
        self.assertEqual((result["status"], result["exitCode"]), ("failed", 3))
        self.assertIn("boom", result["output"])

    def test_a_missing_shell_gets_a_plain_explanation(self):
        self.proc = FakeProc(b'OCI runtime exec failed: exec: "sh": executable file not found in $PATH', returncode=126)
        result = self.run_exec()
        self.assertEqual(result["status"], "failed")
        self.assertIn("no `sh`", result["output"])

    def test_timeout_kills_the_client_and_every_process_the_run_started(self):
        self.proc = FakeProc(b"partial", hang=True)
        result = self.run_exec(timeoutSeconds=2)
        self.assertEqual(result["status"], "timeout")
        self.assertIsNone(result["exitCode"])
        self.assertTrue(self.proc.killed)
        kills = [call for call in self.calls if "vx-kill" in call]
        self.assertGreaterEqual(len(kills), 1)
        # The run id is a separate argument to the kill script, never interpolated into it.
        self.assertEqual(kills[0][:6], ["docker", "exec", "abc123", "sh", "-c", dm.EXEC_KILL_SCRIPT])
        self.assertEqual(kills[0][-2:], ["vx-kill", "run1"])
        self.assertIn("VX_TASK_RUN=$1", dm.EXEC_KILL_SCRIPT)

    def test_output_is_capped_but_still_drained(self):
        big = b"x" * 100_000
        self.proc = FakeProc(big)
        result = self.run_exec(maxOutputBytes=1000)
        self.assertEqual(len(result["output"]), 1000)
        self.assertTrue(result["truncated"])
        self.assertEqual(self.proc.stdout.tell(), len(big))

    def test_output_exactly_at_the_cap_is_not_marked_truncated(self):
        self.proc = FakeProc(b"y" * 500)
        result = self.run_exec(maxOutputBytes=500)
        self.assertEqual(len(result["output"]), 500)
        self.assertFalse(result["truncated"])

    def test_invalid_utf8_output_does_not_crash(self):
        self.proc = FakeProc(b"ok \xff\xfe end")
        self.assertEqual(self.run_exec()["status"], "success")

    def test_a_project_that_was_never_deployed_is_skipped(self):
        (Path(self.project.name) / "deploy" / "docker-compose.yml").unlink()
        result = self.run_exec()
        self.assertEqual((result["status"], result["reason"]), ("skipped", "NOT_DEPLOYED"))
        self.assertIsNone(self.popen_args)

    def test_a_stopped_or_missing_container_is_skipped_not_failed(self):
        self.state = "exited"
        result = self.run_exec()
        self.assertEqual((result["status"], result["reason"]), ("skipped", "NOT_RUNNING"))
        self.container = ""
        result = self.run_exec()
        self.assertEqual((result["status"], result["reason"]), ("skipped", "NOT_RUNNING"))
        self.assertIsNone(self.popen_args)

    def test_bad_payloads_are_rejected_before_anything_runs(self):
        bad = [
            {"runId": "x;rm"},
            {"runId": ""},
            {"runId": "a" * 65},
            {"timeoutSeconds": 0},
            {"timeoutSeconds": 3601},
            {"timeoutSeconds": True},
            {"timeoutSeconds": "30"},
            {"shellCommand": ""},
            {"shellCommand": "echo\x00hi"},
            {"maxOutputBytes": 0},
        ]
        for overrides in bad:
            with self.subTest(overrides=overrides):
                with self.assertRaises(PayloadRejected) as caught:
                    self.run_exec(**overrides)
                self.assertIn(caught.exception.code, ("INVALID_PAYLOAD",))
        self.assertIsNone(self.popen_args)

    def test_the_real_entry_point_dispatches_exec_and_reads_the_shell_command_from_its_own_field(self):
        # The dispatcher already uses "command" for the action name ("exec"), so the shell command
        # must travel in a different field. Going through main() catches a collision.
        payload = {"command": "exec", "shellCommand": "echo via-main", "projectDir": self.project.name, "runId": "run9", "timeoutSeconds": 5}
        with mock.patch.object(dm.sys.stdin, "read", return_value=__import__("json").dumps(payload)):
            dm.main()
        self.assertEqual(self.popen_args[-3:], ["sh", "-c", "echo via-main"])
        self.assertEqual(self.results[-1]["status"], "success")

    def test_boundary_timeouts_are_accepted(self):
        for seconds in (1, 3600):
            self.proc = FakeProc(b"")
            self.assertEqual(self.run_exec(timeoutSeconds=seconds)["status"], "success")


if __name__ == "__main__":
    unittest.main()
