"""
test_nextjs_runtime.py — Automated test suite for F2.1 Next.js Deployment.

Tests:
1. Next.js auto-detection via next.config.js, next.config.mjs, next.config.ts, next.config.cjs
2. Next.js auto-detection via package.json dependencies
3. Package manager lockfile detection (npm, pnpm, yarn, bun)
4. Docker compose template generation with next.yml (HOST, HOSTNAME, PORT, NEXT_TELEMETRY_DISABLED)
5. Environment variable injection into next.yml template
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

REPO_ROOT = Path(__file__).resolve().parent.parent
BUILD_MANAGER = REPO_ROOT / "system" / "python" / "build_manager.py"
DOCKER_MANAGER = REPO_ROOT / "system" / "python" / "docker_manager.py"
TEMPLATES_DIR = REPO_ROOT / "system" / "templates" / "docker-compose"


def run_py_script(script_path: Path, payload: dict) -> tuple[int, dict, str]:
    proc = subprocess.Popen(
        [sys.executable, str(script_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    stdout, stderr = proc.communicate(json.dumps(payload))
    lines = [line.strip() for line in stdout.strip().split("\n") if line.strip()]
    last_line = lines[-1] if lines else "{}"
    try:
        parsed = json.loads(last_line)
    except Exception:
        parsed = {"raw": stdout}
    return proc.returncode, parsed, stderr


def test_nextjs_detection_configs():
    print("Testing Next.js detection via config files...")
    configs = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"]

    for cfg in configs:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmppath = Path(tmpdir)
            (tmppath / cfg).write_text("// Next.js config\nmodule.exports = {};", encoding="utf-8")
            (tmppath / "package.json").write_text(
                json.dumps({"name": "test-app", "scripts": {"build": "next build"}}),
                encoding="utf-8",
            )

            code, result, stderr = run_py_script(
                BUILD_MANAGER, {"command": "plan", "projectDir": str(tmppath)}
            )

            assert code == 0, f"Plan failed for {cfg}: {stderr}"
            assert result.get("framework") == "nextjs", f"Expected nextjs framework for {cfg}, got: {result}"
            assert result.get("detectedType") == "NEXTJS", f"Expected NEXTJS type for {cfg}, got: {result}"
            assert result.get("buildCmd") == "npm run build"
            assert result.get("startCmd") == "npm run start"
            print(f"  [PASS] Auto-detected via {cfg}")


def test_nextjs_detection_pkg_json():
    print("Testing Next.js detection via package.json dependencies...")
    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        (tmppath / "package.json").write_text(
            json.dumps({
                "name": "nextjs-app",
                "dependencies": {"next": "^15.0.0", "react": "^19.0.0"},
            }),
            encoding="utf-8",
        )

        code, result, stderr = run_py_script(
            BUILD_MANAGER, {"command": "plan", "projectDir": str(tmppath)}
        )

        assert code == 0, f"Plan failed for package.json deps: {stderr}"
        assert result.get("framework") == "nextjs", f"Expected nextjs, got: {result}"
        assert result.get("detectedType") == "NEXTJS"
        print("  [PASS] Auto-detected via package.json dependencies")


def test_package_manager_lockfiles():
    print("Testing package manager lockfile resolution for Next.js...")
    cases = [
        ("pnpm-lock.yaml", "pnpm run build", "pnpm run start"),
        ("yarn.lock", "yarn build", "yarn start"),
        ("bun.lockb", "bun run build", "bun run start"),
        ("package-lock.json", "npm run build", "npm run start"),
    ]

    for lockfile, expected_build, expected_start in cases:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmppath = Path(tmpdir)
            (tmppath / "next.config.js").write_text("module.exports = {};", encoding="utf-8")
            (tmppath / lockfile).write_text("# lockfile", encoding="utf-8")
            (tmppath / "package.json").write_text(json.dumps({"name": "test"}), encoding="utf-8")

            code, result, stderr = run_py_script(
                BUILD_MANAGER, {"command": "plan", "projectDir": str(tmppath)}
            )

            assert code == 0, f"Plan failed for {lockfile}: {stderr}"
            assert result.get("buildCmd") == expected_build, f"Expected {expected_build}, got {result.get('buildCmd')}"
            assert result.get("startCmd") == expected_start, f"Expected {expected_start}, got {result.get('startCmd')}"
            print(f"  [PASS] {lockfile} -> build: '{expected_build}', start: '{expected_start}'")


def test_nextjs_docker_template():
    print("Testing next.yml template rendering & parameters...")
    next_template_path = TEMPLATES_DIR / "next.yml"
    assert next_template_path.is_file(), "next.yml template does not exist"

    template_content = next_template_path.read_text(encoding="utf-8")
    assert "HOSTNAME: \"0.0.0.0\"" in template_content, "HOSTNAME 0.0.0.0 missing from template"
    assert "HOST: \"0.0.0.0\"" in template_content, "HOST 0.0.0.0 missing from template"
    assert "NEXT_TELEMETRY_DISABLED: \"1\"" in template_content, "NEXT_TELEMETRY_DISABLED missing"
    assert "PORT: \"{{container_port}}\"" in template_content, "PORT variable missing"
    assert "traefik.enable=true" in template_content, "Traefik labels missing"
    assert 'test: ["CMD", "node", "-e"' in template_content, "Node health check missing"
    assert "wget" not in template_content, "Next.js health check must not require wget"

    # Test template picking in docker_manager.py logic
    sys.path.insert(0, str(REPO_ROOT / "system" / "python"))
    import docker_manager

    assert docker_manager.pick_template("NEXTJS") == "next.yml", "pick_template(NEXTJS) should return next.yml"
    assert docker_manager.default_container_port("NEXTJS") == 3000, "default_container_port(NEXTJS) should be 3000"

    with tempfile.TemporaryDirectory() as tmpdir:
        tmppath = Path(tmpdir)
        docker_manager.generate_compose_file(
            compose_dir=tmppath,
            template_path=next_template_path,
            image_name="vexlyx-test-image",
            service_name="test-next-app",
            hostname="test.vexlyx.localhost",
            host_port=8150,
            container_port=3000,
            memory_limit="512m",
            env_vars={"NEXT_PUBLIC_API": "https://api.example.com", "DATABASE_URL": "postgres://..."},
        )

        compose_file = tmppath / "docker-compose.yml"
        assert compose_file.is_file(), "docker-compose.yml was not created"
        compose_text = compose_file.read_text(encoding="utf-8")

        assert "image: \"vexlyx-test-image\"" in compose_text
        assert "8150:3000" in compose_text
        assert "NEXT_PUBLIC_API" in compose_text
        assert "DATABASE_URL" in compose_text
        assert "test.vexlyx.localhost" in compose_text
        assert "connect(3000,'127.0.0.1'" in compose_text
        assert "wget" not in compose_text
        print("  [PASS] next.yml rendered correctly with all variables & labels")


def main():
    print("=== Running Next.js Runtime (F2.1) Automated Test Suite ===")
    test_nextjs_detection_configs()
    test_nextjs_detection_pkg_json()
    test_package_manager_lockfiles()
    test_nextjs_docker_template()
    print("\n[SUCCESS] ALL NEXT.JS RUNTIME TESTS PASSED SUCCESSFULLY!")


if __name__ == "__main__":
    main()
