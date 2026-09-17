#!/usr/bin/env python3
"""Q1/Q5: are message.id and requestId 1:1? are either ever absent?

Walks every JSONL under ~/.claude/projects, collects one row per assistant
record, and builds both directions of the mapping. Prints counts only --
no message content is read or emitted.
"""
import json, os, sys, collections, pathlib

ROOT = pathlib.Path(os.path.expanduser("~/.claude/projects"))

rows = []           # (file, lineno, msgid, reqid, apiBlockIndex, model, usage_tuple, ts, uuid, stop_reason, is_sidechain)
for p in sorted(ROOT.rglob("*.jsonl")):
    for lineno, line in enumerate(p.open(encoding="utf-8", errors="replace"), 1):
        line = line.strip()
        if not line:
            continue
        try:
            v = json.loads(line)
        except Exception:
            continue
        if v.get("type") != "assistant":
            continue
        m = v.get("message") or {}
        u = m.get("usage") or {}
        rows.append(dict(
            file=str(p.relative_to(ROOT)),
            lineno=lineno,
            msgid=m.get("id"),
            reqid=v.get("requestId"),
            blk=v.get("apiBlockIndex"),
            model=m.get("model"),
            inp=u.get("input_tokens", 0) or 0,
            cr=u.get("cache_read_input_tokens", 0) or 0,
            cc=u.get("cache_creation_input_tokens", 0) or 0,
            out=u.get("output_tokens", 0) or 0,
            ts=v.get("timestamp"),
            uuid=v.get("uuid"),
            stop=m.get("stop_reason"),
            side=v.get("isSidechain"),
            err=v.get("isApiErrorMessage"),
            nblocks=len(m.get("content") or []),
            btypes=tuple(sorted({b.get("type") for b in (m.get("content") or []) if isinstance(b, dict)})),
        ))

print(f"assistant records total: {len(rows)}")
print(f"files with assistant records: {len(set(r['file'] for r in rows))}")

# ---- Q5: nulls -------------------------------------------------------------
no_mid = [r for r in rows if not r["msgid"]]
no_rid = [r for r in rows if not r["reqid"]]
print(f"\n[Q5] records missing message.id : {len(no_mid)}")
print(f"[Q5] records missing requestId  : {len(no_rid)}")
for label, bad in (("missing message.id", no_mid), ("missing requestId", no_rid)):
    if bad:
        print(f"  -- {label} breakdown --")
        c = collections.Counter((r["model"], r["stop"], r["err"], r["btypes"], (r["inp"], r["cr"], r["cc"], r["out"])) for r in bad)
        for k, n in c.most_common(20):
            print(f"    n={n:5d} model={k[0]!r} stop={k[1]!r} apiErr={k[2]!r} blocks={k[3]} usage(in,cr,cc,out)={k[4]}")
        print(f"    files: {sorted(set(r['file'] for r in bad))[:10]}")

# synthetic / zero-usage
syn = [r for r in rows if r["model"] == "<synthetic>"]
zero = [r for r in rows if (r["inp"] + r["cr"] + r["cc"] + r["out"]) == 0]
print(f"\n[Q5] model == '<synthetic>' : {len(syn)}  (of which missing reqid: {sum(1 for r in syn if not r['reqid'])}, missing msgid: {sum(1 for r in syn if not r['msgid'])})")
print(f"[Q5] all-zero usage records : {len(zero)}")
c = collections.Counter((r["model"], bool(r["msgid"]), bool(r["reqid"])) for r in zero)
for k, n in c.most_common(10):
    print(f"    n={n:5d} model={k[0]!r} has_msgid={k[1]} has_reqid={k[2]}")

# ---- Q1: cross-tab ---------------------------------------------------------
both = [r for r in rows if r["msgid"] and r["reqid"]]
m2r = collections.defaultdict(set)
r2m = collections.defaultdict(set)
for r in both:
    m2r[r["msgid"]].add(r["reqid"])
    r2m[r["reqid"]].add(r["msgid"])

print(f"\n[Q1] records with BOTH keys: {len(both)}")
print(f"[Q1] distinct message.id : {len(m2r)}")
print(f"[Q1] distinct requestId  : {len(r2m)}")
multi_r = {k: v for k, v in m2r.items() if len(v) > 1}
multi_m = {k: v for k, v in r2m.items() if len(v) > 1}
print(f"[Q1] message.id spanning >1 requestId : {len(multi_r)}")
for k, v in list(multi_r.items())[:20]:
    print(f"    {k} -> {sorted(v)}")
print(f"[Q1] requestId spanning >1 message.id : {len(multi_m)}")
for k, v in list(multi_m.items())[:20]:
    print(f"    {k} -> {sorted(v)}")

# are msgid/reqid unique across FILES too (i.e. same id in two transcripts)?
mfiles = collections.defaultdict(set)
rfiles = collections.defaultdict(set)
for r in both:
    mfiles[r["msgid"]].add(r["file"])
    rfiles[r["reqid"]].add(r["file"])
print(f"[Q1] message.id appearing in >1 FILE : {sum(1 for v in mfiles.values() if len(v) > 1)}")
print(f"[Q1] requestId  appearing in >1 FILE : {sum(1 for v in rfiles.values() if len(v) > 1)}")
for k, v in list((k, v) for k, v in mfiles.items() if len(v) > 1)[:10]:
    print(f"    msgid {k} in {sorted(v)}")
for k, v in list((k, v) for k, v in rfiles.items() if len(v) > 1)[:10]:
    print(f"    reqid {k} in {sorted(v)}")

json.dump(rows, open(sys.argv[1] if len(sys.argv) > 1 else "/tmp/rows.json", "w"))
print(f"\nrows dumped -> {sys.argv[1] if len(sys.argv)>1 else '/tmp/rows.json'}")
