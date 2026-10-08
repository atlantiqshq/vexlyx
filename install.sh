#!/usr/bin/env bash
# ==============================================================================
# Vexlyx — One-Line Server Installer (F5.1)
# Usage: curl -fsSL https://vexlyx.atlantiqs.org/install.sh | bash
#
# This is the thin, public entrypoint: it only figures out where the Vexlyx
# checkout lives (cloning/updating it if needed) and hands off to the real
# orchestrator at system/scripts/install/run.sh, which is versioned inside
# the repo itself so every actual install step can be reviewed, tested, and
# changed without touching this file.
# ==============================================================================
set -euo pipefail

VEXLYX_HOME="${VEXLYX_HOME:-/opt/vexlyx}"
VEXLYX_REPO_URL="${VEXLYX_REPO_URL:-https://github.com/atlantiqshq/vexlyx.git}"
VEXLYX_REPO_REF="${VEXLYX_REPO_REF:-main}"

if [[ ${EUID} -ne 0 ]]; then
  echo "[ERROR] This installer must be run as root (or with sudo)." >&2
  exit 1
fi

is_vexlyx_checkout() {
  [[ -f "$1/CLAUDE.md" && -f "$1/system/scripts/install/run.sh" ]]
}

if is_vexlyx_checkout "$(pwd)"; then
  # Already running from inside a Vexlyx checkout — use it as-is.
  VEXLYX_HOME="$(pwd)"
elif is_vexlyx_checkout "${VEXLYX_HOME}"; then
  echo "[install.sh] Found existing Vexlyx checkout at ${VEXLYX_HOME}."
  cd "${VEXLYX_HOME}"
  if [[ -d .git ]]; then
    if [[ -z "$(git status --porcelain 2>/dev/null)" ]]; then
      echo "[install.sh] Updating to the latest ${VEXLYX_REPO_REF}..."
      git fetch origin "${VEXLYX_REPO_REF}"
      git checkout "${VEXLYX_REPO_REF}"
      git pull --ff-only origin "${VEXLYX_REPO_REF}"
    else
      echo "[install.sh] Local changes detected in ${VEXLYX_HOME} — leaving them as-is, not pulling."
    fi
  else
    echo "[install.sh] ${VEXLYX_HOME} is not a git checkout — leaving it untouched, not updating."
  fi
elif [[ -e "${VEXLYX_HOME}" ]]; then
  echo "[ERROR] ${VEXLYX_HOME} already exists but is not a Vexlyx checkout." >&2
  echo "        Refusing to overwrite it. Set VEXLYX_HOME to a different path and re-run." >&2
  exit 1
else
  echo "[install.sh] Cloning Vexlyx into ${VEXLYX_HOME}..."
  if ! command -v git >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y --no-install-recommends git ca-certificates
  fi
  install -d -m 0755 "$(dirname "${VEXLYX_HOME}")"
  git clone --branch "${VEXLYX_REPO_REF}" --depth 1 "${VEXLYX_REPO_URL}" "${VEXLYX_HOME}"
  cd "${VEXLYX_HOME}"
fi

export VEXLYX_HOME
cd "${VEXLYX_HOME}"
exec bash system/scripts/install/run.sh "$@"
