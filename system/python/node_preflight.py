import json
import re
from dataclasses import dataclass, field
from pathlib import Path


class NodePreflightError(Exception):
    def __init__(self, code: str, message: str, file: str, remediation: str):
        super().__init__(message)
        self.code = code
        self.details = {"file": file, "remediation": remediation}


@dataclass
class NodeProject:
    manifest: dict
    manager: str
    version: str | None
    workspace_file: str | None = None
    workspace: dict | None = None
    warnings: list[str] = field(default_factory=list)


LOCKFILES = {
    "npm": ("package-lock.json", "npm-shrinkwrap.json"),
    "pnpm": ("pnpm-lock.yaml",),
    "yarn": ("yarn.lock",),
    "bun": ("bun.lock", "bun.lockb"),
}
MAX_CONFIG_BYTES = 1024 * 1024


def read_config(path: Path, code: str) -> str:
    try:
        if path.stat().st_size > MAX_CONFIG_BYTES:
            raise ValueError("configuration exceeds the 1 MiB limit")
        return path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError, ValueError) as exc:
        raise NodePreflightError(code, f"Cannot read {path.name}: {exc}", path.name,
                                 f"Make {path.name} readable UTF-8 and smaller than 1 MiB.") from exc


def package_manager(project_dir: Path, manifest: dict) -> tuple[str, str | None, list[str]]:
    detected = [manager for manager, names in LOCKFILES.items()
                if any((project_dir / name).is_file() for name in names)]
    declared = manifest.get("packageManager")
    version = None
    warnings = []
    if declared is not None:
        # Corepack integrity suffixes (e.g. +sha512...) are part of the declaration.
        match = re.fullmatch(r"(npm|pnpm|yarn|bun)@([^\s]+)", declared) if isinstance(declared, str) and len(declared) <= 256 else None
        if not match:
            raise NodePreflightError("INVALID_PACKAGE_MANAGER", "Invalid packageManager in package.json.",
                                     "package.json", 'Declare a supported manager and version, e.g. "pnpm@10.5.0".')
        manager, version = match.groups()
        if any(item != manager for item in detected):
            warnings.append(f"CONFLICTING_LOCKFILES: packageManager selects {manager}; remove lockfiles for other managers: "
                            + ", ".join(name for item in detected if item != manager for name in LOCKFILES[item]
                                        if (project_dir / name).is_file()))
    elif len(detected) > 1:
        files = [name for item in detected for name in LOCKFILES[item] if (project_dir / name).is_file()]
        raise NodePreflightError("CONFLICTING_LOCKFILES", "Conflicting package-manager lockfiles: " + ", ".join(files),
                                 "package.json", "Declare packageManager and remove stale lockfiles so the build uses one toolchain.")
    else:
        manager = detected[0] if detected else "npm"
    return manager, version, warnings


def resolve_package_manager(project_dir: Path) -> str:
    manifest_path = project_dir / "package.json"
    if not manifest_path.is_file():
        return "npm"
    return package_manager(project_dir, load_manifest(manifest_path))[0]


def load_manifest(path: Path) -> dict:
    try:
        def invalid_constant(value):
            raise ValueError(f"{value} is not valid JSON")
        manifest = json.loads(read_config(path, "INVALID_PACKAGE_JSON"), parse_constant=invalid_constant)
        if not isinstance(manifest, dict):
            raise ValueError("expected a JSON object")
        for name in ("scripts", "dependencies", "devDependencies", "engines"):
            if name in manifest and not isinstance(manifest[name], dict):
                raise ValueError(f"{name} must be an object")
        if any(not isinstance(value, str) for value in manifest.get("scripts", {}).values()):
            raise ValueError("script commands must be strings")
        return manifest
    except (ValueError, RecursionError) as exc:
        raise NodePreflightError("INVALID_PACKAGE_JSON", f"Invalid package.json: {exc}",
                                 "package.json", "Fix package.json so it contains a valid JSON object with valid scripts and dependency maps.") from exc


