#!/usr/bin/env bash
set -euo pipefail

VEXLYX_SECRETS_FILE="${VEXLYX_SECRETS_FILE:-/etc/vexlyx/vexlyx.env}"
if [[ ! -r "${VEXLYX_SECRETS_FILE}" ]]; then
  echo "Vexlyx environment file is not readable: ${VEXLYX_SECRETS_FILE}" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "${VEXLYX_SECRETS_FILE}"
set +a

VEXLYX_HOME="${VEXLYX_HOME:-/opt/vexlyx}"
cd "${VEXLYX_HOME}"

result="$(python3 system/python/mail_tls_manager.py \
  --acme docker/traefik/acme.json \
  --output docker/mail-data/certs \
  --hostname "${VEXLYX_MAIL_HOSTNAME}")"

if [[ "${result}" == *'"changed": true'* ]]; then
  docker compose --env-file "${VEXLYX_SECRETS_FILE}" \
    -f docker-compose.yml -f docker-compose.prod.yml \
    restart postfix dovecot
  echo "Updated Postfix and Dovecot TLS certificate for ${VEXLYX_MAIL_HOSTNAME}."
else
  echo "Mail TLS certificate is already current for ${VEXLYX_MAIL_HOSTNAME}."
fi
