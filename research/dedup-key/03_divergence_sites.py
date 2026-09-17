#!/usr/bin/env python3
"""Q2: go looking for the specific places the two keys COULD diverge:
retries, stream continuation, interrupts, compaction, resume."""
import json, collections, os, pathlib

ROOT = pathlib.Path(os.path.expanduser("~/.claude/projects"))
rows = json.load(open("rows.json"))

# ---------- A. resume / fork: which file is the copy? -----------------------
A = "-home-quantumvik/44d945fe-203a-46dd-9f3d-e248cc3108ae.jsonl"
B = "-home-quantumvik/a1532e8c-2eac-4442-8803-c9262b0298e4.jsonl"
ra = [r for r in rows if r["file"] == A]
rb = [r for r in rows if r["file"] == B]
sa, sb = {r["msgid"] for r in ra}, {r["msgid"] for r in rb}
shared = sa & sb
print("== A. resume / fork ==")
print(f"  A={A.split('/')[-1]} assistant recs={len(ra)} distinct msgid={len(sa)} ts range {min(r['ts'] for r in ra)} .. {max(r['ts'] for r in ra)}")
print(f"  B={B.split('/')[-1]} assistant recs={len(rb)} distinct msgid={len(sb)} ts range {min(r['ts'] for r in rb)} .. {max(r['ts'] for r in rb)}")
print(f"  shared msgid={len(shared)}  A-only={len(sa-shared)}  B-only={len(sb-shared)}")
ts_shared = sorted(r["ts"] for r in rb if r["msgid"] in shared)
print(f"  shared records' timestamps: {ts_shared[0]} .. {ts_shared[-1]}")
print(f"  B-only records' timestamps: {min(r['ts'] for r in rb if r['msgid'] not in shared)} .. {max(r['ts'] for r in rb if r['msgid'] not in shared)}")
# what does sessionId say INSIDE the copied records of B?
sess_in_b = collections.Counter()
for line in (ROOT/B).open(encoding="utf-8", errors="replace"):
    try: v = json.loads(line)
    except Exception: continue
    if v.get("type") == "assistant":
        m = v.get("message") or {}
        sess_in_b[(v.get("sessionId"), m.get("id") in shared)] += 1
print(f"  sessionId recorded inside B's assistant records (sessionId, is_copied): {dict(sess_in_b)}")

# ---------- B. compaction ---------------------------------------------------
print("\n== B. compaction boundaries ==")
for p in sorted(ROOT.rglob("*.jsonl")):
    hits = []
    prev_assistant = None
    for lineno, line in enumerate(p.open(encoding="utf-8", errors="replace"), 1):
        try: v = json.loads(line)
        except Exception: continue
        if v.get("subtype") == "compact_boundary" or v.get("isCompactSummary"):
            hits.append((lineno, v.get("subtype"), (v.get("compactMetadata") or {})))
    if hits:
        print(f"  {p.relative_to(ROOT)}: {len(hits)} boundary record(s)")
        for h in hits:
            print(f"     line {h[0]} subtype={h[1]} meta={h[2]}")

# across a compaction boundary: do msgid/reqid repeat? does input drop?
p = ROOT / A
seq = []
for lineno, line in enumerate(p.open(encoding="utf-8", errors="replace"), 1):
    try: v = json.loads(line)
    except Exception: continue
    if v.get("subtype") == "compact_boundary":
        seq.append(("BOUNDARY", lineno, None, None))
    elif v.get("type") == "assistant":
        m = v.get("message") or {}; u = m.get("usage") or {}
        seq.append(("A", lineno, m.get("id"), u.get("input_tokens",0)+u.get("cache_read_input_tokens",0)+u.get("cache_creation_input_tokens",0)))
for i, s in enumerate(seq):
    if s[0] == "BOUNDARY":
        print(f"\n  context (input side) around boundary at line {s[1]}:")
        for j in range(max(0,i-3), min(len(seq), i+4)):
            t = seq[j]
            print(f"     {t[0]:8s} line={t[1]:6d} msgid={t[2]} ctx={t[3]}")
        # do any msgid after the boundary repeat one from before?
        before = {t[2] for t in seq[:i] if t[0]=="A"}
        after  = {t[2] for t in seq[i+1:] if t[0]=="A"}
        print(f"     msgid repeated across the boundary: {len(before & after)}")

# ---------- C. interrupts / errors ------------------------------------------
print("\n== C. interrupted turns / api errors ==")
stops = collections.Counter(r["stop"] for r in rows)
print(f"  stop_reason distribution: {dict(stops)}")
errs = [r for r in rows if r["err"]]
print(f"  isApiErrorMessage records: {len(errs)}")
for r in errs[:10]:
    print(f"     file={r['file'].split('/')[-1]} msgid={r['msgid']} reqid={r['reqid']} usage=({r['inp']},{r['cr']},{r['cc']},{r['out']}) model={r['model']}")
# user-side interrupt markers
intr = collections.Counter()
for p in sorted(ROOT.rglob("*.jsonl")):
    for line in p.open(encoding="utf-8", errors="replace"):
        if "Request interrupted" in line or "interrupted by user" in line or '"stop_reason":"max_tokens"' in line:
            try: v=json.loads(line)
            except Exception: continue
            intr[(p.name, v.get("type"))] += 1
print(f"  lines containing an interrupt marker, by (file,type): {dict(intr)}")

# ---------- D. block index: is it dense 0..n-1 per message? -----------------
print("\n== D. apiBlockIndex shape (retry / continuation tell) ==")
bym = collections.defaultdict(list)
for r in rows:
    if r["msgid"]: bym[(r["file"], r["msgid"])].append(r)
bad = 0; counts = collections.Counter()
for k, v in bym.items():
    idxs = sorted(x["blk"] for x in v if x["blk"] is not None)
    counts[len(v)] += 1
    if idxs != list(range(len(v))):
        bad += 1
        if bad <= 10:
            print(f"     NON-DENSE {k[1]} indices={idxs} n={len(v)}")
print(f"  records-per-message.id histogram: {dict(sorted(counts.items()))}")
print(f"  message.ids whose apiBlockIndex is NOT a dense 0..n-1: {bad}")

# does every record of one message.id carry an IDENTICAL usage object?
diff = 0
for k, v in bym.items():
    us = {(x["inp"],x["cr"],x["cc"],x["out"]) for x in v}
    if len(us) > 1:
        diff += 1
        if diff <= 10: print(f"     USAGE DIFFERS within msgid {k[1]}: {us}")
print(f"  message.ids whose per-record usage is NOT identical: {diff}")
