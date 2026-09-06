#!/usr/bin/env bash
# Run as root on a fresh Ubuntu 24.04 server. No application secrets belong here.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
cloud-init status --wait
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 ufw fail2ban unattended-upgrades
systemctl enable --now docker fail2ban
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/00-hermes.conf
sshd -t
systemctl reload ssh
install -d -m 700 /opt/hermes-companion
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi
docker compose version
ufw status
