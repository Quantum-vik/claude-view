#!/usr/bin/env python3
"""(a) show the per-record output_tokens pattern that makes usage NON-identical;
(b) reproduce the 3.26x figure from a 63-record window;
(c) hunt for retry evidence: duplicated prompts, retry fields, back-to-back
    requests with identical input-side token counts."""
import json, collections, os, pathlib

ROOT = pathlib.Path(os.path.expanduser("~/.claude/projects"))
rows = json.load(open("rows.json"))
byf = collections.defaultdict(list)
for r in rows: byf[r["file"]].append(r)
for v in byf.values(): v.sort(key=lambda r: r["lineno"])

print("== (a) per-record output_tokens within one message.id ==")
for f, lbl in (("-home-quantumvik-WorkPersonal-claude-view/ca79a6f4-1702-4446-ad43-2d954f07e92f/subagents/agent-a7d221c1ddeba59a6.jsonl", "SUBAGENT"),
               ("-home-quantumvik/44d945fe-203a-46dd-9f3d-e248cc3108ae.jsonl", "SESSION ")):
    byk = collections.defaultdict(list)
    for r in byf[f]: byk[r["msgid"]].append(r)
    shown = 0
    print(f"  -- {lbl} {f.split('/')[-1]}")
    for k, v in byk.items():
        if len(v) < 2: continue
        print(f"     {k}  blocks={[x['blk'] for x in v]} types={[x['btypes'] for x in v]}")
        print(f"        input-side={[x['inp']+x['cr']+x['cc'] for x in v]}  output={[x['out'] for x in v]}")
        shown += 1
        if shown == 3: break

print("\n== (b) reproduce a ~3.26x reading from a 63-record prefix ==")
for f in ("-home-quantumvik-WorkPersonal-claude-view/ca79a6f4-1702-4446-ad43-2d954f07e92f.jsonl",):
    rs = byf[f]
    for n in (49, 56, 63, 70, 100, len(rs)):
        w = rs[:n]
        keys = len({r["msgid"] for r in w})
        si = sum(r["inp"]+r["cr"]+r["cc"] for r in w)
        byk = collections.defaultdict(list)
        for r in w: byk[r["msgid"]].append(r)
        di = sum(v[-1]["inp"]+v[-1]["cr"]+v[-1]["cc"] for v in byk.values())
        print(f"     first {n:4d} assistant recs of {f.split('/')[-1][:8]}: keys={keys} rec/key={n/keys:.3f} token_x={si/di:.3f}")

print("\n== (c) retry hunt ==")
# c1: any field anywhere named like a retry?
fields = collections.Counter()
for p in sorted(ROOT.rglob("*.jsonl")):
    for line in p.open(encoding="utf-8", errors="replace"):
        try: v = json.loads(line)
        except Exception: continue
        if v.get("type") != "assistant": continue
        for k in v: fields[k] += 1
        for k in (v.get("message") or {}): fields["message."+k] += 1
print("  every top-level / message-level field seen on assistant records:")
for k, n in sorted(fields.items()):
    print(f"     {n:6d}  {k}")

# c2: consecutive requests within a file with IDENTICAL input-side totals
print("\n  consecutive DISTINCT requestIds with identical input-side token totals (retry tell):")
hits = 0
for f, rs in byf.items():
    seen = []
    byk = {}
    order = []
    for r in rs:
        if r["reqid"] not in byk:
            byk[r["reqid"]] = r; order.append(r["reqid"])
    for i in range(1, len(order)):
        a, b = byk[order[i-1]], byk[order[i]]
        if a["inp"]+a["cr"]+a["cc"] == b["inp"]+b["cr"]+b["cc"] and a["msgid"] != b["msgid"]:
            hits += 1
            if hits <= 15:
                print(f"     {f.split('/')[-1][:20]:20s} {a['reqid']} -> {b['reqid']} ctx={a['inp']+a['cr']+a['cc']} out={a['out']}/{b['out']}")
print(f"  total such adjacent pairs: {hits}")
