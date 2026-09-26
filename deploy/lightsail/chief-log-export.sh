#!/usr/bin/env bash
# Copy only sanitized gateway operational lines from journald to a file the
# CloudWatch agent tails. Anything that is not a chief.ops JSON line (for
# example a stray library warning) stays in the local journal only.
#
# Polls instead of `journalctl --follow`: on systemd 255, --follow with
# --cursor-file skips entries from the previous boot (a gateway.stopping line
# written during shutdown was never exported). Each pass reads after the saved
# cursor using a working copy, and the copy replaces the saved cursor only when
# journalctl succeeded and grep wrote its lines, so a failed write is retried
# rather than skipped; a crash mid-pass replays that pass.
set -uo pipefail
install -d -m 750 /var/lib/chief /var/log/chief
cursor=/var/lib/chief/gateway.cursor
work=/var/lib/chief/gateway.cursor.pass
out=/var/log/chief/gateway.jsonl
failures=0
while true; do
  rm -f "$work"
  [ -f "$cursor" ] && cp "$cursor" "$work"
  journalctl --output=cat --cursor-file="$work" CONTAINER_NAME=hermes-companion-gateway-1 |
    grep '^{"schema":"chief\.ops/1",' >>"$out"
  status=("${PIPESTATUS[@]}")
  # grep: 0 = lines written, 1 = none matched, 2 = error (for example disk full).
  if [ "${status[0]}" -eq 0 ] && [ "${status[1]}" -le 1 ]; then
    [ -f "$work" ] && mv "$work" "$cursor"
    failures=0
  else
    failures=$((failures + 1))
    echo "export pass failed: journalctl=${status[0]} grep=${status[1]}" >&2
    # Surface a persistent failure as service restarts instead of a silent stall.
    [ "$failures" -ge 12 ] && exit 1
  fi
  sleep 5
done
