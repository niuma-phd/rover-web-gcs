#!/usr/bin/env bash
# Bring up the whole demo stack on this machine:
#   1) ArduPilot Rover SITL (real firmware) -> forwards MAVLink to UDP 14550
#   2) the web GCS bridge + UI               -> http://<this-host>:PORT
# Then print the URLs to open from a browser (this box is typically headless, so
# open the page from your laptop over Tailscale/LAN).
#
# Usage:  scripts/start-all.sh [LAT] [LON]
#   env:  PORT (default 8097), SIM_LAT/SIM_LON via args
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-8097}"
LAT="${1:-22.5900}"; LON="${2:-113.9500}"
mkdir -p "$REPO/logs"

echo "[1/2] starting ArduPilot Rover SITL (real firmware) at ${LAT},${LON} ..."
if pgrep -x ardurover >/dev/null; then
  echo "      SITL already running (skip)."
else
  setsid nohup "$HERE/run-sitl.sh" "$LAT" "$LON" > "$REPO/logs/sitl.log" 2>&1 < /dev/null &
  for i in $(seq 1 60); do grep -q "ArduPilot Ready" "$REPO/logs/sitl.log" 2>/dev/null && break; sleep 1; done
  grep -q "ArduPilot Ready" "$REPO/logs/sitl.log" 2>/dev/null && echo "      SITL ready." || { echo "      SITL did not report ready — see logs/sitl.log"; }
fi

echo "[2/2] starting web GCS bridge on :$PORT ..."
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then
  echo "      something already listening on :$PORT (skip)."
else
  PORT="$PORT" setsid nohup node "$REPO/bridge/server.js" > "$REPO/logs/bridge.log" 2>&1 < /dev/null &
  for i in $(seq 1 15); do ss -ltn 2>/dev/null | grep -q ":$PORT " && break; sleep 1; done
fi

echo
echo "==================== DEMO READY ===================="
echo "  Open the GCS in a browser, then connect via: UDP / listen 14550"
echo "    local      : http://localhost:$PORT"
TS_IP="$(command -v tailscale >/dev/null && tailscale ip -4 2>/dev/null | head -1 || true)"
[ -n "$TS_IP" ] && echo "    Tailscale  : http://$TS_IP:$PORT"
LAN_IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(10|192\.168|172\.1[6-9]|172\.2[0-9]|172\.3[01])\.' | head -1 || true)"
[ -n "$LAN_IP" ] && echo "    LAN        : http://$LAN_IP:$PORT"
echo "    SSH tunnel : ssh -L $PORT:localhost:$PORT <user>@<this-host>  then http://localhost:$PORT"
echo "===================================================="
echo "  logs: logs/sitl.log  logs/bridge.log     stop: scripts/stop-all.sh"
