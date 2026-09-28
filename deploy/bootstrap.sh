#!/usr/bin/env bash
# Run this ONCE on a fresh VM, as a user with sudo:
#   scp deploy/bootstrap.sh deploy/meow.service <vm>:~ && ssh <vm> 'sudo bash bootstrap.sh'
#
# It only prepares the box (node, service account, directories, systemd unit).
# The code and secrets arrive separately via deploy/push.sh, so that nothing
# secret ever has to be pasted into a VM console. Safe to re-run.
set -euo pipefail

APP_DIR=/opt/meow
SERVICE_USER=meow
NODE_MAJOR=22 # package.json requires >=20; 22 is the current LTS

echo "==> installing node ${NODE_MAJOR}"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  # NodeSource picks the right build for x86_64 (GCP e2-micro) and aarch64
  # (Oracle Ampere) on its own, so this works on either free tier.
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node --version

echo "==> creating service user and directories"
# A dedicated no-login system user: if the box is ever compromised through
# something else, that account still can't read the FDEs' Bolna keys.
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$APP_DIR/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
chmod 700 "$APP_DIR/data"

echo "==> installing systemd unit"
install -m 644 "$(dirname "$0")/meow.service" /etc/systemd/system/meow.service
systemctl daemon-reload
systemctl enable meow

echo
echo "box is ready. it is NOT started yet — there is no code or .env on it."
echo "next, from your laptop:  ./deploy/push.sh <user>@<vm-ip>"
