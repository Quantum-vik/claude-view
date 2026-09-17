#!/usr/bin/env python3
"""Reference implementation of the proposed discovery + linkage rule.

Given a session id and its project dir, enumerate that session's subagents and
rebuild the spawn tree WITHOUT any timestamp heuristics:

  <project>/<session-id>/subagents/agent-<agentId>.jsonl      transcript
  <project>/<session-id>/subagents/agent-<agentId>.meta.json   sidecar

  sidecar.toolUseId     -> the Agent/Task tool_use id that spawned it
  sidecar.parentAgentId -> present iff spawnDepth > 1; the spawning agent
  sidecar.spawnDepth    -> 1 for children of the session itself

Prints ids, depths and token sums only; no message content.
Usage: tree.py <project-dir> <session-id>
"""
import json, os, sys, collections

F=["input_tokens","output_tokens","cache_read_input_tokens","cache_creation_input_tokens"]

def usage(path):
    tot=collections.Counter(); seen=set()
    for l in open(path,encoding="utf-8",errors="replace"):
        l=l.strip()
        if not l: continue
        try: v=json.loads(l)
        except Exception: continue
        if v.get("type")!="assistant": continue
        u=(v.get("message") or {}).get("usage")
        if not isinstance(u,dict): continue
        rid=v.get("requestId") or (v.get("message") or {}).get("id")
        if rid in seen: continue
        seen.add(rid)
        for f in F: tot[f]+=u.get(f,0) or 0
    tot["requests"]=len(seen)
    return tot

proj, sid = sys.argv[1], sys.argv[2]
parent = os.path.join(proj, sid + ".jsonl")
subdir = os.path.join(proj, sid, "subagents")

agents={}
if os.path.isdir(subdir):
    for fn in os.listdir(subdir):
        if not fn.startswith("agent-") or not fn.endswith(".meta.json"): continue
        aid = fn[len("agent-"):-len(".meta.json")]
        meta = json.load(open(os.path.join(subdir, fn)))
        tr = os.path.join(subdir, f"agent-{aid}.jsonl")
        agents[aid] = dict(meta=meta, path=tr,
                           usage=usage(tr) if os.path.exists(tr) else collections.Counter())

kids = collections.defaultdict(list)
for aid,a in agents.items():
    kids[a["meta"].get("parentAgentId")].append(aid)   # None => child of the session

def show(aid, indent):
    a=agents[aid]; m=a["meta"]; u=a["usage"]
    tin=u["input_tokens"]+u["cache_read_input_tokens"]+u["cache_creation_input_tokens"]
    print(f"{'  '*indent}+- agent-{aid}  depth={m.get('spawnDepth')} type={m.get('agentType')} "
          f"model={m.get('model','(inherited)')}")
    print(f"{'  '*indent}   spawned by tool_use {m.get('toolUseId')}"
          + (f" in agent-{m['parentAgentId']}" if m.get("parentAgentId") else " in the session transcript"))
    print(f"{'  '*indent}   requests={u['requests']} input-side={tin:,} output={u['output_tokens']:,}")
    for k in sorted(kids.get(aid,[])): show(k, indent+1)

pu = usage(parent)
ptin = pu["input_tokens"]+pu["cache_read_input_tokens"]+pu["cache_creation_input_tokens"]
print(f"session {sid}  requests={pu['requests']} input-side={ptin:,} output={pu['output_tokens']:,}")
for aid in sorted(kids.get(None,[])): show(aid, 1)

tot=collections.Counter()
for a in agents.values():
    for f in F: tot[f]+=a["usage"][f]
ctin=tot["input_tokens"]+tot["cache_read_input_tokens"]+tot["cache_creation_input_tokens"]
print(f"\nsubagents ({len(agents)}): input-side={ctin:,} output={tot['output_tokens']:,}")
print(f"SESSION TRUE TOTAL: input-side={ptin+ctin:,} output={pu['output_tokens']+tot['output_tokens']:,}")
