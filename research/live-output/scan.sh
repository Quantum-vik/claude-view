#!/bin/bash
# Hunt for a fourth source: any file on disk holding partial tool output while it runs.
MARK="$1"; OUT="$2"; DUR="$3"
t0=$(date +%s.%N)
end=$(( $(date +%s) + DUR ))
while [ "$(date +%s)" -lt "$end" ]; do
  now=$(echo "$(date +%s.%N) - $t0" | bc)
  hits=$(timeout 8 grep -rlI --exclude-dir=node_modules "$MARK" "$HOME/.claude" /tmp /dev/shm /run/user/1000 2>/dev/null | head -20)
  if [ -n "$hits" ]; then
    echo "[$now] DISK HITS:" >> "$OUT"
    echo "$hits" | sed 's/^/    /' >> "$OUT"
  fi
  # fds of every claude-spawned process
  for p in $(pgrep -f "sleep 1" 2>/dev/null); do
    ppid=$(ps -o ppid= -p $p 2>/dev/null | tr -d ' ')
    echo "[$now] sleeper pid=$p ppid=$ppid ppcmd=$(ps -o args= -p $ppid 2>/dev/null | head -c 120)" >> "$OUT"
    echo "[$now]   fds(ppid): $(ls -l /proc/$ppid/fd 2>/dev/null | awk '{print $9\"->\"$11}' | tr '\n' ' ')" >> "$OUT"
  done
  sleep 1
done
