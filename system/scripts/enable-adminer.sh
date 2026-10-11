#!/usr/bin/env bash
# Opts a production install in to Adminer at https://adminer.<VEXLYX_DOMAIN>,
# protected by Traefik basic auth. Run on the server: sudo bash enable-adminer.sh
# Pass --disable to turn it back off. Safe to re-run (rotates the password).
set -euo pipefail

VEXLYX_HOME="${VEXLYX_HOME:-/opt/vexlyx}"
SECRETS_FILE="${VEXLYX_SECRETS_FILE:-/etc/vexlyx/vexlyx.env}"
ADMINER_USER="${ADMINER_USER:-admin}"
COMPOSE=(docker compose --env-file "${SECRETS_FILE}" -f docker-compose.yml -f docker-compose.prod.yml)

[[ -f "${SECRETS_FILE}" ]] || { echo "Secrets file not found: ${SECRETS_FILE}" >&2; exit 1; }
[[ "${EUID}" -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }

strip_keys() {
  local tmp
  tmp="$(mktemp)"
  grep -v -E '^(ADMINER_URL|ADMINER_BASIC_AUTH)=' "${SECRETS_FILE}" > "${tmp}" || true
  cat "${tmp}" > "${SECRETS_FILE}"
  rm -f "${tmp}"
}

cd "${VEXLYX_HOME}"
domain="$(grep -E '^VEXLYX_DOMAIN=' "${SECRETS_FILE}" | cut -d= -f2-)"
[[ -n "${domain}" ]] || { echo "VEXLYX_DOMAIN missing from ${SECRETS_FILE}" >&2; exit 1; }

if [[ "${1:-}" == "--disable" ]]; then
  strip_keys
  "${COMPOSE[@]}" --profile adminer rm -sf adminer
  "${COMPOSE[@]}" up -d api
  echo "Adminer disabled."
  exit 0
fi

password="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
hash="$(openssl passwd -apr1 "${password}")"

strip_keys
# Single quotes keep Compose from interpolating the '$' inside the hash.
printf "ADMINER_BASIC_AUTH='%s:%s'\n" "${ADMINER_USER}" "${hash}" >> "${SECRETS_FILE}"
printf 'ADMINER_URL=https://adminer.%s\n' "${domain}" >> "${SECRETS_FILE}"

"${COMPOSE[@]}" --profile adminer up -d adminer
"${COMPOSE[@]}" up -d api

echo ""
echo "Adminer enabled: https://adminer.${domain}"
echo "  Basic auth user:     ${ADMINER_USER}"
echo "  Basic auth password: ${password}   (shown once — save it now)"
echo "Then sign in to Adminer with the database credentials shown in the panel."
