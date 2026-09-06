#!/usr/bin/env bash
# Root on the server. Recipient certificate contains only a public encryption key.
set -euo pipefail
umask 077
cd /opt/hermes-companion
install -d -m 700 /var/backups/hermes-companion
exec 9>/var/lock/hermes-companion-backup.lock
flock -n 9 || exit 0
stamp=$(date -u +%Y%m%dT%H%M%SZ)
output="/var/backups/hermes-companion/database-${stamp}.dump.cms"
temporary=$(mktemp /var/backups/hermes-companion/.partial.XXXXXX)
trap 'rm -f "$temporary"' EXIT
docker compose exec -T postgres pg_dump -U companion -d companion -Fc |
  openssl cms -encrypt -binary -aes256 -outform DER -out "$temporary" /etc/hermes-backup-recipient.pem
mv "$temporary" "$output"
sha256sum "$output" > "${output}.sha256"
# Keep 14 days on the server. Off-server retention is independent.
find /var/backups/hermes-companion -name 'database-*.dump.cms*' -type f -mtime +14 -delete
printf 'Encrypted database backup completed: %s\n' "$output"
