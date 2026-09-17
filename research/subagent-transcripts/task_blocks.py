#!/usr/bin/env python3
"""Dump the STRUCTURE of every Task tool_use / tool_result pair in a parent
transcript: ids, key names, scalar metadata. Message text is elided."""
import json, sys

def keyshape(o, depth=0):
    if isinstance(o, dict):
        return {k: keyshape(v, depth+1) for k, v in o.items()}
    if isinstance(o, list):
        return [f"list[{len(o)}]"] + ([keyshape(o[0], depth+1)] if o else [])
    if isinstance(o, str):
        return f"<str len={len(o)}>" if len(o) > 60 else o
    return o

path = sys.argv[1]
task_ids = set()
for line in open(path, encoding="utf-8", errors="replace"):
    line=line.strip()
    if not line: continue
    try: v=json.loads(line)
    except Exception: continue
    msg=v.get("message") or {}
    for b in (msg.get("content") or []):
        if not isinstance(b, dict): continue
        if b.get("type")=="tool_use" and b.get("name")in ("Task","Agent"):
            task_ids.add(b.get("id"))
            print(f"[tool_use Task] id={b.get('id')} uuid={v.get('uuid')} ts={v.get('timestamp')}")
            inp=b.get("input") or {}
            print("   input keys:", {k:(f'<str len={len(x)}>' if isinstance(x,str) and len(x)>60 else x) for k,x in inp.items()})
        if b.get("type")=="tool_result" and b.get("tool_use_id") in task_ids:
            print(f"[tool_result Task] tool_use_id={b.get('tool_use_id')} uuid={v.get('uuid')} ts={v.get('timestamp')}")
            print("   result block keyshape:", json.dumps(keyshape(b))[:600])
            tur=v.get("toolUseResult")
            if tur is not None:
                print("   toolUseResult keyshape:", json.dumps(keyshape(tur))[:1500])
