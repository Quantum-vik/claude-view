#!/usr/bin/env python3
"""Is `message.usage` really IDENTICAL on every record of one message.id?
Splits input-side vs output-side, and checks whether last == max."""
import json, collections

rows = json.load(open("rows.json"))
bym = collections.defaultdict(list)
for r in rows:
    if r["msgid"]:
        bym[(r["file"], r["msgid"])].append(r)
for v in bym.values():
    v.sort(key=lambda r: (r["lineno"]))

n_multi = sum(1 for v in bym.values() if len(v) > 1)
in_diff = out_diff = 0
last_is_max_out = last_is_max_in = 0
last_not_max_out = []
zero_ish_first = collections.Counter()
per_file_outdiff = collections.Counter()
for k, v in bym.items():
    ins = {(r["inp"], r["cr"], r["cc"]) for r in v}
    outs = [r["out"] for r in v]
    if len(ins) > 1:
        in_diff += 1
    if len(set(outs)) > 1:
        out_diff += 1
        per_file_outdiff[k[0]] += 1
        if outs[-1] == max(outs):
            last_is_max_out += 1
        else:
            last_not_max_out.append((k[1], outs))

print(f"message.id groups          : {len(bym)}   (with >1 record: {n_multi})")
print(f"  input side differs within : {in_diff}")
print(f"  output side differs within: {out_diff}")
print(f"  of those, LAST record has the max output_tokens: {last_is_max_out}/{out_diff}")
print(f"  counter-examples (last != max): {len(last_not_max_out)}")
for k, o in last_not_max_out[:10]:
    print(f"     {k} outputs in file order = {o}")
print(f"\n  by file:")
for f, n in per_file_outdiff.most_common():
    tot = len({k[1] for k in bym if k[0] == f})
    print(f"     {n:5d}/{tot:5d}  {f}")

# how big is the error if you take FIRST instead of LAST?
tot_last = tot_first = tot_max = tot_sum = 0
for v in bym.values():
    tot_last += v[-1]["out"]; tot_first += v[0]["out"]; tot_max += max(r["out"] for r in v); tot_sum += sum(r["out"] for r in v)
print(f"\noutput_tokens across the whole corpus, deduped by message.id:")
print(f"  take LAST record  : {tot_last:,}")
print(f"  take MAX record   : {tot_max:,}   (last==max overall: {tot_last==tot_max})")
print(f"  take FIRST record : {tot_first:,}   ({tot_first/tot_last:.4f}x of LAST -- undercount {100*(1-tot_first/tot_last):.1f}%)")
print(f"  naive SUM (today) : {tot_sum:,}   ({tot_sum/tot_last:.4f}x)")

# input side too
il = sum(v[-1]["inp"]+v[-1]["cr"]+v[-1]["cc"] for v in bym.values())
isum = sum(r["inp"]+r["cr"]+r["cc"] for v in bym.values() for r in v)
print(f"\ninput-side tokens (input+cache_read+cache_creation):")
print(f"  deduped (last per message.id): {il:,}")
print(f"  naive SUM (today)            : {isum:,}   ({isum/il:.4f}x)")

# does the SAME hold when grouped by requestId?
byr = collections.defaultdict(list)
for r in rows:
    if r["reqid"]:
        byr[(r["file"], r["reqid"])].append(r)
for v in byr.values():
    v.sort(key=lambda r: r["lineno"])
rl = sum(v[-1]["inp"]+v[-1]["cr"]+v[-1]["cc"] for v in byr.values())
rlo = sum(v[-1]["out"] for v in byr.values())
print(f"\nsame, grouped by requestId: input {rl:,}  output {rlo:,}   groups={len(byr)}")
print(f"  identical to message.id grouping? input={rl==il} output={rlo==tot_last}")