def load_workspace(path: Path) -> dict:
    try:
        import yaml
    except ImportError as exc:
        raise NodePreflightError("PREFLIGHT_DEPENDENCY_MISSING", "The build preflight YAML parser is not installed.",
                                 path.name, "Ask the administrator to install system/python/requirements-build.txt and rebuild the API runtime.") from exc
    try:
        content = read_config(path, "INVALID_PNPM_WORKSPACE")
        # SafeLoader prevents repository YAML from constructing Python objects.
        if sum(isinstance(token, yaml.tokens.AliasToken) for token in yaml.scan(content)) > 100:
            raise ValueError("too many YAML aliases")
        class WorkspaceLoader(yaml.SafeLoader):
            pass

        # pnpm uses YAML 1.2: bare glob names like on/off are strings, not YAML 1.1 booleans.
        WorkspaceLoader.yaml_implicit_resolvers = {
            key: [(tag, pattern) for tag, pattern in entries
                  if tag not in ("tag:yaml.org,2002:bool", "tag:yaml.org,2002:timestamp")]
            for key, entries in yaml.SafeLoader.yaml_implicit_resolvers.items()
        }
        WorkspaceLoader.add_implicit_resolver("tag:yaml.org,2002:bool", re.compile(r"^(?:true|false|True|False|TRUE|FALSE)$"), list("tTfF"))
        data = yaml.load(content, Loader=WorkspaceLoader)
        if data is None:
            return {}
        if not isinstance(data, dict):
            raise ValueError("expected a YAML mapping")
        packages = data.get("packages")
        if "packages" in data and (not isinstance(packages, list)
                                   or any(not isinstance(item, str) or not item.strip() for item in packages)):
            raise ValueError("packages must be a list of non-empty strings")
        return data
    except (yaml.YAMLError, ValueError, RecursionError) as exc:
        raise NodePreflightError("INVALID_PNPM_WORKSPACE", f"Invalid pnpm workspace in {path.name}: {exc}",
                                 path.name, 'Use a packages list such as packages: ["."] for a single package, or packages: ["apps/*", "packages/*"] for a monorepo.') from exc


def version_tuple(version: str | None) -> tuple[int, int, int] | None:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:[-+].*)?", version or "")
    return tuple(int(part) for part in match.groups()) if match else None


def validate_workspace_version(project: NodeProject, version: tuple[int, int, int] | None) -> None:
    # pnpm made packages optional in 10.5.0: https://github.com/pnpm/pnpm/releases/tag/v10.5.0
    if project.workspace and "packages" not in project.workspace and version and version < (10, 5, 0):
        filename = project.workspace_file or "pnpm-workspace.yaml"
        raise NodePreflightError("INVALID_PNPM_WORKSPACE",
                                 f"Invalid pnpm workspace: {filename} has no packages list, required by pnpm {'.'.join(map(str, version))}.",
                                 filename, 'For a single-package project, add packages: ["."], remove the workspace file if unnecessary, or use a compatible pnpm version (10.5.0+).')


def inspect_node_project(project_dir: Path) -> NodeProject | None:
    path = project_dir / "package.json"
    if not path.is_file():
        return None
    manifest = load_manifest(path)
    manager, version, warnings = package_manager(project_dir, manifest)
    project = NodeProject(manifest, manager, version, warnings=warnings)
    if manager == "pnpm":
        for name in ("pnpm-workspace.yaml", "pnpm-workspace.yml"):
            workspace_path = project_dir / name
            if workspace_path.is_file():
                if project.workspace_file:
                    raise NodePreflightError("INVALID_PNPM_WORKSPACE", "Both pnpm-workspace.yaml and pnpm-workspace.yml exist.",
                                             name, "Keep a single pnpm-workspace.yaml file to avoid ambiguous configuration.")
                project.workspace_file = name
                project.workspace = load_workspace(workspace_path)
                if name.endswith(".yml"):
                    warnings.append("pnpm-workspace.yml is not pnpm's standard workspace filename; rename it to pnpm-workspace.yaml.")
        validate_workspace_version(project, version_tuple(version))
    return project


def validate_script_commands(project: NodeProject | None, build_cmd: str | None, start_cmd: str | None) -> None:
    if project is None:
        return
    scripts = project.manifest.get("scripts", {})
    for command in (build_cmd, start_cmd):
        # Only direct root script invocations require a root script; filters and custom commands do not.
        match = re.fullmatch(r"(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(build|start)(?:\s+--\s+.*)?", command or "")
        if match and not scripts.get(match[1], "").strip():
            script = match[1]
            raise NodePreflightError(f"MISSING_{script.upper()}_SCRIPT", f"package.json has no usable {script} script required by '{command}'.",
                                     "package.json", f"Add scripts.{script} or configure a custom {script} command that does not depend on it.")


