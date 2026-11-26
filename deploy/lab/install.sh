#!/usr/bin/env bash
# Installs or updates the app on a plain Ubuntu 24.04 host (the home-lab container),
# as a systemd service. No Docker. Run on the host, from the unpacked project:
#
#   bash deploy/lab/install.sh
#
# Needs sudo without a password. Safe to run again: it replaces the code and
# keeps the data folder (settings, scenarios, runs) in ~/uiload-data.
set -euo pipefail
NODE_VERSION=v22.23.5          # an LTS release more than 72 hours old; move it deliberately
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_USER="$(id -un)"
DATA_DIR="$HOME/uiload-data"

echo "== packages"
sudo -n apt-get update -qq
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl xz-utils >/dev/null

if [ "$(/usr/local/bin/node -v 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  echo "== node $NODE_VERSION"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  f="node-$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "$tmp/$f" "https://nodejs.org/dist/$NODE_VERSION/$f"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep " $f\$" SHASUMS256.txt | sha256sum -c -)
  sudo -n rm -rf "/opt/node-$NODE_VERSION"
  sudo -n mkdir -p "/opt/node-$NODE_VERSION"
  sudo -n tar -xJf "$tmp/$f" -C "/opt/node-$NODE_VERSION" --strip-components=1
  for b in node npm npx; do sudo -n ln -sf "/opt/node-$NODE_VERSION/bin/$b" "/usr/local/bin/$b"; done
fi
node -v

echo "== app packages (72-hour gate first)"
cd "$APP_DIR"
node scripts/check-release-age.js --offline
npm ci --no-audit --no-fund --silent

echo "== browser"
# Playwright's own Chromium, the build that belongs to the pinned playwright-core.
sudo -n env PATH="$PATH" npx playwright-core install-deps chromium >/dev/null
npx playwright-core install chromium

echo "== service"
mkdir -p "$DATA_DIR"; chmod 700 "$DATA_DIR"
sed -e "s#@USER@#$RUN_USER#g" -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@DATA_DIR@#$DATA_DIR#g" deploy/lab/uiload.service | sudo -n tee /etc/systemd/system/uiload.service >/dev/null
sudo -n systemctl daemon-reload
sudo -n systemctl enable -q uiload
sudo -n systemctl restart uiload
sleep 2
systemctl is-active uiload
curl -fsS -o /dev/null -w "app answers: HTTP %{http_code}\n" http://127.0.0.1:8787/
