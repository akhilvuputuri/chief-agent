#!/usr/bin/env bash
# Copy only sanitized gateway operational lines from journald to a file the
# CloudWatch agent tails. The cursor file resumes after exporter or host
# restarts, so an outage delays lines instead of losing them (within journald
# retention). Anything that is not a chief.ops JSON line (for example a stray
# library warning) stays in the local journal only.
set -euo pipefail
install -d -m 750 /var/lib/chief /var/log/chief
journalctl --follow --output=cat --no-tail --cursor-file=/var/lib/chief/gateway.cursor \
  CONTAINER_NAME=hermes-companion-gateway-1 |
  grep --line-buffered '^{"schema":"chief\.ops/1",' >>/var/log/chief/gateway.jsonl
