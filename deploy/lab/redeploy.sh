#!/usr/bin/env bash
# Copies the project to the lab host and installs it there. Run on the laptop (Git Bash):
#
#   bash deploy/lab/redeploy.sh [user@host]      default avro@192.168.5.46 (CT 9340 "uiload")
#
# The data folder on the host (~/uiload-data) is never touched.
set -euo pipefail
TARGET="${1:-avro@192.168.5.46}"
KEY="${SSH_KEY:-$HOME/.ssh/nexus_lab}"
KH="${KNOWN_HOSTS:-$HOME/.ssh/known_hosts_uiload}"
SSH=(ssh -i "$KEY" -o UserKnownHostsFile="$KH" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
cd "$(dirname "$0")/../.."
tar -czf - --exclude=node_modules --exclude=data --exclude=.git . | "${SSH[@]}" "$TARGET" 'rm -rf ~/uiload && mkdir -p ~/uiload && tar -xzf - -C ~/uiload'
"${SSH[@]}" "$TARGET" 'bash ~/uiload/deploy/lab/install.sh'
