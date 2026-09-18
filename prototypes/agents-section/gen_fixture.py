#!/usr/bin/env python3
"""Regenerate fixture.json from a REAL local session that spawned agent runs.

The fixture is deliberately NOT committed: it carries real session content.
Run this to rebuild it locally, then `python3 build.py`.

Picks the session with the most agent runs, so the variants are judged at the
density that actually hurts — not against two tidy rows.
"""

import os, re, json, glob, datetime as dt

root = os.path.expanduser("~/.claude/projects")
HOME = os.path.expanduser("~")

# ── pricing: mirrors src/pricing.ts (AS_OF 2026-09-18) ────────────────────────
PRICES = {
    "opus-5":     dict(input=5, w5=6.25, w1h=10, read=0.5, output=25),
    "opus-4-8":   dict(input=5, w5=6.25, w1h=10, read=0.5, output=25),
    "opus-4-5":   dict(input=5, w5=6.25, w1h=10, read=0.5, output=25),
    "sonnet-5":   dict(input=2, w5=2.5, w1h=4, read=0.2, output=10),
    "sonnet-4-5": dict(input=3, w5=3.75, w1h=6, read=0.3, output=15),
    "haiku-4-5":  dict(input=1, w5=1.25, w1h=2.0, read=0.1, output=5),
    "3-5-haiku":  dict(input=0.8, w5=1.0, w1h=1.6, read=0.08, output=4),
}

def normalize(mid):
    m = (mid or "").strip().lower()
    m = re.sub(r"^(?:[a-z]{2}\.)?anthropic\.", "", m)
    m = re.sub(r"@\d{8}$", "", m)
    m = re.sub(r"^claude-", "", m)
    m = re.sub(r"-\d{8}$", "", m)
    m = re.sub(r"-v\d+:\d+$", "", m)
    return m

def cost(model, u):
    """USD for one turn's usage split. None = unpriced (never 0.00)."""
    p = PRICES.get(normalize(model))
    if not p:
        return None
    return (u["input"] * p["input"] + u["cacheWrite5m"] * p["w5"] + u["cacheWrite1h"] * p["w1h"]
            + u["cacheRead"] * p["read"] + u["output"] * p["output"]) / 1_000_000

def redact(t):
    if not t: return t
    t = t.replace(HOME, "~")
    t = re.sub(r"\b[\w.+-]+@[\w-]+\.[\w.]+\b", "<email>", t)
    t = re.sub(r"\b(gh[pousr]_|sk-)[A-Za-z0-9_-]{6,}", "<token>", t)
    return t

def clip(t, n=400):
    t = redact(t or "")
    return t if len(t) <= n else t[:n] + f"\n… (+{len(t)-n} more chars)"

def ts(s):
    try: return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception: return None

# ── pick the session with the most agent runs ────────────────────────────────
best, best_n = None, 0
for meta_dir in glob.glob(os.path.join(root, "*", "*", "subagents")):
    n = len(glob.glob(os.path.join(meta_dir, "agent-*.jsonl")))
    if n > best_n:
        best_n, best = n, meta_dir
if not best:
    raise SystemExit("no session with agent runs found under ~/.claude/projects")
sess_dir = os.path.dirname(best)
parent_path = sess_dir + ".jsonl"
print(f"session: {os.path.basename(sess_dir)}  runs: {best_n}")

EMPTY = dict(input=0, cacheWrite5m=0, cacheWrite1h=0, cacheRead=0, output=0)

def fold(path):
    """Fold a transcript into per-turn usage, LAST-WINS on the dedup key.

    One JSONL line per content block, each repeating the same message.usage —
    summing them naively inflates 2.2x-3.3x. See issue #15.
    """
    turns, tools, models, first, last, tool_names = {}, 0, {}, None, None, {}
    results = set()
    for line in open(path, errors="replace"):
        try: v = json.loads(line)
        except Exception: continue
        if v.get("timestamp"):
            first = first or v["timestamp"]; last = v["timestamp"]
        m = v.get("message") or {}
        c = m.get("content")
        if isinstance(c, list):
            for b in c:
                if not isinstance(b, dict): continue
                if b.get("type") == "tool_use":
                    tools += 1
                    tool_names[b.get("name", "?")] = tool_names.get(b.get("name", "?"), 0) + 1
                if b.get("type") == "tool_result":
                    results.add(b.get("tool_use_id"))
        u = m.get("usage")
        if u:
            key = v.get("requestId") or m.get("id") or v.get("uuid")
            cc = u.get("cache_creation") or {}
            w5 = cc.get("ephemeral_5m_input_tokens")
            w1h = cc.get("ephemeral_1h_input_tokens")
            if w5 is None and w1h is None:      # no split -> assume the cheaper bucket
                w5, w1h = u.get("cache_creation_input_tokens", 0), 0
            turns[key] = dict(
                model=m.get("model"),
                usage=dict(input=u.get("input_tokens", 0), cacheWrite5m=w5 or 0,
                           cacheWrite1h=w1h or 0, cacheRead=u.get("cache_read_input_tokens", 0),
                           output=u.get("output_tokens", 0)))
            if m.get("model"): models[m["model"]] = models.get(m["model"], 0) + 1
    return turns, tools, models, first, last, tool_names, results

