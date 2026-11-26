#!/usr/bin/env bash
# Copies the project to a Docker host and brings it up there. Run from the laptop (Git Bash):
#
#   bash scripts/push-to-host.sh avro@192.168.5.46 home.env
#
# The state folder on the host (STATE_DIR in the env file - settings, results,
# the certificate) is outside the code folder and is never touched.
set -euo pipefail
TARGET="${1:?usage: push-to-host.sh user@host <env file>}"
ENVF="${2:?usage: push-to-host.sh user@host <env file>}"
KEY="${SSH_KEY:-$HOME/.ssh/nexus_lab}"
KH="${KNOWN_HOSTS:-$HOME/.ssh/known_hosts_uiload}"
SSH=(ssh -i "$KEY" -o UserKnownHostsFile="$KH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
cd "$(dirname "$0")/.."
[ -f "$ENVF" ] || { echo "no such env file: $ENVF" >&2; exit 1; }
tar -czf - --exclude=node_modules --exclude=data --exclude=state --exclude=.git . \
  | "${SSH[@]}" "$TARGET" 'rm -rf ~/sn-load-test && mkdir -p ~/sn-load-test && tar -xzf - -C ~/sn-load-test'
"${SSH[@]}" "$TARGET" "cd ~/sn-load-test && docker compose --env-file '$ENVF' up --build -d && docker compose --env-file '$ENVF' ps"
