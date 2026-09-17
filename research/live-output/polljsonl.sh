#!/bin/bash
F="$1"; OUT="$2"; N="$3"
prev=0
for i in $(seq 1 $N); do
  if [ -f "$F" ]; then
    sz=$(stat -c%s "$F")
    if [ "$sz" != "$prev" ]; then
      ts=$(date +%s.%N)
      tail -c +$((prev+1)) "$F" | while IFS= read -r l; do
        echo "$ts $(echo "$l" | python3 -c 'import json,sys
try:
  v=json.load(sys.stdin)
except Exception as e:
  print("UNPARSED"); raise SystemExit
t=v.get("type"); msg=v.get("message") or {}
c=msg.get("content")
kinds=[]
if isinstance(c,list):
  for b in c:
    k=b.get("type")
    if k=="tool_use": kinds.append("tool_use:"+b.get("name","?")+":"+b.get("id","")[:12])
    elif k=="tool_result": kinds.append("tool_result:"+str(b.get("tool_use_id",""))[:12]+":len="+str(len(str(b.get("content","")))))
    else: kinds.append(k)
print(t, v.get("timestamp",""), ",".join(kinds))' )" >> "$OUT"
      done
      prev=$sz
    fi
  fi
  sleep 0.2
done