def totals(turns):
    tot = dict(EMPTY); usd = 0.0; unpriced = 0
    for t in turns.values():
        for k in tot: tot[k] += t["usage"][k]
        c = cost(t["model"], t["usage"])
        if c is None: unpriced += 1
        else: usd += c
    return tot, usd, unpriced

pt, ptools, pmodels, pfirst, plast, ptoolnames, presults = fold(parent_path)
p_tot, p_usd, p_unpriced = totals(pt)

runs = []
for f in sorted(glob.glob(os.path.join(best, "agent-*.jsonl"))):
    meta = {}
    mp = f.replace(".jsonl", ".meta.json")
    if os.path.exists(mp):
        try: meta = json.load(open(mp))
        except Exception: pass
    t, tools, models, first, last, tool_names, _ = fold(f)
    tot, usd, unpriced = totals(t)
    a, b = ts(first), ts(last)
    tool_use_id = meta.get("toolUseId")
    runs.append(dict(
        id=os.path.basename(f)[len("agent-"):-len(".jsonl")],
        type=meta.get("agentType"),
        description=redact(meta.get("description")),
        depth=meta.get("spawnDepth", 1),
        parentAgentId=meta.get("parentAgentId"),
        toolUseId=tool_use_id,
        # A run is finished when the PARENT holds a result for its task call.
        # That is the only exact signal today; issue #23 decides the real model.
        status=("done" if tool_use_id in presults else "running"),
        models=sorted(models, key=models.get, reverse=True),
        model=max(models, key=models.get) if models else None,
        turns=len(t), tools=tools, toolNames=tool_names,
        startedAt=first, endedAt=last,
        durationSec=round((b - a).total_seconds()) if a and b else None,
        usage=tot, cost=None if unpriced else round(usd, 4), unpriced=unpriced,
    ))

runs.sort(key=lambda r: r["startedAt"] or "")

# parent-only = the whole parent transcript's ledger; runs are separate files.
sess_usd = p_usd + sum(r["cost"] or 0 for r in runs)
for r in runs:
    r["share"] = round((r["cost"] or 0) / sess_usd, 4) if sess_usd else 0

# ── a real slice of the trace, so the inline variants have something to sit in ─
def slice_entries(path, agent, cap):
    out = []
    for line in open(path, errors="replace"):
        if len(out) >= cap: break
        try: v = json.loads(line)
        except Exception: continue
        m = v.get("message") or {}
        c = m.get("content"); at = v.get("timestamp")
        if isinstance(c, str) and v.get("type") == "user" and not v.get("isMeta"):
            out.append(dict(kind="prompt", text=clip(c), agent=agent, at=at))
        if not isinstance(c, list): continue
        for b in c:
            if not isinstance(b, dict): continue
            if b.get("type") == "text" and b.get("text", "").strip():
                out.append(dict(kind="assistant", text=clip(b["text"]), agent=agent, at=at))
            elif b.get("type") == "thinking" and b.get("thinking", "").strip():
                out.append(dict(kind="thinking", text=clip(b["thinking"], 300), agent=agent, at=at))
            elif b.get("type") == "tool_use":
                inp = b.get("input") or {}
                label = inp.get("command") or inp.get("file_path") or inp.get("pattern") \
                        or inp.get("description") or inp.get("prompt") or ""
                out.append(dict(kind="tool", tool=b.get("name"), text=clip(str(label), 160),
                                agent=agent, at=at))
    return out

trace = slice_entries(parent_path, None, 14)
for r in runs[:3]:
    trace += slice_entries(os.path.join(best, f"agent-{r['id']}.jsonl"), r["id"], 8)
trace += slice_entries(parent_path, None, 4)

fixture = dict(
    session=dict(
        id=os.path.basename(sess_dir),
        cwd=redact(os.path.basename(os.path.dirname(sess_dir)).replace("-", "/")),
        cost=round(sess_usd, 2), parentCost=round(p_usd, 2),
        parentTurns=len(pt), parentTools=ptools,
        runCost=round(sum(r["cost"] or 0 for r in runs), 2),
        runShare=round(sum(r["cost"] or 0 for r in runs) / sess_usd, 3) if sess_usd else 0,
        model=max(pmodels, key=pmodels.get) if pmodels else None,
        startedAt=pfirst, endedAt=plast,
    ),
    runs=runs, trace=trace,
)
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixture.json"), "w").write(
    json.dumps(fixture, indent=1))
print(f"runs {len(runs)}  session ${sess_usd:.2f}  "
      f"(parent ${p_usd:.2f} + runs ${sess_usd - p_usd:.2f} = {fixture['session']['runShare']:.0%} agents)")
print(f"trace entries {len(trace)}")
