#!/usr/bin/env bash
# Reviewed operator procedure for the Lightsail production host. Run as root
# from the release source tree (/opt/hermes-companion or a staged copy):
#   sudo CWAGENT_VERSION=<version> deploy/lightsail/install-host.sh
# It installs host services only. It does not start the gateway, write
# application secrets, create AWS identities or change DNS/Telegram/Google.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
here=$(cd "$(dirname "$0")" && pwd)
: "${CWAGENT_VERSION:?Set CWAGENT_VERSION to a pinned CloudWatch agent version}"
[[ $CWAGENT_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9a-z]+$ ]] || { echo "Invalid CWAGENT_VERSION" >&2; exit 1; }

# Base host: Docker, Compose, firewall, fail2ban, SSH hardening, swap. Only on
# first install: re-running apt-get install could upgrade docker.io and restart
# the daemon (and with it the gateway and Postgres) on a live host.
if ! command -v docker >/dev/null 2>&1; then
  bash "$here/../bootstrap.sh"
fi
apt-get install -y -qq caddy gnupg python3 logrotate
ufw allow 80/tcp comment 'Companion HTTPS certificate and redirect'
ufw allow 443/tcp comment 'Companion Mini App HTTPS'

# HTTPS ingress: exact informational routes plus the Mini App proxy only.
install -d -m 755 /var/www/companion-oauth
install -m 644 "$here/../../ops/oauth-site/index.html" "$here/../../ops/oauth-site/privacy.html" "$here/../../ops/oauth-site/terms.html" /var/www/companion-oauth/
install -m 644 "$here/../../ops/oauth-site/Caddyfile" /etc/caddy/Caddyfile.chief
caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile.chief
mv /etc/caddy/Caddyfile.chief /etc/caddy/Caddyfile
systemctl enable caddy
systemctl reload-or-restart caddy

# Container output goes to a bounded persistent journal. Restart journald or
# Docker only when their configuration actually changed: this script is safe to
# re-run on a live host (for example to upgrade the agent) without restarting
# the gateway or Postgres. A Docker config change on a live host refuses to run.
changed() { ! cmp -s "$1" "$2"; }
if changed "$here/journald-chief.conf" /etc/systemd/journald.conf.d/chief.conf; then
  install -D -m 644 "$here/journald-chief.conf" /etc/systemd/journald.conf.d/chief.conf
  systemctl restart systemd-journald
fi
if changed "$here/docker-daemon.json" /etc/docker/daemon.json; then
  if [ -n "$(docker ps -q 2>/dev/null)" ]; then
    echo "Docker daemon.json differs but containers are running; stop the gateway in a maintenance window and re-run." >&2
    exit 1
  fi
  install -D -m 644 "$here/docker-daemon.json" /etc/docker/daemon.json
  systemctl restart docker
fi

# Export and host-health producers.
install -m 755 "$here/chief-log-export.sh" /usr/local/sbin/chief-log-export
install -m 755 "$here/chief-host-health.py" /usr/local/sbin/chief-host-health
install -m 644 "$here/chief-log-export.service" "$here/chief-host-health.service" "$here/chief-host-health.timer" /etc/systemd/system/
install -m 644 "$here/logrotate-chief" /etc/logrotate.d/chief
install -d -m 750 /var/log/chief /var/lib/chief
systemctl daemon-reload
systemctl enable --now chief-log-export.service chief-host-health.timer
systemctl try-restart chief-log-export.service

# CloudWatch agent: pinned version, AWS signature and key fingerprint verified.
if ! dpkg-query -W -f='${Version}' amazon-cloudwatch-agent 2>/dev/null | grep -qF "$CWAGENT_VERSION"; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  base="https://amazoncloudwatch-agent.s3.amazonaws.com"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$work/key.gpg" "$base/assets/amazon-cloudwatch-agent.gpg"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$work/agent.deb" "$base/ubuntu/amd64/$CWAGENT_VERSION/amazon-cloudwatch-agent.deb"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$work/agent.deb.sig" "$base/ubuntu/amd64/$CWAGENT_VERSION/amazon-cloudwatch-agent.deb.sig"
  export GNUPGHOME="$work/gnupg"
  install -d -m 700 "$GNUPGHOME"
  gpg --quiet --import "$work/key.gpg"
  gpg --with-colons --fingerprint 3B789C72 | grep -q '^fpr:::::::::937616F3450B7D806CBD9725D58167303B789C72:$' ||
    { echo "CloudWatch agent key fingerprint mismatch" >&2; exit 1; }
  # Require a valid signature made by the pinned key, not any imported key.
  # Capture all status output first; grep -q on a live pipe can SIGPIPE gpg under pipefail.
  status=$(gpg --status-fd 1 --verify "$work/agent.deb.sig" "$work/agent.deb" 2>/dev/null) ||
    { echo "CloudWatch agent package signature did not verify" >&2; exit 1; }
  grep -q '^\[GNUPG:\] VALIDSIG 937616F3450B7D806CBD9725D58167303B789C72 ' <<<"$status" ||
    { echo "CloudWatch agent package signature not made by the pinned AWS key" >&2; exit 1; }
  dpkg -i "$work/agent.deb"
fi
install -m 644 "$here/common-config.toml" /opt/aws/amazon-cloudwatch-agent/etc/common-config.toml
install -m 644 "$here/cloudwatch-agent.json" /opt/aws/amazon-cloudwatch-agent/etc/chief.json
# The agent's on-premises config translator needs the profile's region.
install -d -m 700 /root/.aws
printf '[profile AmazonCloudWatchAgent]\nregion = ap-southeast-1\n' > /root/.aws/config
chmod 600 /root/.aws/config
if [ -s /root/.aws/credentials ]; then
  /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m onPremise -s \
    -c file:/opt/aws/amazon-cloudwatch-agent/etc/chief.json
else
  echo "Publisher credentials not installed yet; CloudWatch agent configured but not started."
fi

# Nightly encrypted database backup (recipient certificate is copied separately).
install -m 644 "$here/../hermes-backup.service" "$here/../hermes-backup.timer" /etc/systemd/system/
systemctl daemon-reload
if [ -s /etc/hermes-backup-recipient.pem ]; then
  systemctl enable --now hermes-backup.timer
else
  echo "Backup recipient certificate missing; hermes-backup.timer not enabled."
fi

dpkg-query -W -f='${Package} ${Version}\n' docker.io docker-compose-v2 caddy amazon-cloudwatch-agent
systemctl is-active docker caddy chief-log-export chief-host-health.timer
