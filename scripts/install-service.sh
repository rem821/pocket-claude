#!/usr/bin/env bash
# Install pocket-claude as a systemd *user* service on this machine.
#
# A user service (rather than system-wide) is deliberate: pocket-claude has to run
# as you, because it reuses your Claude Code login and your ~/.claude transcripts.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAME="pocket-claude.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TEMPLATE="$REPO_DIR/systemd/pocket-claude.service.template"

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

command -v systemctl >/dev/null 2>&1 || die "systemctl not found — this script is for systemd machines."
[ -f "$TEMPLATE" ] || die "missing $TEMPLATE"
[ -f "$REPO_DIR/.env" ] || die "no .env yet. Copy .env.example to .env and fill it in first."
[ -f "$REPO_DIR/dist/server.js" ] || die "not built yet. Run: npm install && npm run build"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || die "node not found on PATH. Install Node 22+, or set NODE_BIN."

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  die "node $NODE_MAJOR found at $NODE_BIN, but 22+ is required."
fi

# The service gets a minimal PATH, so pass through a useful one. node's own
# directory is included so the claude binary next to it is reachable too.
SERVICE_PATH="$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

mkdir -p "$UNIT_DIR"
sed \
  -e "s|__NODE__|$NODE_BIN|g" \
  -e "s|__DIR__|$REPO_DIR|g" \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__PATH__|$SERVICE_PATH|g" \
  "$TEMPLATE" > "$UNIT_DIR/$UNIT_NAME"

printf 'wrote %s\n' "$UNIT_DIR/$UNIT_NAME"
printf '  node: %s\n  repo: %s\n' "$NODE_BIN" "$REPO_DIR"

# Without lingering, a user service only runs while you have a login session —
# so it would not come back after a reboot until you logged in.
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != "yes" ]; then
  printf '\nenabling lingering so the service starts at boot without a login…\n'
  loginctl enable-linger "$USER" || printf 'could not enable lingering; you may need: sudo loginctl enable-linger %s\n' "$USER"
fi

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"

printf '\n'
systemctl --user --no-pager --lines=0 status "$UNIT_NAME" || true
printf '\nlogs:  journalctl --user -u pocket-claude -f\n'

HOST_LINE="$(grep -E '^HOST=' "$REPO_DIR/.env" | tail -1 | cut -d= -f2- || true)"
PORT_LINE="$(grep -E '^PORT=' "$REPO_DIR/.env" | tail -1 | cut -d= -f2- || echo 7420)"
if [ "$HOST_LINE" = "auto" ] && command -v tailscale >/dev/null 2>&1; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  [ -n "$TS_IP" ] && printf 'open:  http://%s:%s\n' "$TS_IP" "${PORT_LINE:-7420}"
else
  printf 'open:  http://%s:%s\n' "${HOST_LINE:-127.0.0.1}" "${PORT_LINE:-7420}"
fi
