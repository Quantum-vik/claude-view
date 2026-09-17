#!/bin/bash
SLUG="$1"; OUT="$2"; N="$3"
for i in $(seq 1 $N); do
  ts=$(date +%s.%N)
  while read -r f; do
    [ -f "$f" ] || continue
    printf "%s %s size=%s lines=%s last=%q\n" "$ts" "$(basename "$f")" "$(stat -c%s "$f")" "$(wc -l < "$f")" "$(tail -1 "$f")" >> "$OUT"
  done < <(find "$SLUG" -path "*/tasks/*.output" 2>/dev/null)
  sleep 0.5
done
