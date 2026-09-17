#!/usr/bin/env python3
"""For every Task/Agent tool call in a parent transcript, print the tool_use id,
the toolUseResult KEY SET (not values), and any token-ish fields it carries."""
import json, sys, os
H = os.path.expanduser("~")
path = sys.argv[1]
task_ids = {}
for line in open(path, encoding="utf-8", errors="replace"):
    line=line.strip()
    if not line: continue
    try: v=json.loads(line)
    except Exception: continue
    for b in ((v.get("message") or {}).get("content") or []):
        if isinstance(b,dict) and b.get("type")=="tool_use" and b.get("name") in ("Task","Agent"):
            task_ids[b["id"]] = (b.get("input") or {}).get("subagent_type")
    for b in ((v.get("message") or {}).get("content") or []):
        if isinstance(b,dict) and b.get("type")=="tool_result" and b.get("tool_use_id") in task_ids:
            tur = v.get("toolUseResult")
            keys = sorted(tur.keys()) if isinstance(tur,dict) else type(tur).__name__
            print(f"tool_use_id={b['tool_use_id']} subagent_type={task_ids[b['tool_use_id']]}")
            print(f"   toolUseResult keys: {keys}")
            if isinstance(tur,dict):
                for k in ("agentId","status","isAsync","totalTokens","totalDurationMs",
                          "totalToolUseCount","usage","modelUsage","resolvedModel"):
                    if k in tur:
                        val = tur[k]
                        if isinstance(val,str): val = val.replace(H,"~")
                        print(f"   {k} = {json.dumps(val)[:400]}")
