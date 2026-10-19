"""
test_scheduled_task_exec.py — F5.28 scheduled task execution.

Covers the docker_manager `exec` action that F5.28 runs a scheduled task's
command through, including the regression guard for the review finding
"PHP jobs run in nginx": exec must resolve the *application* container (the
"app" service), not the HTTP-facing one — for WordPress and no-build PHP the
front container is nginx (`web`), which has no PHP binary.

Run: python tests/test_scheduled_task_exec.py
"""

import io
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "system" / "python"))

import docker_manager  # noqa: E402

WORDPRESS_COMPOSE = """\
services:
  app:
    image: wordpress:php8.2-fpm
  web:
    image: nginx:alpine
    depends_on:
      - app
"""

NODE_COMPOSE = """\
services:
  app:
    image: node:20-alpine
"""

NO_APP_COMPOSE = """\
services:
  web:
    image: nginx:alpine
"""


class FakeProcess:
    """Stand-in for subprocess.Popen: a finished exec with captured output."""

    def __init__(self, output: bytes, returncode: int = 0):
        self.stdout = io.BytesIO(output)
        self.returncode = returncode

    def wait(self, timeout=None):
        return self.returncode

    def terminate(self):
        pass

    def kill(self):
        pass


def run_exec(compose_text: str, project_type: str, command: str = "php wp-cron.php") -> tuple[dict, list]:
    """Run cmd_exec against a synthetic deploy dir.

    Returns (response payload, list of argvs handed to subprocess).
    `docker compose ps -q <service>` answers with "<service>-container" so a
    test can tell which service the exec landed in.
    """
    with tempfile.TemporaryDirectory() as tmp:
        project_dir = Path(tmp)
        deploy = project_dir / "deploy"
        deploy.mkdir()
        (deploy / "docker-compose.yml").write_text(compose_text, encoding="utf-8")

        argvs = []
        response = {}

        def fake_run(cmd, **_kwargs):
            argvs.append(list(cmd))
            return SimpleNamespace(stdout=f"{cmd[-1]}-container\n", stderr="")

        def fake_popen(cmd, **_kwargs):
            argvs.append(list(cmd))
            return FakeProcess(b"ran ok\n")

        originals = {
            "subprocess": docker_manager.subprocess,
            "get_docker_binary": docker_manager.get_docker_binary,
            "respond": docker_manager.respond,
        }
        docker_manager.subprocess = SimpleNamespace(
            run=fake_run,
            Popen=fake_popen,
            PIPE=-1,
            DEVNULL=-3,
            STDOUT=-2,
        )
        docker_manager.get_docker_binary = lambda: "docker"
        docker_manager.respond = lambda data: response.update(data)
        try:
            docker_manager.cmd_exec(
                {
                    "projectDir": str(project_dir),
                    "projectType": project_type,
                    "shellCommand": command,
                    "timeout": 10,
                }
            )
        finally:
            for name, value in originals.items():
                setattr(docker_manager, name, value)

    return response, argvs


def ps_service(argvs) -> str:
    """Service name requested by the single `docker compose ps -q` call."""
    ps_calls = [a for a in argvs if len(a) > 2 and a[1:3] == ["compose", "ps"]]
    assert len(ps_calls) == 1, f"expected exactly one compose ps call, got: {ps_calls}"
    return ps_calls[0][-1]


def exec_container(argvs) -> str:
    """Container id the command was exec'd into."""
    exec_calls = [a for a in argvs if len(a) > 1 and a[1] == "exec"]
    assert exec_calls, f"no docker exec call recorded: {argvs}"
    # [docker, exec, -e, MARKER, container, sh, -c, command]
    return exec_calls[0][4]


def test_exec_targets_application_container_for_wordpress():
    print("Testing that exec lands in the PHP-FPM container, not nginx (WordPress)...")
    response, argvs = run_exec(WORDPRESS_COMPOSE, "WORDPRESS")

    assert response.get("exitCode") == 0, f"unexpected response: {response}"
    assert ps_service(argvs) == "app", "status/logs may use 'web', exec must resolve 'app'"
    assert exec_container(argvs) == "app-container", (
        f"WordPress commands must run in the PHP-FPM 'app' container, got: {exec_container(argvs)}"
    )
    print("  [PASS] WordPress exec targets the 'app' (PHP-FPM) container")


def test_exec_targets_application_container_for_node():
    print("Testing that exec resolves the application container for a single-service project...")
    _response, argvs = run_exec(NODE_COMPOSE, "NODEJS", command="node worker.js")

    assert ps_service(argvs) == "app"
    assert exec_container(argvs) == "app-container"
    print("  [PASS] single-service project execs into 'app'")


def test_app_container_id_falls_back_without_app_service():
    print("Testing app_container_id fallback for a compose file with no 'app' service...")
    with tempfile.TemporaryDirectory() as tmp:
        deploy = Path(tmp) / "deploy"
        deploy.mkdir()
        (deploy / "docker-compose.yml").write_text(NO_APP_COMPOSE, encoding="utf-8")

        originals = {
            "subprocess": docker_manager.subprocess,
            "get_docker_binary": docker_manager.get_docker_binary,
        }
        docker_manager.subprocess = SimpleNamespace(
            run=lambda cmd, **_kwargs: SimpleNamespace(stdout=f"{cmd[-1]}-container\n", stderr=""),
            Popen=None,
            PIPE=-1,
            DEVNULL=-3,
            STDOUT=-2,
        )
        docker_manager.get_docker_binary = lambda: "docker"
        try:
            container = docker_manager.app_container_id(str(deploy), "docker", "WORDPRESS")
        finally:
            for name, value in originals.items():
                setattr(docker_manager, name, value)

    assert container == "web-container", f"expected the HTTP-facing fallback, got: {container}"
    print("  [PASS] falls back to the HTTP-facing container when no 'app' service exists")


def test_compose_has_service():
    print("Testing compose_has_service detection...")
    with tempfile.TemporaryDirectory() as tmp:
        deploy = Path(tmp) / "deploy"
        deploy.mkdir()
        compose = deploy / "docker-compose.yml"
        compose.write_text(WORDPRESS_COMPOSE, encoding="utf-8")

        assert docker_manager.compose_has_service(deploy, "app") is True
        assert docker_manager.compose_has_service(deploy, "web") is True
        assert docker_manager.compose_has_service(deploy, "redis") is False
        assert docker_manager.compose_has_service(Path(tmp) / "missing", "app") is False
    print("  [PASS] service keys are detected (and unknown ones are not)")


def main():
    print("=== Running F5.28 Scheduled Task Exec Automated Test Suite ===")
    test_exec_targets_application_container_for_wordpress()
    test_exec_targets_application_container_for_node()
    test_app_container_id_falls_back_without_app_service()
    test_compose_has_service()
    print("\n[SUCCESS] ALL SCHEDULED TASK EXEC TESTS PASSED SUCCESSFULLY!")


if __name__ == "__main__":
    main()
