#!/usr/bin/env bash
# Deploys the current working tree to the VM and restarts the service:
#   ./deploy/push.sh ubuntu@203.0.113.10
#
# Run it from the repo root. There is no git remote, so this rsyncs straight
# from your laptop — meaning whatever is in the working tree right now is what
# goes live. Commit first if you want the deploy to match a commit.
set -euo pipefail

HOST="${1:-${MEOW_HOST:-}}"
if [ -z "$HOST" ]; then
  echo "usage: ./deploy/push.sh <user>@<vm-host>   (or set MEOW_HOST)" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env in $(pwd) — refusing to deploy a bot with no credentials" >&2; exit 1; }

# `sudo rsync` on the far side means this works with the unprivileged default
# login that GCP and Oracle images give you, without enabling root ssh.
RSH=(--rsync-path="sudo rsync")

echo "==> syncing code to $HOST"
# data/ is excluded, never deleted: it holds the FDEs' live registrations, and
# a deploy must not log all of them out. rsync also leaves excluded paths alone
# when --delete is in play, so .env survives this pass and is sent separately.
rsync -az --delete "${RSH[@]}" \
  --exclude 'node_modules/' \
  --exclude '.git/' \
  --exclude '.claude/' \
  --exclude 'data/' \
  --exclude '*.log' \
  --exclude '.env' \
  ./ "$HOST:/opt/meow/"

# Permissions are fixed over ssh below rather than with rsync's --chmod: macOS
# ships openrsync, which rejects the F600/D700 syntax that needs rsync 3.x.
echo "==> syncing .env"
rsync -az "${RSH[@]}" .env "$HOST:/opt/meow/.env"

# Seeds the existing registrations the first time only. --ignore-existing means
# a later deploy can never overwrite the live file with a stale laptop copy.
if [ -f data/user-bolna-keys.json ]; then
  echo "==> seeding user keys (only if not already present on the vm)"
  rsync -az --ignore-existing "${RSH[@]}" \
    data/user-bolna-keys.json "$HOST:/opt/meow/data/"
fi

echo "==> installing deps and restarting"
ssh "$HOST" 'set -e
  sudo chown -R meow:meow /opt/meow
  sudo chmod 600 /opt/meow/.env
  sudo chmod 700 /opt/meow/data
  [ -f /opt/meow/data/user-bolna-keys.json ] && sudo chmod 600 /opt/meow/data/user-bolna-keys.json
  sudo -u meow npm --prefix /opt/meow install --omit=dev --no-audit --no-fund
  sudo systemctl restart meow
  sleep 4
  systemctl is-active --quiet meow && echo "==> meow is active" || { echo "==> meow FAILED to start"; sudo journalctl -u meow -n 40 --no-pager; exit 1; }
  sudo journalctl -u meow -n 15 --no-pager'
