#!/usr/bin/env bash
# Copy only sanitized gateway operational lines from journald to a file the
# CloudWatch agent tails. Anything that is not a chief.ops JSON line (for
# example a stray library warning) stays in the local journal only.
#
# Polls instead of `journalctl --follow`: on systemd 255, --follow with
# --cursor-file skips entries from the previous boot (a gateway.stopping line
# written during shutdown was never exported). Without --follow, journalctl
# resumes exactly after the saved cursor and rewrites it after every pass, so a
# crash replays at most one poll interval.
set -uo pipefail
install -d -m 750 /var/lib/chief /var/log/chief
cursor=/var/lib/chief/gateway.cursor
out=/var/log/chief/gateway.jsonl
while true; do
  journalctl --output=cat --cursor-file="$cursor" CONTAINER_NAME=hermes-companion-gateway-1 |
    grep '^{"schema":"chief\.ops/1",' >>"$out"
  # grep exits 1 when a pass has no new lines; only a journalctl failure matters.
  [ "${PIPESTATUS[0]}" -eq 0 ] || echo "journalctl pass failed" >&2
  sleep 5
done
