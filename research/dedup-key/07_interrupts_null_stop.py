#!/usr/bin/env python3
"""Interrupted turns, stop_reason=None records, and the one <synthetic> record.
Also: does stop_reason=None correlate with the partial-usage records?"""
import json, collections, os, pathlib
ROOT = pathlib.Path(os.path.expanduser("~/.claude/projects"))
rows = json.load(open("rows.json"))

print("== stop_reason vs position within the message.id group ==")
byk = collections.defaultdict(list)
for r in rows:
    if r["msgid"]: byk[(r["file"], r["msgid"])].append(r)
for v in byk.values(): v.sort(key=lambda r: r["lineno"])
tab = collections.Counter()
for v in byk.values():
    for i, r in enumerate(v):
        pos = "LAST" if i == len(v)-1 else "non-last"
        tab[(pos, r["stop"])] += 1
for k, n in sorted(tab.items(), key=lambda kv: (kv[0][0], str(kv[0][1]))):
    print(f"   {k[0]:8s} stop_reason={str(k[1]):14s} n={n}")

print("\n== is the partial-output record exactly the non-last one? ==")
agree = disagree = 0
for v in byk.values():
    if len({r["out"] for r in v}) > 1:
        partials = [r for r in v if r["out"] != v[-1]["out"]]
        if all(r is not v[-1] for r in partials): agree += 1
        else: disagree += 1
print(f"   groups where every lower output_tokens is on a NON-last record: {agree}; counterexamples: {disagree}")

print("\n== interrupted turns: the assistant record preceding each interrupt marker ==")
for p in sorted(ROOT.rglob("*.jsonl")):
    lines = p.open(encoding="utf-8", errors="replace").readlines()
    for i, line in enumerate(lines):
        if "Request interrupted" not in line and "interrupted by user" not in line:
            continue
        try: v = json.loads(line)
        except Exception: continue
        # walk back to the last assistant record
        prev = None
        for j in range(i-1, max(-1, i-40), -1):
            try: w = json.loads(lines[j])
            except Exception: continue
            if w.get("type") == "assistant":
                prev = (j+1, w); break
        # walk forward to the next assistant record
        nxt = None
        for j in range(i+1, min(len(lines), i+40)):
            try: w = json.loads(lines[j])
            except Exception: continue
            if w.get("type") == "assistant":
                nxt = (j+1, w); break
        def desc(t):
            if not t: return "none"
            ln, w = t; m = w.get("message") or {}; u = m.get("usage") or {}
            return (f"line={ln} msgid={m.get('id')} req={w.get('requestId')} blk={w.get('apiBlockIndex')} "
                    f"stop={m.get('stop_reason')} ctx={u.get('input_tokens',0)+u.get('cache_read_input_tokens',0)+u.get('cache_creation_input_tokens',0)} out={u.get('output_tokens')}")
        print(f"  {p.name[:28]:28s} interrupt at line {i+1} (type={v.get('type')})")
        print(f"     before: {desc(prev)}")
        print(f"     after : {desc(nxt)}")
        if prev and nxt:
            pm = (prev[1].get('message') or {}).get('id'); nm = (nxt[1].get('message') or {}).get('id')
            print(f"     same message.id across the interrupt? {pm == nm}   same requestId? {prev[1].get('requestId') == nxt[1].get('requestId')}")

print("\n== the <synthetic> record ==")
for p in sorted(ROOT.rglob("*.jsonl")):
    for lineno, line in enumerate(p.open(encoding="utf-8", errors="replace"), 1):
        try: v = json.loads(line)
        except Exception: continue
        if v.get("type")=="assistant" and (v.get("message") or {}).get("model")=="<synthetic>":
            m = v["message"]
            print(f"   {p.name} line {lineno}")
            print(f"   top-level keys : {sorted(v.keys())}")
            print(f"   message.id     : {m.get('id')!r}   (note the shape)")
            print(f"   requestId      : {v.get('requestId')!r}")
            print(f"   apiBlockIndex  : {v.get('apiBlockIndex')!r}")
            print(f"   usage          : {m.get('usage')}")
            print(f"   stop_reason    : {m.get('stop_reason')!r}  isApiErrorMessage={v.get('isApiErrorMessage')!r}")
            print(f"   content types  : {[b.get('type') for b in m.get('content') or []]}")
