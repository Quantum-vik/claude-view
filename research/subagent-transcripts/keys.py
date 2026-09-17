#!/usr/bin/env python3
"""Enumerate the top-level key set + notable field values across a JSONL transcript.
Structure only: prints key names, types and small scalar values. No message bodies."""
import json, sys, collections

def scan(path):
    keys = collections.Counter()
    types = collections.Counter()
    sidechain = collections.Counter()
    agentids = collections.Counter()
    sessionids = collections.Counter()
    subtypes = collections.Counter()
    n = 0
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            v = json.loads(line)
        except Exception:
            continue
        n += 1
        for k in v:
            keys[k] += 1
        types[v.get("type")] += 1
        sidechain[str(v.get("isSidechain"))] += 1
        if "agentId" in v:
            agentids[v["agentId"]] += 1
        if "sessionId" in v:
            sessionids[v["sessionId"]] += 1
        if v.get("type") == "system":
            subtypes[v.get("subtype")] += 1
    print(f"lines={n}")
    print("top-level keys:", dict(keys))
    print("type:", dict(types))
    print("isSidechain:", dict(sidechain))
    print("agentId:", dict(agentids))
    print("sessionId:", dict(sessionids))
    if subtypes:
        print("system subtype:", dict(subtypes))

for p in sys.argv[1:]:
    print("=== " + p)
    scan(p)
