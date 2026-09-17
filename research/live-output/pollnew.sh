#!/bin/bash
OUT="$1"; N="$2"
D="$HOME/.claude/projects/-home-quantumvik-WorkPersonal-claude-view"
for i in $(seq 1 $N); do
  ts=$(date +%s.%N)
  for f in $(find "$D" -maxdepth 1 -name "*.jsonl" -newermt "-4 minutes" 2>/dev/null); do
    printf "%s %s size=%s\n" "$ts" "$(basename $f)" "$(stat -c%s $f)" >> "$OUT"
  done
  sleep 0.5
done
