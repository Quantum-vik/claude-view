#!/usr/bin/env python3
"""Regenerate fixture.json from a REAL local transcript (redacted).

The fixture is deliberately NOT committed: it contains real session content.
Run this to rebuild it locally, then `python3 build.py`.
"""

import os, json, glob, re

root = os.path.expanduser("~/.claude/projects")
cands = sorted(glob.glob(os.path.join(root, "*", "*.jsonl")), key=os.path.getsize, reverse=True)
target = next((p for p in cands if os.path.isdir(os.path.join(p[:-6], "subagents"))), cands[0])
HOME = os.path.expanduser("~")

def redact(t):
    if not t: return t
    t = t.replace(HOME, "~")
    t = re.sub(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b", "<email>", t)
    t = re.sub(r"\b(gh[pousr]_|sk-)[A-Za-z0-9_-]{6,}", "<token>", t)
    return t

def clip(t, n=600):
    t = redact(t or "")
    return t if len(t) <= n else t[:n] + f"\n… (+{len(t)-n} more chars)"

entries, turns, seq = [], {}, 0

def load(path, agent=None, cap=None):
    global seq
    n = 0
    with open(path, errors="replace") as f:
        for line in f:
            try: v = json.loads(line)
            except Exception: continue
            msg = v.get("message") or {}
            rid = v.get("requestId") or msg.get("id") or v.get("uuid")
            ts = v.get("timestamp")
            if v.get("type") == "assistant":
                u = msg.get("usage")
                if u and rid:
                    cc = u.get("cache_creation") or {}
                    turns[rid] = {"turnId": rid, "model": msg.get("model"), "agent": agent,
                        "usage": {"input": u.get("input_tokens", 0),
                                  "cacheRead": u.get("cache_read_input_tokens", 0),
                                  "cacheWrite5m": cc.get("ephemeral_5m_input_tokens", 0),
                                  "cacheWrite1h": cc.get("ephemeral_1h_input_tokens", 0),
                                  "output": u.get("output_tokens", 0)}}
            if cap and n >= cap: continue
            c = msg.get("content")
            if isinstance(c, str) and v.get("type") == "user" and not v.get("isMeta"):
                seq += 1; n += 1
                entries.append({"seq": seq, "kind": "prompt", "turnId": rid, "ts": ts,
                                "agent": agent, "text": clip(c, 400)})
            if not isinstance(c, list): continue
            for b in c:
                if not isinstance(b, dict): continue
                t = b.get("type")
                if t == "text" and b.get("text", "").strip():
                    seq += 1; n += 1
                    entries.append({"seq": seq, "kind": "assistant", "turnId": rid, "ts": ts,
                                    "agent": agent, "text": clip(b["text"], 700)})
                elif t == "thinking" and b.get("thinking", "").strip():
                    seq += 1; n += 1
                    entries.append({"seq": seq, "kind": "thinking", "turnId": rid, "ts": ts,
                                    "agent": agent, "text": clip(b["thinking"], 500)})
                elif t == "tool_use":
                    inp = b.get("input") or {}
                    d = (inp.get("command") or inp.get("file_path") or inp.get("pattern")
                         or inp.get("description") or inp.get("prompt") or "")
                    seq += 1; n += 1
                    entries.append({"seq": seq, "kind": "tool", "turnId": rid, "ts": ts, "agent": agent,
                                    "id": b.get("id"), "tool": b.get("name"),
                                    "input": clip(str(d), 200), "status": "success"})
                elif t == "tool_result":
                    tid = b.get("tool_use_id")
                    cont = b.get("content")
                    if isinstance(cont, list):
                        cont = "\n".join(x.get("text", "") for x in cont if isinstance(x, dict))
                    for e in reversed(entries):
                        if e.get("id") == tid:
                            e["output"] = clip(cont if isinstance(cont, str) else "", 900)
                            if b.get("is_error"): e["status"] = "error"
                            break

load(target, cap=260)
for sp in sorted(glob.glob(os.path.join(target[:-6], "subagents", "agent-*.jsonl"))):
    aid = os.path.basename(sp)[6:-6]
    meta = {}
    mp = sp.replace(".jsonl", ".meta.json")
    if os.path.exists(mp):
        try: meta = json.load(open(mp))
        except Exception: pass
    load(sp, {"agentId": aid, "toolUseId": meta.get("toolUseId"),
              "agentType": meta.get("agentType"),
              "description": redact(meta.get("description") or "")}, cap=40)

json.dump({"entries": entries, "turns": list(turns.values())}, open("fixture.json", "w"), indent=0)
print(f"fixture.json: {len(entries)} entries, {len(turns)} turns  (source: {os.path.basename(target)})")
