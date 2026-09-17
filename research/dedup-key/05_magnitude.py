#!/usr/bin/env python3
"""Q4: reconcile 3.26x vs 2.24-2.85x. Record-count ratio vs TOKEN-WEIGHTED ratio,
per file, per model, and over sliding windows of one long session."""
import json, collections, os, pathlib

ROOT = pathlib.Path(os.path.expanduser("~/.claude/projects"))
rows = json.load(open("rows.json"))

def ratios(rs):
    byk = collections.defaultdict(list)
    for r in rs:
        byk[r["msgid"]].append(r)
    for v in byk.values(): v.sort(key=lambda r: r["lineno"])
    recs = len(rs); keys = len(byk)
    sum_in  = sum(r["inp"]+r["cr"]+r["cc"] for r in rs)
    ded_in  = sum(v[-1]["inp"]+v[-1]["cr"]+v[-1]["cc"] for v in byk.values())
    sum_out = sum(r["out"] for r in rs)
    ded_out = sum(v[-1]["out"] for v in byk.values())
    return recs, keys, (recs/keys if keys else 0), sum_in, ded_in, (sum_in/ded_in if ded_in else 0), sum_out, ded_out, (sum_out/ded_out if ded_out else 0)

print("== per file ==")
print(f"{'recs':>6} {'keys':>6} {'rec/key':>8} {'in x':>7} {'out x':>7}  file")
byf = collections.defaultdict(list)
for r in rows: byf[r["file"]].append(r)
allr = []
for f, rs in sorted(byf.items(), key=lambda kv: -len(kv[1])):
    a = ratios(rs); allr.append((a[2], a[5], f))
    kind = "SUBAGENT" if "/subagents/" in f else "session "
    print(f"{a[0]:6d} {a[1]:6d} {a[2]:8.3f} {a[5]:7.3f} {a[8]:7.3f}  {kind} {f.split('/')[-1]}")

print("\n== spread of the record/key ratio ==")
rr = sorted(x[0] for x in allr); ir = sorted(x[1] for x in allr)
print(f"  record/key : min={rr[0]:.3f} p50={rr[len(rr)//2]:.3f} max={rr[-1]:.3f}  (n={len(rr)} files)")
print(f"  input x    : min={ir[0]:.3f} p50={ir[len(ir)//2]:.3f} max={ir[-1]:.3f}")
sub = [x for x in allr if "/subagents/" in x[2]]; par = [x for x in allr if "/subagents/" not in x[2]]
print(f"  subagent files: rec/key mean={sum(x[0] for x in sub)/len(sub):.3f} (n={len(sub)})")
print(f"  session  files: rec/key mean={sum(x[0] for x in par)/len(par):.3f} (n={len(par)})")

print("\n== per model ==")
bym = collections.defaultdict(list)
for r in rows: bym[r["model"]].append(r)
for m, rs in sorted(bym.items(), key=lambda kv: -len(kv[1])):
    a = ratios(rs)
    print(f"  {m:28s} recs={a[0]:5d} keys={a[1]:5d} rec/key={a[2]:.3f} in_x={a[5]:.3f} out_x={a[8]:.3f}")

print("\n== per CLI version ==")
byv = collections.defaultdict(list)
for p in sorted(ROOT.rglob("*.jsonl")):
    for line in p.open(encoding="utf-8", errors="replace"):
        try: v = json.loads(line)
        except Exception: continue
        if v.get("type") == "assistant":
            byv[v.get("version")].append((v.get("message",{}).get("id"), 1))
for ver, lst in sorted(byv.items(), key=lambda kv: -len(kv[1])):
    k = len({x[0] for x in lst})
    print(f"  {ver}: recs={len(lst)} keys={k} rec/key={len(lst)/k:.3f}")

print("\n== sliding windows over the biggest session (why one pass saw 3.26x) ==")
big = "-home-quantumvik/44d945fe-203a-46dd-9f3d-e248cc3108ae.jsonl"
rs = sorted(byf[big], key=lambda r: r["lineno"])
for w in (63, 100, 200, 500):
    vals = []
    for i in range(0, len(rs)-w+1, max(1, w//2)):
        a = ratios(rs[i:i+w]); vals.append(a[2])
    if vals:
        vals.sort()
        print(f"  window={w:4d} recs -> rec/key min={vals[0]:.3f} p50={vals[len(vals)//2]:.3f} max={vals[-1]:.3f} (n={len(vals)} windows)")
# and over the subagent with the most blocks
big2 = max(byf, key=lambda f: len(byf[f]) if "/subagents/" in f else -1)
rs2 = sorted(byf[big2], key=lambda r: r["lineno"])
print(f"  [subagent {big2.split('/')[-1]}]")
for w in (63, 100):
    vals = sorted(ratios(rs2[i:i+w])[2] for i in range(0, len(rs2)-w+1, max(1,w//2)))
    if vals: print(f"  window={w:4d} recs -> rec/key min={vals[0]:.3f} p50={vals[len(vals)//2]:.3f} max={vals[-1]:.3f}")
