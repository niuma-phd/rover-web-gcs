#!/usr/bin/env bash
# One-click: set the whole-site password for the online demo.
# Writes ./.site-auth (gitignored). The bridge enforces Basic Auth only when this exists.
#
#   bash scripts/set-site-auth.sh <user> <password>
#   bash scripts/set-site-auth.sh demo                 # random strong password, printed once
#
# Restart the bridge after changing this for it to take effect.
set -euo pipefail
cd "$(dirname "$0")/.."

user="${1:-demo}"
pass="${2:-}"
if [ -z "$pass" ]; then
  pass="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-22)"
  echo "generated password for user '$user':"
  echo "    $pass"
  echo "(save it now — it is not shown again)"
fi

# basic sanity: no colon in user (colon separates user:pass)
case "$user" in *:*) echo "error: username must not contain ':'" >&2; exit 1;; esac

umask 077
printf '%s:%s' "$user" "$pass" > .site-auth
echo "wrote .site-auth  (user='$user', $(wc -c < .site-auth | tr -d ' ') bytes)"
echo "now (re)start the bridge:  PORT=8097 node bridge/server.js"
