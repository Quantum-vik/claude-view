#!/usr/bin/env python3
"""Q2: hunt for divergence sites -- resumed sessions, compaction, interrupts,
retries, stream continuation. Looks at the cross-FILE id overlap found in 01."""
import json, collections, os, pathlib

ROOT = pathlib.Path(os.path.expanduser("~/.claude/projects"))
rows = json.load(open("rows.json"))

# --- resumed sessions: same ids in two files --------------------------------
mfiles = collections.defaultdict(set)
for r in rows:
    if r["msgid"]:
        mfiles[r["msgid"]].add(r["file"])
pairs = collections.Counter()
for k, v in mfiles.items():
    if len(v) > 1:
        pairs[tuple(sorted(v))] += 1
print("== cross-file shared message.id, by file pair ==")
for k, n in pairs.most_common():
    print(f"  {n} shared message.id between:")
    for f in k:
        print(f"      {f}")

# for each such pair, show whether the usage numbers are identical too
for k in pairs:
    a, b = k
    ra = {r["msgid"]: r for r in rows if r["file"] == a}
    rb = {r["msgid"]: r for r in rows if r["file"] == b}
    shared = set(ra) & set(rb)
    same_usage = sum(1 for m in shared if (ra[m]["inp"], ra[m]["cr"], ra[m]["cc"], ra[m]["out"]) == (rb[m]["inp"], rb[m]["cr"], rb[m]["cc"], rb[m]["out"]))
    same_req = sum(1 for m in shared if ra[m]["reqid"] == rb[m]["reqid"])
    same_uuid = sum(1 for m in shared if ra[m]["uuid"] == rb[m]["uuid"])
    same_ts = sum(1 for m in shared if ra[m]["ts"] == rb[m]["ts"])
    print(f"\n  shared={len(shared)}  identical usage={same_usage}  identical requestId={same_req}  identical uuid={same_uuid}  identical timestamp={same_ts}")
    print(f"  file A records={sum(1 for r in rows if r['file']==a)}  file B records={sum(1 for r in rows if r['file']==b)}")

# --- session lineage: what links them? --------------------------------------
print("\n== session-file lineage fields (first line of each transcript) ==")
for p in sorted(ROOT.rglob("*.jsonl")):
    first = None
    summary = None
    for line in p.open(encoding="utf-8", errors="replace"):
        try: v = json.loads(line)
        except Exception: continue
        if first is None:
            first = v
        t = v.get("type")
        if t in ("summary",) or v.get("isCompactSummary") or v.get("subtype") in ("compact_boundary",):
            summary = (t, v.get("subtype"), v.get("leafUuid") is not None, list(v.keys())[:12])
            break
    if first is None: continue
    keys = {k: first[k] for k in ("type", "subtype", "sessionId", "leafUuid", "isCompactSummary", "parentUuid") if k in first}
    print(f"  {p.relative_to(ROOT)}\n      first={keys}\n      early-summary/compact={summary}")
