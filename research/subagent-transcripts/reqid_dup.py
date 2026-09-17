#!/usr/bin/env python3
"""Check whether assistant records that share a requestId repeat the SAME usage
block (i.e. one API response fanned out over several transcript lines)."""
import json, sys, collections
FIELDS = ["input_tokens","output_tokens","cache_read_input_tokens","cache_creation_input_tokens"]
by = collections.defaultdict(list)
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    line=line.strip()
    if not line: continue
    try: v=json.loads(line)
    except Exception: continue
    if v.get("type")!="assistant": continue
    u=(v.get("message") or {}).get("usage")
    if not isinstance(u,dict): continue
    blocks=[b.get("type") for b in ((v.get("message") or {}).get("content") or []) if isinstance(b,dict)]
    by[v.get("requestId")].append((tuple(u.get(f,0) or 0 for f in FIELDS),
                                   (v.get("message") or {}).get("id"),
                                   v.get("apiBlockIndex"), blocks))
same=diff=0
for rid, rows in by.items():
    usages={r[0] for r in rows}
    msgids={r[1] for r in rows}
    if len(rows)>1:
        (same if len(usages)==1 else diff).__int__()
        if len(usages)==1: same+=1
        else: diff+=1
    print(f"requestId {rid}: {len(rows)} records, {len(usages)} distinct usage tuple(s), "
          f"{len(msgids)} distinct message.id, apiBlockIndex={[r[2] for r in rows]}, blocks={[r[3] for r in rows]}")
print(f"\nmulti-record requestIds: identical-usage={same} differing-usage={diff}")
