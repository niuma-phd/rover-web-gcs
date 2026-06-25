#!/usr/bin/env bash
# Launch ArduPilot Rover SITL (the REAL firmware) headless and forward MAVLink to the GCS.
#
# Prereqs (one-time, see README §SITL):
#   - ardupilot cloned + Rover built:  ./waf configure --board sitl && ./waf rover
#   - a python venv with: pymavlink MAVProxy empy==3.3.4 future
#
# Layout assumed (override with env vars):
#   AP_DIR   ardupilot checkout            (default: ../../ardupilot from this script)
#   VENV_DIR python venv with the deps     (default: ../../apvenv)
#
# Usage:  scripts/run-sitl.sh [LAT] [LON]
#   then in the GCS connect via "UDP / listen 14550".
set -e
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AP_DIR="${AP_DIR:-$(cd "$HERE/../.." && pwd)/ardupilot}"
VENV_DIR="${VENV_DIR:-$(cd "$HERE/../.." && pwd)/apvenv}"
LAT="${1:-22.5900}"; LON="${2:-113.9500}"; ALT=5; HDG=0

[ -x "$AP_DIR/build/sitl/bin/ardurover" ] || { echo "ardurover not built at $AP_DIR/build/sitl/bin/ — build it first (see README §SITL)"; exit 1; }
[ -f "$VENV_DIR/bin/activate" ] && source "$VENV_DIR/bin/activate"
cd "$AP_DIR"

# IMPORTANT: do NOT add an explicit --out=udp:127.0.0.1:14550 — sim_vehicle.py already
# adds a default GCS output on 14550. A second one duplicates the stream (two MAVProxy
# source ports -> our UDP socket flip-flops) and breaks the multi-round MISSION upload.
exec python3 Tools/autotest/sim_vehicle.py \
  -v Rover -f rover \
  --no-rebuild \
  --custom-location="${LAT},${LON},${ALT},${HDG}" \
  --mavproxy-args="--daemon"
