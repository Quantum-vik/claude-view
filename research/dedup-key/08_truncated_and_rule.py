#!/usr/bin/env python3
"""The 7 message.id groups whose LAST record has stop_reason=None (interrupted),
plus a simulation of the proposed rule end-to-end."""
import json, collections
rows = json.load(open("rows.json"))
byk = collections.defaultdict(list)
for r in rows:
    if r["msgid"]: byk[(r["file"], r["msgid"])].append(r)
for v in byk.values(): v.sort(key=lambda r: r["lineno"])

print("== message.id groups whose LAST record has stop_reason=None (truncated / interrupted) ==")
n=0
for (f, m), v in byk.items():
    if v[-1]["stop"] is None:
        n += 1
        print(f"  {f.split('/')[-1][:30]:30s} {m} recs={len(v)} blk={[x['blk'] for x in v]} out={[x['out'] for x in v]} ctx={v[-1]['inp']+v[-1]['cr']+v[-1]['cc']} btypes={[x['btypes'] for x in v]}")
print(f"  total: {n}   (vs {sum(1 for v in byk.values() if v[-1]['stop'] is not None)} normally-terminated groups)")
print("  -> on these, output_tokens is a STREAM SNAPSHOT, not the billed total. The")
print("     transcript cannot recover what was actually generated before the abort.")

print("\n== uuid uniqueness (is a record identifiable at all?) ==")
uu = collections.Counter(r["uuid"] for r in rows)
print(f"  distinct uuid = {len(uu)} over {len(rows)} records; repeated uuids = {sum(1 for c in uu.values() if c>1)}")
pair = collections.Counter((r["file"], r["msgid"], r["blk"]) for r in rows)
print(f"  distinct (file, message.id, apiBlockIndex) = {len(pair)}; collisions = {sum(1 for c in pair.values() if c>1)}")

print("\n== simulation of the proposed rule ==")
# rule: key = message.id (fallback uuid); keep LAST record per key per FILE-SET;
# dedup globally across files so a resumed session's replayed turns count once.
def apply_rule(rs, global_dedup=True):
    keep = {}
    for r in rs:
        k = r["msgid"] or r["uuid"]
        if not global_dedup:
            k = (r["file"], k)
        keep[k] = r          # later line wins
    tot_in = sum(v["inp"]+v["cr"]+v["cc"] for v in keep.values())
    tot_out = sum(v["out"] for v in keep.values())
    return len(keep), tot_in, tot_out

naive_in = sum(r["inp"]+r["cr"]+r["cc"] for r in rows)
naive_out = sum(r["out"] for r in rows)
g = apply_rule(rows, True)
l = apply_rule(rows, False)
print(f"  naive sum (today's usage_from per line):  in={naive_in:,}  out={naive_out:,}  records={len(rows)}")
print(f"  rule, per-file dedup:                     in={l[1]:,}  out={l[2]:,}  keys={l[0]}   -> {naive_in/l[1]:.3f}x / {naive_out/l[2]:.3f}x saved")
print(f"  rule, GLOBAL dedup (resume-safe):         in={g[1]:,}  out={g[2]:,}  keys={g[0]}")
print(f"  extra removed by going global (the resumed-session replay): in={l[1]-g[1]:,} ({100*(l[1]-g[1])/l[1]:.2f}%) out={l[2]-g[2]:,}")

print("\n== same rule keyed on requestId instead ==")
def apply_req(rs):
    keep = {}
    for r in rs:
        k = r["reqid"] or ("uuid:"+r["uuid"])
        keep[k] = r
    return len(keep), sum(v["inp"]+v["cr"]+v["cc"] for v in keep.values()), sum(v["out"] for v in keep.values())
q = apply_req(rows)
print(f"  keys={q[0]} in={q[1]:,} out={q[2]:,}")
print(f"  IDENTICAL to message.id rule? keys={q[0]==g[0]} in={q[1]==g[1]} out={q[2]==g[2]}")

print("\n== context-meter check: is the input side of the LAST assistant record of a file == max? ==")
byf = collections.defaultdict(list)
for r in rows: byf[r["file"]].append(r)
bad=0
for f, rs in byf.items():
    rs.sort(key=lambda r: r["lineno"])
    last = rs[-1]["inp"]+rs[-1]["cr"]+rs[-1]["cc"]
    mx = max(r["inp"]+r["cr"]+r["cc"] for r in rs)
    if last != mx:
        bad += 1
        print(f"  NOT monotone: {f.split('/')[-1][:30]:30s} last={last:,} max={mx:,} ({100*last/mx:.1f}% of peak)")
print(f"  files where last != max input side: {bad}/{len(byf)}  (context can legitimately DROP after compaction)")
