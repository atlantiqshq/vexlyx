#!/usr/bin/env bash
# Brings up every remaining service: Traefik (requests the panel's Let's
# Encrypt certificate on first start), CoreDNS, Postfix, Dovecot, Roundcube,
# and the panel itself (dashboard + api). `up -d` with no service names
# reconciles the whole stack — postgres/mysql/redis (already started in step
# 11) are left untouched since their config hasn't changed.
set -euo pipefail

log_step "[14/16] Starting all services"

install -d -m 0755 \
  "${VEXLYX_HOME}/apps/api/workspaces/projects" \
  "${VEXLYX_HOME}/apps/api/workspaces/keys"

COMPOSE=(docker compose --env-file "${VEXLYX_SECRETS_FILE}" -f docker-compose.yml -f docker-compose.prod.yml)

"${COMPOSE[@]}" up -d

log_info "Waiting for the panel API to respond..."
tries=30
until "${COMPOSE[@]}" exec -T api curl -fsS http://localhost:5000/api/health >/dev/null 2>&1 || (( tries == 0 )); do
  sleep 2
  (( tries-- ))
done

if "${COMPOSE[@]}" ps --status running --services | grep -qx api; then
  log_ok "All services started."
else
  log_warn "The api container is not running — check: docker compose -f docker-compose.yml -f docker-compose.prod.yml logs api"
fi

install -m 0755 system/scripts/install/sync-mail-tls.sh /usr/local/sbin/vexlyx-sync-mail-tls
cat > /etc/systemd/system/vexlyx-mail-tls.service <<EOF
[Unit]
Description=Synchronize Vexlyx mail TLS certificate from Traefik
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Environment=VEXLYX_SECRETS_FILE=${VEXLYX_SECRETS_FILE}
ExecStart=/usr/local/sbin/vexlyx-sync-mail-tls
EOF
cat > /etc/systemd/system/vexlyx-mail-tls.timer <<'EOF'
[Unit]
Description=Renew Vexlyx mail TLS certificate

[Timer]
OnBootSec=5min
OnUnitActiveSec=12h
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now vexlyx-mail-tls.timer

log_info "Waiting for the trusted mail certificate for ${VEXLYX_MAIL_HOSTNAME}..."
mail_cert_tries=30
until bash system/scripts/install/sync-mail-tls.sh >/dev/null 2>&1 || (( mail_cert_tries == 0 )); do
  sleep 2
  (( mail_cert_tries-- ))
done

if bash system/scripts/install/sync-mail-tls.sh; then
  log_ok "Trusted mail TLS certificate installed; automatic renewal enabled."
else
  log_warn "A trusted certificate for ${VEXLYX_MAIL_HOSTNAME} is not available yet."
  log_warn "Automatic retries are enabled. After correcting DNS, run: /usr/local/sbin/vexlyx-sync-mail-tls"
fi
