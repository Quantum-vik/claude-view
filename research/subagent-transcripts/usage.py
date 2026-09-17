#!/usr/bin/env python3
"""Sum message.usage across a transcript JSONL. Prints per-field totals, the
assistant-turn count, the distinct requestIds and the model mix. Numbers and
ids only -- never message content."""
import json, sys, collections

FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens",
          "cache_creation_input_tokens"]

def sums(path):
    tot = collections.Counter()
    models = collections.Counter()
    reqids = set()
    turns = 0
    dedup_tot = collections.Counter()
    seen_req = set()
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            v = json.loads(line)
        except Exception:
            continue
        if v.get("type") != "assistant":
            continue
        u = (v.get("message") or {}).get("usage")
        if not isinstance(u, dict):
            continue
        turns += 1
        models[(v.get("message") or {}).get("model")] += 1
        rid = v.get("requestId")
        if rid:
            reqids.add(rid)
        for f in FIELDS:
            tot[f] += u.get(f, 0) or 0
        # de-duplicate by requestId: one API response can be split across
        # several assistant records (one per content block)
        if rid is None or rid not in seen_req:
            if rid:
                seen_req.add(rid)
            for f in FIELDS:
                dedup_tot[f] += u.get(f, 0) or 0
    return tot, dedup_tot, turns, reqids, models

def show(label, path):
    tot, dedup, turns, reqids, models = sums(path)
    print(f"--- {label}")
    print(f"    path={path}")
    print(f"    assistant records with usage: {turns}   distinct requestId: {len(reqids)}")
    print(f"    models: {dict(models)}")
    for f in FIELDS:
        print(f"    raw   {f:32s} {tot[f]:>10,}")
    print(f"    raw   {'TOTAL(in+cr+cc)':32s} {tot['input_tokens']+tot['cache_read_input_tokens']+tot['cache_creation_input_tokens']:>10,}")
    for f in FIELDS:
        print(f"    dedup {f:32s} {dedup[f]:>10,}")
    print(f"    dedup {'TOTAL(in+cr+cc)':32s} {dedup['input_tokens']+dedup['cache_read_input_tokens']+dedup['cache_creation_input_tokens']:>10,}")
    return reqids

if __name__ == "__main__":
    allsets = {}
    for p in sys.argv[1:]:
        allsets[p] = show(p.split("/")[-1], p)
    keys = list(allsets)
    for i in range(len(keys)):
        for j in range(i+1, len(keys)):
            a, b = keys[i], keys[j]
            inter = allsets[a] & allsets[b]
            print(f"requestId overlap {a.split('/')[-1]} vs {b.split('/')[-1]}: {len(inter)}")
