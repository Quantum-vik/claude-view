#!/bin/bash
OUT="$1"; N="$2"
for i in $(seq 1 $N); do
  ts=$(date +%s.%N)
  while read -r f; do
    printf "%s %s size=%s lines=%s last=%s\n" "$ts" "$(basename "$(dirname "$(dirname "$f")")")/$(basename "$f")" "$(stat -c%s "$f")" "$(wc -l < "$f")" "$(tail -1 "$f" | head -c 30)" >> "$OUT"
  done < <(find "$HOME/.claude/projects" -path "*/tool-results/*" -newermt "-3 minutes" 2>/dev/null)
  sleep 0.5
done
