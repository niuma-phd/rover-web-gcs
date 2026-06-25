#!/usr/bin/env bash
# Stop the demo stack (SITL + bridge). Safe to run from any shell: the kill
# patterns live inside this script file, so they never match the launching
# shell's own command line (which is just the script path).
echo "stopping web GCS bridge ..."; pkill -f "bridge/server.js" 2>/dev/null || true
echo "stopping MAVProxy ...";       pkill -f "mavproxy.py" 2>/dev/null || true
echo "stopping sim_vehicle ...";    pkill -f "sim_vehicle.py" 2>/dev/null || true
echo "stopping ardurover ...";      pkill -x ardurover 2>/dev/null || true
sleep 1
if pgrep -x ardurover >/dev/null || ss -ltn 2>/dev/null | grep -qE ':(8097|8080) '; then
  echo "warning: some processes may still be up:"; pgrep -af "ardurover|sim_vehicle.py|mavproxy.py|bridge/server.js" | grep -v stop-all || true
else
  echo "all stopped."
fi
