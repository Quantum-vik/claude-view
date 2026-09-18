#!/usr/bin/env python3
"""Fixtures for the rail prototype (issue #29), from REAL local transcripts.

Emits three: a multi-agent session at full length, the same truncated to a
handful of turns, and a single-turn session — the two ends the rail has to
survive, plus the middle.

fixture.json is NOT committed: it carries real session content.
"""
import os, re, json, glob, datetime as dt

root = os.path.expanduser("~/.claude/projects")
HOME = os.path.expanduser("~")

def redact(t):
    if not t: return t
    t = t.replace(HOME, "~")
    t = re.sub(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b", "<email>", t)
    t = re.sub(r"\b(gh[pousr]_|sk-)[A-Za-z0-9_-]{6,}", "<token>", t)
    return t

def clip(t, n=150):
    t = redact(str(t or ""))
    return t if len(t) <= n else t[:n] + "…"

def ms(s):
    try: return int(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception: return 0

def read_session(parent):
    """Entries in file order + the runs, with the fork/rejoin links the rail needs."""
    runs = []
    subdir = parent[:-6] + "/subagents"
    for f in sorted(glob.glob(subdir + "/agent-*.jsonl")):
        meta = {}
        mp = f.replace(".jsonl", ".meta.json")
        if os.path.exists(mp):
            try: meta = json.load(open(mp))
            except Exception: pass
        first = last = 0; tools = 0
        for ln in open(f, errors="replace"):
            try: v = json.loads(ln)
            except Exception: continue
            t = ms(v.get("timestamp") or "")
            if t: first = first or t; last = max(last, t)
            c = (v.get("message") or {}).get("content")
            if isinstance(c, list):
                tools += sum(1 for b in c if isinstance(b, dict) and b.get("type") == "tool_use")
        runs.append(dict(
            id=os.path.basename(f)[6:-6],
            type=meta.get("agentType"), description=redact(meta.get("description")),
            toolUseId=meta.get("toolUseId"), depth=meta.get("spawnDepth", 1),
            startedAt=first, endedAt=last, tools=tools,
        ))

    entries, turns = [], {}
    def scan(path, agent):
        for ln in open(path, errors="replace"):
            try: v = json.loads(ln)
            except Exception: continue
            m = v.get("message") or {}
            at = ms(v.get("timestamp") or "")
            rid = v.get("requestId") or m.get("id") or v.get("uuid")
            u = m.get("usage")
            if u and rid:
                cc = u.get("cache_creation") or {}
                turns[rid] = dict(
                    model=m.get("model"),
                    input=u.get("input_tokens", 0), cacheRead=u.get("cache_read_input_tokens", 0),
                    w5=cc.get("ephemeral_5m_input_tokens", 0) or u.get("cache_creation_input_tokens", 0),
                    w1h=cc.get("ephemeral_1h_input_tokens", 0), output=u.get("output_tokens", 0))
            c = m.get("content")
            if isinstance(c, str) and v.get("type") == "user" and not v.get("isMeta"):
                entries.append(dict(kind="prompt", text=clip(c, 220), ts=at, turnId=rid, agent=agent))
            if not isinstance(c, list): continue
            for b in c:
                if not isinstance(b, dict): continue
                if b.get("type") == "text" and b.get("text", "").strip():
                    entries.append(dict(kind="assistant", text=clip(b["text"], 260), ts=at, turnId=rid, agent=agent))
                elif b.get("type") == "thinking" and b.get("thinking", "").strip():
                    entries.append(dict(kind="thinking", text=clip(b["thinking"], 160), ts=at, turnId=rid, agent=agent))
                elif b.get("type") == "tool_use":
                    inp = b.get("input") or {}
                    lab = inp.get("command") or inp.get("file_path") or inp.get("pattern") or inp.get("description") or ""
                    entries.append(dict(kind="tool", tool=b.get("name"), text=clip(lab, 130),
                                        ts=at, turnId=rid, agent=agent, toolUseId=b.get("id")))
                elif b.get("type") == "tool_result":
                    entries.append(dict(kind="result", ts=at, agent=agent,
                                        toolUseId=b.get("tool_use_id"), isError=bool(b.get("is_error"))))
    scan(parent, None)
    for r in runs:
        scan(os.path.join(parent[:-6], "subagents", f"agent-{r['id']}.jsonl"), r["id"])
    return entries, turns, runs

# pick: the session with the most runs, and the smallest real session
cands = []
for p in glob.glob(root + "/*/*.jsonl"):
    sub = p[:-6] + "/subagents"
    n = len(glob.glob(sub + "/agent-*.jsonl")) if os.path.isdir(sub) else 0
    cands.append((n, os.path.getsize(p), p))
cands.sort(key=lambda c: (-c[0], -c[1]))
big = cands[0][2]
small = min((c for c in cands if c[1] > 20_000), key=lambda c: c[1])[2]

out = {}
e, t, r = read_session(big)
out["multi"] = dict(entries=e[:900], turns=t, runs=r, label=f"{len(r)} runs, {len(t)} turns")
out["short"] = dict(entries=e[:40], turns=t, runs=r[:2], label="short — first 40 entries")
e2, t2, r2 = read_session(small)
out["single"] = dict(entries=e2[:24], turns=t2, runs=r2, label=f"small session, {len(r2)} runs")

# A window centred on where the runs actually are — the rail's whole argument is
# never visible at the top of a session.
first_agent = next((i for i, x in enumerate(e) if x.get("agent")), 0)
lo = max(0, first_agent - 14)
out["runs"] = dict(entries=e[lo:lo + 90], turns=t, runs=r,
                   label=f"at the fork (entry {lo}) — {len(r)} runs")

here = os.path.dirname(os.path.abspath(__file__))
open(os.path.join(here, "fixture.json"), "w").write(json.dumps(out))
for k, v in out.items():
    print(f"  {k:<7} {len(v['entries']):>4} entries  {len(v['runs']):>2} runs  {v['label']}")