def validate_node_plan(project: NodeProject | None, plan: dict, install_override: str | None = None) -> None:
    if project is None:
        return
    phases = plan.get("phases", {})
    setup = phases.get("setup", {})
    install = phases.get("install", {})
    packages = setup.get("nixPkgs", [])
    commands = [install_override] if install_override else install.get("cmds", [])
    command_text = " && ".join(command for command in commands if isinstance(command, str))
    toolchain_text = " && ".join([*setup.get("cmds", []), command_text])
    corepack = project.manager in ("pnpm", "yarn") and bool(
        re.search(r"(?:^|&&)\s*corepack\s+(?:enable\b|" + project.manager + r"\b)", toolchain_text))
    installs = re.findall(r"(?:^|&&)\s*(npm|pnpm|yarn|bun)\s+(?:i|install|ci)\b([^&]*)", command_text)
    installers = [manager for manager, arguments in installs if "corepack" not in arguments]
    if not install_override and installers and installers[-1] != project.manager:
        raise NodePreflightError("PACKAGE_MANAGER_MISMATCH",
                                 f"package.json selects {project.manager}, but the build plan installs with {installers[-1]}.",
                                 "package.json", "Remove conflicting lockfiles or configure an explicit install command for the declared package manager.")
    requested = version_tuple(project.version)
    explicitly_provisioned = bool(requested and re.search(
        r"\b(?:npm\s+(?:i|install)\s+(?:-g|--global)|corepack\s+(?:prepare|install\s+-g))\s+"
        + re.escape(f"{project.manager}@{project.version}") + r"(?=\s|&&|;|$)", toolchain_text))
    honors_declaration = corepack or explicitly_provisioned
    corepack_pins = re.findall(r"\bcorepack@([^\s&;]+)", toolchain_text)
    corepack_version = version_tuple(corepack_pins[-1]) if corepack_pins else None
    # Corepack added pnpm 11's .mjs entry point in 0.34.5: https://github.com/nodejs/corepack/pull/776
    if project.manager == "pnpm" and requested and requested[0] >= 11 and corepack and not explicitly_provisioned:
        if corepack_version and corepack_version < (0, 34, 5):
            raise NodePreflightError("PACKAGE_MANAGER_VERSION_UNSUPPORTED",
                                     f"pnpm@{project.version} requires Corepack 0.34.5+, but the build plan installs Corepack {corepack_pins[-1]}.",
                                     "package.json", "Use a build engine with a compatible Corepack phase, supply an explicit install command such as 'npm install -g corepack@0.34.5 && corepack enable && pnpm install --frozen-lockfile' with Node.js 22.13+, or use a Dockerfile that provisions the declared toolchain.")
        if corepack_version is None:
            project.warnings.append("PACKAGE_MANAGER_VERSION_UNVERIFIED: pnpm 11+ requires Corepack 0.34.5+; the plan does not pin a verifiable Corepack version.")
    if install_override and not installers and not honors_declaration:
        project.warnings.append("PACKAGE_MANAGER_VERSION_UNVERIFIED: the custom install command manages its own toolchain; verify that it provisions the declared package manager and compatible Node runtime.")
        return
    effective = None
    effective_major = None
    if project.manager == "pnpm":
        node_major = next((int(match[1]) for item in packages if isinstance(item, str)
                           and (match := re.fullmatch(r"nodejs_(\d+)", item))), None)
        if requested and requested[0] == 11 and node_major and node_major < 22:
            raise NodePreflightError("PACKAGE_MANAGER_VERSION_UNSUPPORTED",
                                     f"pnpm@{project.version} requires Node.js 22.13+, but the build plan selects Node.js {node_major}.",
                                     "package.json", 'Declare a compatible Node runtime, e.g. "engines": {"node": ">=22.13"}, or use a compatible package manager.')
        if honors_declaration and project.version:
            effective = requested
            effective_major = requested[0] if requested else None
        else:
            match = next((re.fullmatch(r"pnpm-(\d+)_x", item) for item in packages
                          if isinstance(item, str) and re.fullmatch(r"pnpm-(\d+)_x", item)), None)
            if match:
                effective_major = int(match[1])
                if effective_major < 10:
                    effective = (effective_major, 0, 0)
        if requested and not honors_declaration and effective_major != requested[0]:
            selected = f"pnpm {effective_major}" if effective_major else "an unverified pnpm version"
            raise NodePreflightError("PACKAGE_MANAGER_VERSION_UNSUPPORTED",
                                     f"The build plan selects {selected}, but package.json declares pnpm@{project.version}.",
                                     "package.json", "Preserve Nixpacks' Corepack install phase, use a supported package-manager version, or supply a Dockerfile with the required toolchain.")
        validate_workspace_version(project, effective)
    elif requested and project.manager == "yarn" and requested[0] > 1 and not honors_declaration:
        raise NodePreflightError("PACKAGE_MANAGER_VERSION_UNSUPPORTED", f"Yarn {project.version} requires Corepack, but the effective install phase does not enable it.",
                                 "package.json", "Remove the install override or use a Dockerfile that provisions the declared Yarn version.")
    elif requested and project.manager == "npm":
        npm_major = next((int(match[1]) for item in packages if isinstance(item, str)
                          and (match := re.fullmatch(r"npm-(\d+)_x", item))), None)
        if npm_major and npm_major != requested[0] and not honors_declaration:
            raise NodePreflightError("PACKAGE_MANAGER_VERSION_UNSUPPORTED",
                                     f"package.json declares npm@{project.version}, but the build plan selects npm {npm_major}.",
                                     "package.json", "Use a supported npm version or a Dockerfile that provisions the declared npm version.")
    if project.version and requested is None:
        project.warnings.append(f"PACKAGE_MANAGER_VERSION_UNVERIFIED: {project.manager}@{project.version} is not an exact numeric version; pin a version for reproducible builds.")
    elif requested and not honors_declaration:
        project.warnings.append(f"PACKAGE_MANAGER_VERSION_UNVERIFIED: Nixpacks does not pin {project.manager}@{project.version} in the install phase. Use Corepack or a Dockerfile when an exact version is required.")
