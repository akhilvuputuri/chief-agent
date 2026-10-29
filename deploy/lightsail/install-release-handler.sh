#!/usr/bin/env bash
# Reviewed operator step: install the release handler from the deployed source
# tree, plus BuildKit for its fallback host build. Run as root on the host after
# the reviewed commit has been released (the release copies it to
# /opt/hermes-companion):
#   sudo /opt/hermes-companion/deploy/lightsail/install-release-handler.sh <sha256>
# <sha256> is scripts/cloud-release.py's SHA-256 at the reviewed commit.
set -euo pipefail
expected=${1:?usage: install-release-handler.sh <sha256 of scripts/cloud-release.py>}
[[ $expected =~ ^[0-9a-f]{64}$ ]] || { echo "Expected a 64-hex SHA-256" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Run as root" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
source="$here/../../scripts/cloud-release.py"
actual=$(sha256sum "$source" | cut -d' ' -f1)
[ "$actual" = "$expected" ] || { echo "cloud-release.py is $actual, expected $expected" >&2; exit 1; }
python3 -I -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$source"

# The handler is the deploy key's forced SSH command: replace it atomically.
install -m 755 -o root -g root "$source" /usr/local/sbin/companion-cloud-release.new
mv /usr/local/sbin/companion-cloud-release.new /usr/local/sbin/companion-cloud-release

# BuildKit for the fallback host build. Never change docker.io, containerd or
# runc here: upgrading them restarts the daemon, the gateway and Postgres.
if ! docker buildx version >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  plan=$(apt-get -s install --no-install-recommends docker-buildx)
  if grep -qE '^(Inst|Remv) (docker\.io|containerd|runc) ' <<<"$plan"; then
    echo "Installing docker-buildx would change docker.io, containerd or runc; do it in a maintenance window" >&2
    exit 1
  fi
  apt-get install -y -qq --no-install-recommends docker-buildx
fi
docker buildx version
sha256sum /usr/local/sbin/companion-cloud-release
