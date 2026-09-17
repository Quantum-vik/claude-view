#!/usr/bin/env python3
"""Double-counting test for a parent session + its subagents/ children.

For each transcript: de-duplicate assistant records by requestId (Claude Code
writes one record PER CONTENT BLOCK, each repeating the same usage), then sum
message.usage. Also reports requestId overlap between parent and children --
the decisive test: if the parent's accounting re-billed the child's turns, the
child's requestIds would have to appear in the parent file.

Usage: doublecount.py <parent.jsonl>
Numbers and opaque ids only; no message content is read or printed.
"""
import json, os, sys, collections

F = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]

def dedup_usage(path):
    tot = collections.Counter(); seen=set(); raw=collections.Counter()
    reqs=set(); rawrecs=0; maxctx=0
    for line in open(path, encoding="utf-8", errors="replace"):
        line=line.strip()
        if not line: continue
        try: v=json.loads(line)
        except Exception: continue
        if v.get("type")!="assistant": continue
        u=(v.get("message") or {}).get("usage")
        if not isinstance(u,dict): continue
        rawrecs+=1
        for f in F: raw[f]+=u.get(f,0) or 0
        rid=v.get("requestId") or (v.get("message") or {}).get("id")
        if rid in seen: continue
        seen.add(rid); reqs.add(rid)
        for f in F: tot[f]+=u.get(f,0) or 0
        ctx=(u.get("input_tokens",0) or 0)+(u.get("cache_read_input_tokens",0) or 0)+(u.get("cache_creation_input_tokens",0) or 0)
        maxctx=max(maxctx,ctx)
    return tot, raw, rawrecs, reqs, maxctx

def line(tag, tot, rawrecs, nreq, maxctx):
    tin = tot["input_tokens"]+tot["cache_read_input_tokens"]+tot["cache_creation_input_tokens"]
    print(f"{tag:<34} req={nreq:<4} recs={rawrecs:<4} "
          f"in={tot['input_tokens']:<7,} cache_r={tot['cache_read_input_tokens']:<12,} "
          f"cache_w={tot['cache_creation_input_tokens']:<10,} out={tot['output_tokens']:<9,} "
          f"IN_TOTAL={tin:<12,} peak_ctx={maxctx:,}")
    return tot, tin

parent = sys.argv[1]
sid = os.path.basename(parent)[:-6]
subdir = os.path.join(os.path.dirname(parent), sid, "subagents")

ptot, praw, precs, preqs, pmax = dedup_usage(parent)
print("=== PARENT")
line(f"parent {sid[:8]}", ptot, precs, len(preqs), pmax)
print(f"   (raw, no dedup)  in={praw['input_tokens']:,} cache_r={praw['cache_read_input_tokens']:,} "
      f"cache_w={praw['cache_creation_input_tokens']:,} out={praw['output_tokens']:,}  "
      f"<- inflation factor {precs/max(len(preqs),1):.2f}x")

print("\n=== CHILDREN")
ctot = collections.Counter(); creqs=set(); nkids=0
if os.path.isdir(subdir):
    for fn in sorted(os.listdir(subdir)):
        if not fn.endswith(".jsonl"): continue
        p=os.path.join(subdir,fn)
        t,r,recs,reqs,mx = dedup_usage(p)
        nkids+=1
        line(fn[:-6], t, recs, len(reqs), mx)
        for f in F: ctot[f]+=t[f]
        creqs |= reqs

print("\n=== ARITHMETIC")
pin = ptot["input_tokens"]+ptot["cache_read_input_tokens"]+ptot["cache_creation_input_tokens"]
cin = ctot["input_tokens"]+ctot["cache_read_input_tokens"]+ctot["cache_creation_input_tokens"]
print(f"parent   requests={len(preqs):<5} input-side={pin:,}   output={ptot['output_tokens']:,}")
print(f"children requests={len(creqs):<5} input-side={cin:,}   output={ctot['output_tokens']:,}   ({nkids} agents)")
print(f"OVERLAP of requestIds parent<->children: {len(preqs & creqs)}")
print(f"union of requestIds: {len(preqs | creqs)}  (parent+children={len(preqs)+len(creqs)})")
print(f"TRUE TOTAL (parent + children) input-side={pin+cin:,} output={ptot['output_tokens']+ctot['output_tokens']:,}")
if pin:
    print(f"children are {cin/pin:.2f}x the parent's input-side tokens "
          f"({100*cin/(pin+cin):.1f}% of the session's true total)")
