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
VEXLYX_REPO_URL="${VEXLYX_REPO_URL:-https://github.com/atlantiqs-org/vexlyx.git}"
VEXLYX_REPO_REF="${VEXLYX_REPO_REF:-main}"

if [[ ${EUID} -ne 0 ]]; then
  echo "[ERROR] This installer must be run as root (or with sudo)." >&2
  exit 1
fi

is_vexlyx_checkout() {
  [[ -f "$1/CLAUDE.md" && -f "$1/system/scripts/install/run.sh" ]]
}

prepare_mail_upgrade() {
  local migration_script state_dir status_line
  local runtime_files=(
    docker/postfix/config/virtual_domains docker/postfix/config/virtual_mailbox_maps
    docker/postfix/config/virtual_alias_maps docker/dovecot/config/users
    docker/postfix/opendkim/KeyTable docker/postfix/opendkim/SigningTable
    docker/postfix/opendkim/TrustedHosts
  )
  git diff --cached --quiet || { echo "[ERROR] Staged source changes must be preserved before upgrading." >&2; exit 1; }
  while IFS= read -r status_line; do
    case "${status_line:3}" in
      docker/postfix/config/virtual_domains|docker/postfix/config/virtual_mailbox_maps|docker/postfix/config/virtual_alias_maps|docker/dovecot/config/users|docker/postfix/opendkim/KeyTable|docker/postfix/opendkim/SigningTable|docker/postfix/opendkim/TrustedHosts) ;;
      *) echo "[ERROR] Source changes detected; upgrade stopped without discarding them: ${status_line:3}" >&2; exit 1;;
    esac
  done < <(git status --porcelain)
  if ! git cat-file -e FETCH_HEAD:system/python/mail_state_migrate.py 2>/dev/null; then
    [[ -z "$(git status --porcelain)" ]] || { echo "[ERROR] Target revision has no mail-state migration. Preserve generated maps before upgrading." >&2; exit 1; }
    return
  fi
  if [[ -z "$(git ls-files -- "${runtime_files[@]}")" ]]; then return; fi
  state_dir="${VEXLYX_MAIL_STATE_DIR:-}"
  if [[ -z "$state_dir" && -f /etc/vexlyx/vexlyx.env ]]; then
    state_dir="$(sed -n 's/^VEXLYX_MAIL_STATE_DIR=//p' /etc/vexlyx/vexlyx.env | tail -n 1)"
  fi
  state_dir="${state_dir:-/var/lib/vexlyx/mail}"
  command -v python3 >/dev/null || { echo "[ERROR] Python 3 is required to preserve legacy mail state before upgrading." >&2; exit 1; }
  if [[ -f /etc/vexlyx/vexlyx.env ]]; then
    docker compose --env-file /etc/vexlyx/vexlyx.env -f docker-compose.yml -f docker-compose.prod.yml stop api
  fi
  migration_script="$(mktemp)"
  git show FETCH_HEAD:system/python/mail_state_migrate.py > "$migration_script"
  python3 "$migration_script" --source "${VEXLYX_HOME}" --state-root "$state_dir"
  rm -f "$migration_script"
  # Only verified, backed-up generated files are reset; unrelated source changes were rejected above.
  local file
  for file in "${runtime_files[@]}"; do
    if git ls-files --error-unmatch "$file" >/dev/null 2>&1; then git restore --worktree -- "$file"; fi
  done
}

if is_vexlyx_checkout "$(pwd)"; then
  # Already running from inside a Vexlyx checkout — use it as-is.
  VEXLYX_HOME="$(pwd)"
elif is_vexlyx_checkout "${VEXLYX_HOME}"; then
  echo "[install.sh] Found existing Vexlyx checkout at ${VEXLYX_HOME}."
  cd "${VEXLYX_HOME}"
  if [[ -d .git ]]; then
    echo "[install.sh] Updating to the latest ${VEXLYX_REPO_REF}..."
    git fetch origin "${VEXLYX_REPO_REF}"
    prepare_mail_upgrade
    git checkout "${VEXLYX_REPO_REF}"
    git pull --ff-only origin "${VEXLYX_REPO_REF}"
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
