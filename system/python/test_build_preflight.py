import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent))
import build_manager as manager
from node_preflight import NodePreflightError, inspect_node_project, validate_node_plan


def plan_for(major=9, corepack=False, corepack_version="0.34.5"):
    commands = ["pnpm i --frozen-lockfile"]
    if corepack:
        commands.insert(0, f"npm install -g corepack@{corepack_version} && corepack enable")
    return {"phases": {"setup": {"nixPkgs": ["nodejs_22", f"pnpm-{major}_x"]},
                       "install": {"cmds": commands}}}


class BuildPreflightTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="vexlyx-preflight-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.manifest = {"packageManager": "pnpm@9.15.9", "dependencies": {"next": "15.0.0"},
                         "scripts": {"build": "next build", "start": "next start"}}
        self.write_manifest()
        (self.root / "pnpm-lock.yaml").write_text("lockfileVersion: '9.0'\n", encoding="utf-8")

    def write_manifest(self):
        (self.root / "package.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def workspace(self, content):
        (self.root / "pnpm-workspace.yaml").write_text(content, encoding="utf-8")

    def build(self, plan=None, **overrides):
        result = Mock(returncode=0, stdout=json.dumps(plan or plan_for(corepack=True)), stderr="")
        process = Mock(stdout=[], returncode=0)
        with patch.object(manager, "get_nixpacks_binary", return_value="nixpacks"), \
             patch.object(manager.subprocess, "run", return_value=result), \
             patch.object(manager.subprocess, "Popen", return_value=process) as popen, \
             contextlib.redirect_stdout(io.StringIO()):
            manager.cmd_build({"projectDir": str(self.root), "imageName": "preflight-test", **overrides})
        return popen.call_args.args[0]

    def test_single_package_without_workspace(self):
        self.assertEqual(inspect_node_project(self.root).manager, "pnpm")
        self.assertNotIn("--install-cmd", self.build())

    def test_valid_workspace_forms_are_unchanged(self):
        for content in ('packages: ["."]\n', 'packages:\n  - apps/*\n  - packages/*\n  - "!**/test/**"\n', 'packages: []\n', 'packages: [on, off, 2026-10-13]\n'):
            with self.subTest(content=content):
                self.workspace(content)
                before = {path.name: path.read_bytes() for path in self.root.iterdir()}
                self.build()
                self.assertEqual(before, {path.name: path.read_bytes() for path in self.root.iterdir()})

    def test_missing_packages_fails_before_plan_or_docker_for_older_pnpm(self):
        self.workspace("allowBuilds:\n  sharp: false\n")
        with patch.object(manager.subprocess, "run") as run, patch.object(manager.subprocess, "Popen") as popen:
            with self.assertRaises(NodePreflightError) as caught:
                manager.cmd_build({"projectDir": str(self.root), "imageName": "test"})
        self.assertEqual(caught.exception.code, "INVALID_PNPM_WORKSPACE")
        self.assertEqual(caught.exception.details["file"], "pnpm-workspace.yaml")
        self.assertIn('packages: ["."]', caught.exception.details["remediation"])
        run.assert_not_called()
        popen.assert_not_called()

    def test_missing_packages_allowed_since_10_5(self):
        self.workspace("allowBuilds:\n  sharp: false\n")
        for version in ("10.5.0", "11.24.0"):
            with self.subTest(version=version):
                self.manifest["packageManager"] = f"pnpm@{version}"
                self.write_manifest()
                self.build()

    def test_old_effective_version_without_declaration_fails_before_docker(self):
        self.manifest.pop("packageManager")
        self.write_manifest()
        self.workspace("allowBuilds:\n  sharp: false\n")
        with self.assertRaises(NodePreflightError) as caught:
            self.build(plan_for())
        self.assertEqual(caught.exception.code, "INVALID_PNPM_WORKSPACE")

    def test_invalid_yaml_and_invalid_packages(self):
        for content in ("packages: [", "packages: .", "packages: [1]", 'packages: [""]', "- not-a-map", "packages: !!python/object/apply:os.system ['echo unsafe']"):
            with self.subTest(content=content):
                self.workspace(content)
                with self.assertRaises(NodePreflightError) as caught:
                    inspect_node_project(self.root)
                self.assertEqual(caught.exception.code, "INVALID_PNPM_WORKSPACE")

    def test_malformed_package_json(self):
        for content in ("{", "[]", '{"scripts": []}', '{"scripts": {"build": 42}}', '{"version": NaN}'):
            with self.subTest(content=content):
                (self.root / "package.json").write_text(content)
                with self.assertRaises(NodePreflightError) as caught:
                    inspect_node_project(self.root)
                self.assertEqual(caught.exception.code, "INVALID_PACKAGE_JSON")

    def test_declaration_wins_with_explicit_conflict_warning(self):
        self.manifest["packageManager"] = "npm@10.9.0"
        self.write_manifest()
        node = inspect_node_project(self.root)
        self.assertEqual(node.manager, "npm")
        self.assertIn("CONFLICTING_LOCKFILES", node.warnings[0])
        self.assertEqual(manager.detect_framework_and_commands(self.root, {})[1], "npm run build")

    def test_multiple_lockfiles_without_declaration_fail(self):
        self.manifest.pop("packageManager")
        self.write_manifest()
        (self.root / "yarn.lock").touch()
        (self.root / "package-lock.json").touch()
        with self.assertRaises(NodePreflightError) as caught:
            inspect_node_project(self.root)
        self.assertEqual(caught.exception.code, "CONFLICTING_LOCKFILES")

    def test_pnpm_11_requires_a_compatible_effective_phase(self):
        self.manifest["packageManager"] = "pnpm@11.24.0"
        self.write_manifest()
        with self.assertRaises(NodePreflightError) as caught:
            self.build(plan_for())
        self.assertEqual(caught.exception.code, "PACKAGE_MANAGER_VERSION_UNSUPPORTED")
        self.assertIn("pnpm 9", str(caught.exception))
        self.assertNotIn("--install-cmd", self.build(plan_for(corepack=True)))
        with self.assertRaises(NodePreflightError):
            self.build(plan_for(corepack=True), installCmd="pnpm install")

    def test_old_corepack_is_rejected_with_a_working_remediation(self):
        self.manifest["packageManager"] = "pnpm@11.24.0"
        self.write_manifest()
        with self.assertRaises(NodePreflightError) as caught:
            self.build(plan_for(corepack=True, corepack_version="0.24.1"))
        self.assertEqual(caught.exception.code, "PACKAGE_MANAGER_VERSION_UNSUPPORTED")
        self.assertIn("Corepack 0.34.5+", str(caught.exception))
        self.build(plan_for(corepack=True, corepack_version="0.24.1"),
                   installCmd="npm install -g corepack@0.34.5 && corepack enable && pnpm install --frozen-lockfile")

    def test_explicit_install_override_is_preserved(self):
        command = "corepack enable && pnpm install --frozen-lockfile"
        args = self.build(installCmd=command)
        self.assertEqual(args[args.index("--install-cmd") + 1], command)

    def test_required_scripts_and_custom_commands(self):
        self.manifest["scripts"] = {}
        self.write_manifest()
        with self.assertRaises(NodePreflightError) as caught:
            self.build()
        self.assertEqual(caught.exception.code, "MISSING_BUILD_SCRIPT")
        self.build(buildCmd="next build", startCmd="next start")

    def test_missing_start_script_is_actionable(self):
        self.manifest["scripts"].pop("start")
        self.write_manifest()
        with self.assertRaises(NodePreflightError) as caught:
            self.build()
        self.assertEqual(caught.exception.code, "MISSING_START_SCRIPT")

    def test_monorepo_plan_does_not_require_root_scripts(self):
        self.manifest["scripts"] = {}
        self.write_manifest()
        plan = plan_for(corepack=True)
        plan["phases"]["build"] = {"cmds": ["pnpm --filter web build"]}
        plan["start"] = {"cmd": "pnpm --filter web start"}
        args = self.build(plan)
        self.assertEqual(args[args.index("--build-cmd") + 1], "pnpm --filter web build")

    def test_dockerfile_bypasses_node_validation_and_nixpacks(self):
        (self.root / "Dockerfile").write_text("FROM node:22\n")
        (self.root / "package.json").write_text("{")
        with patch.object(manager, "get_nixpacks_binary") as binary:
            result = manager.make_build_plan({"projectDir": str(self.root)})
        self.assertEqual(result["detectedType"], "DOCKER")
        binary.assert_not_called()

    def test_unusable_engine_plan_never_reaches_docker(self):
        with patch.object(manager, "get_nixpacks_binary", return_value="nixpacks"), \
             patch.object(manager.subprocess, "run", return_value=Mock(returncode=0, stdout='{"phases": []}', stderr="")), \
             patch.object(manager.subprocess, "Popen") as popen, contextlib.redirect_stdout(io.StringIO()) as output:
            with self.assertRaises(SystemExit):
                manager.cmd_build({"projectDir": str(self.root), "imageName": "test"})
        self.assertEqual(json.loads(output.getvalue())["code"], "NIXPACKS_PLAN_FAILED")
        popen.assert_not_called()

    def test_npm_yarn_bun_remain_compatible(self):
        for name, version in (("npm", "10.9.0"), ("yarn", "1.22.22"), ("bun", "1.2.0")):
            with self.subTest(manager=name):
                self.manifest["packageManager"] = f"{name}@{version}"
                self.write_manifest()
                plan = {"phases": {"setup": {"nixPkgs": ["nodejs_22"]}, "install": {"cmds": [f"{name} install"]}}}
                self.assertNotIn("--install-cmd", self.build(plan))

    def test_plan_manager_mismatch_is_actionable(self):
        plan = plan_for()
        plan["phases"]["install"]["cmds"] = ["bun install"]
        with self.assertRaises(NodePreflightError) as caught:
            validate_node_plan(inspect_node_project(self.root), plan)
        self.assertEqual(caught.exception.code, "PACKAGE_MANAGER_MISMATCH")

    def test_pnpm_11_incompatible_node_is_rejected_before_docker(self):
        self.manifest["packageManager"] = "pnpm@11.24.0"
        self.write_manifest()
        plan = plan_for(corepack=True)
        plan["phases"]["setup"]["nixPkgs"] = ["nodejs_20", "pnpm-9_x"]
        with self.assertRaises(NodePreflightError) as caught:
            self.build(plan)
        self.assertIn("Node.js 22.13+", str(caught.exception))

    def test_npm_version_mismatch_is_reported(self):
        self.manifest["packageManager"] = "npm@10.9.0"
        self.write_manifest()
        plan = {"phases": {"setup": {"nixPkgs": ["nodejs_22", "npm-9_x"]}, "install": {"cmds": ["npm ci"]}}}
        with self.assertRaises(NodePreflightError) as caught:
            self.build(plan)
        self.assertEqual(caught.exception.code, "PACKAGE_MANAGER_VERSION_UNSUPPORTED")

    def test_pnpm_10_bootstrap_does_not_claim_an_unknown_minor(self):
        self.manifest.pop("packageManager")
        self.write_manifest()
        self.workspace("allowBuilds:\n  sharp: false\n")
        self.build(plan_for(major=10))

    def test_tags_do_not_use_bootstrap_version_for_workspace_rules(self):
        self.manifest["packageManager"] = "pnpm@latest"
        self.write_manifest()
        self.workspace("allowBuilds:\n  sharp: false\n")
        self.build(plan_for(corepack=True))

    def test_explicit_toolchain_provisioning_is_respected(self):
        self.manifest["packageManager"] = "pnpm@11.24.0"
        self.write_manifest()
        self.build(installCmd="npm install -g pnpm@11.24.0 && pnpm install")
        self.build(installCmd="corepack pnpm install")
        self.build(installCmd="./scripts/install-toolchain.sh")

    def test_cli_returns_structured_preflight_error(self):
        self.workspace("allowBuilds:\n  sharp: false\n")
        result = subprocess.run([sys.executable, str(Path(manager.__file__))],
                                input=json.dumps({"command": "build", "projectDir": str(self.root), "imageName": "test"}),
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 1)
        error = json.loads(result.stdout)
        self.assertEqual(error["code"], "INVALID_PNPM_WORKSPACE")
        self.assertIn('packages: ["."]', error["details"]["remediation"])


@unittest.skipUnless(os.environ.get("NIXPACKS_INTEGRATION"), "Set NIXPACKS_INTEGRATION=1 to test the real engine")
class NixpacksIntegrationTests(unittest.TestCase):
    setUp = BuildPreflightTests.setUp
    write_manifest = BuildPreflightTests.write_manifest
    workspace = BuildPreflightTests.workspace

    def test_real_pnpm_11_plan_reports_old_corepack_and_accepts_explicit_fix(self):
        self.manifest["packageManager"] = "pnpm@11.24.0"
        self.manifest["engines"] = {"node": "22"}
        self.write_manifest()
        self.workspace("allowBuilds:\n  sharp: false\n")
        with self.assertRaises(NodePreflightError) as caught:
            manager.make_build_plan({"projectDir": str(self.root)})
        self.assertEqual(caught.exception.code, "PACKAGE_MANAGER_VERSION_UNSUPPORTED")
        self.assertIn("Corepack 0.24.1", str(caught.exception))
        result = manager.make_build_plan({"projectDir": str(self.root), "installCmd":
                                         "npm install -g corepack@0.34.5 && corepack enable && pnpm install --frozen-lockfile"})
        self.assertEqual(result["framework"], "nextjs")

    def test_real_valid_pnpm_workspace_proceeds_without_source_mutation(self):
        self.manifest["engines"] = {"node": "22"}
        self.write_manifest()
        for content in ('packages: ["."]\n', 'packages: ["apps/*", "packages/*"]\n'):
            with self.subTest(content=content):
                self.workspace(content)
                before = {path.name: path.read_bytes() for path in self.root.iterdir()}
                result = manager.make_build_plan({"projectDir": str(self.root)})
                self.assertEqual(result["framework"], "nextjs")
                self.assertEqual(before, {path.name: path.read_bytes() for path in self.root.iterdir()})

    def test_real_npm_yarn_bun_plans_still_detect_nextjs(self):
        for package_manager in ("npm@9.9.0", "yarn@1.22.22", "bun@1.2.0"):
            with self.subTest(package_manager=package_manager):
                for filename in ("pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"):
                    (self.root / filename).unlink(missing_ok=True)
                lockfile = {"npm": "package-lock.json", "yarn": "yarn.lock", "bun": "bun.lock"}[package_manager.split("@")[0]]
                (self.root / lockfile).write_text('{"lockfileVersion": 3}' if lockfile.endswith(".json") else "# fixture lockfile\n")
                self.manifest["packageManager"] = package_manager
                self.manifest["engines"] = {"node": "22"}
                self.write_manifest()
                result = manager.make_build_plan({"projectDir": str(self.root)})
                self.assertEqual(result["framework"], "nextjs")


if __name__ == "__main__":
    unittest.main()
