#!/usr/bin/env python3
"""Turn-level proof: track the PARENT's per-API-request context size across the
window in which a subagent ran. If the parent's accounting re-billed the child,
the parent's context would jump by the child's whole consumption when the child
reports back. Prints timestamps + token counts only.

Usage: turn_delta.py <parent.jsonl> <agentId>
"""
import json, os, sys, collections

parent, aid = sys.argv[1], sys.argv[2]
sid = os.path.basename(parent)[:-6]
child = os.path.join(os.path.dirname(parent), sid, "subagents", f"agent-{aid}.jsonl")

def reqs(path):
    seen=set(); out=[]
    for line in open(path, encoding="utf-8", errors="replace"):
        line=line.strip()
        if not line: continue
        try: v=json.loads(line)
        except Exception: continue
        if v.get("type")!="assistant": continue
        u=(v.get("message") or {}).get("usage")
        if not isinstance(u,dict): continue
        rid=v.get("requestId") or (v.get("message") or {}).get("id")
        if rid in seen: continue
        seen.add(rid)
        ctx=(u.get("input_tokens",0) or 0)+(u.get("cache_read_input_tokens",0) or 0)+(u.get("cache_creation_input_tokens",0) or 0)
        out.append((v.get("timestamp"), rid, ctx, u.get("output_tokens",0) or 0))
    return out

# window: child's first and last timestamps
cr = reqs(child)
c_start, c_end = cr[0][0], cr[-1][0]
c_in = sum(r[2] for r in cr); c_out = sum(r[3] for r in cr)
print(f"child agent-{aid}: {len(cr)} API requests, {c_start} .. {c_end}")
print(f"   child input-side total = {c_in:,}   output total = {c_out:,}\n")

pr = reqs(parent)
lo = [i for i,r in enumerate(pr) if r[0] < c_start]
hi = [i for i,r in enumerate(pr) if r[0] > c_end]
i0 = lo[-1] if lo else 0
i1 = hi[0] if hi else len(pr)-1
print("parent API requests bracketing the child's run (ctx = input+cache_read+cache_create):")
for i in range(max(0,i0-1), min(len(pr), i1+3)):
    ts, rid, ctx, out = pr[i]
    mark = ""
    if i == i0: mark = "   <-- last parent request BEFORE child started"
    if i == i1: mark = "   <-- first parent request AFTER child finished"
    print(f"   {ts}  ctx={ctx:>9,}  out={out:>6,}  {rid}{mark}")
d = pr[i1][2] - pr[i0][2]
print(f"\nparent ctx delta across the child's entire run = {d:+,}")
print(f"child's own consumption                        = {c_in:,} input-side")
print(f"=> parent context grew by {d:+,}, NOT by {c_in:,}. "
      f"The parent absorbs only the child's final report text.")
