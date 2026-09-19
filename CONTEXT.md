# claude-view

A desktop window onto a Claude Code session. The terminal is one half; the **panel**
beside it is the readable, costed record of everything the session did — so the
terminal can be collapsed without losing anything.

## Language

### The session

**Session**:
One Claude Code conversation, from first prompt to exit. claude-view opens one
window per session.
_Avoid_: conversation, chat, thread

**Turn**:
One request to the model and the reply it produced, including any thinking and
tool calls inside that reply. The unit cost is charged against — never a tool call.
_Avoid_: message, exchange, round

**Replay**:
The earlier turns a resumed session rewrites verbatim into its new record. The same
turn existing in two places is a replay, not two turns, and must be counted once.
_Avoid_: duplicate, copy

**Hosted session**:
A session claude-view launched itself. It has a process behind it, so it can be
typed into, resized and closed.
_Avoid_: our session, local session

**Watched session**:
A session claude-view did not launch — started in a terminal — shown read-only
from its transcript. It has no process behind it, so there is nothing to type
into and nothing to resize; read-only by construction, not by policy, exactly as
an agent run's window already is.
_Avoid_: attached, mirrored, remote session

**Live**:
Claimed only where it is known. A hosted session is live while its process runs.
A watched session is live only as far as its transcript says so — a file that
stopped growing may have ended, crashed, or be thinking. The panel says "no
longer live", never "ended", because the second is not knowable from disk.
_Avoid_: running, active, ended (for a watched session)

### Agents

**Agent run**:
One spawned execution of a subagent: its own record, its own context window, its own
model and its own cost. **The unit of the Agents section** — two runs of the same
agent type are two runs, never one.
_Avoid_: agent, child session, task. "Subagent" is fine in prose but never in a
count or a row label, where it reads as the type just as easily as the run.

**Agent type**:
The configuration a run is spawned as — `general-purpose`, `claude-code-guide`, and
the rest. A property of a run, never a thing that itself runs or costs money.
_Avoid_: agent, agent name, persona

**Task call**:
The parent's tool call that spawns an agent run, and the only exact link between the
two. A run that has one is nested under it; a run whose task call has no result yet
is still running.
_Avoid_: spawn, Task, invocation

**Depth**:
How many agent runs deep a run sits. A run spawned by the parent session is depth 1;
one spawned by another run is depth 2. Depth is a property of the run, not of where
its record is stored — records stay flat however deep the nesting goes.
_Avoid_: nesting level, generation

### What changed

**Baseline**:
The commit a session's changes are measured from — HEAD as it stood when the
session started. Not "the last commit": nine commits can land during one evening,
and measuring from the newest would show almost nothing.
_Avoid_: base, starting point, HEAD

**Changed during the session**:
A file that differs from the baseline while the session was open. Deliberately
says nothing about *who* changed it — git cannot separate the model's edits from
the user's, and claiming otherwise would assert what the data cannot support.
_Avoid_: Claude's changes, edited by the agent, authored

**Commit span**:
The unit a session's changes drill down to — the files and lines carried by one
commit made during the session. Chosen over the turn because commits already
exist in git history: they cost nothing to find and work for past sessions,
where a per-turn capture would have to be recorded live and never could be.
A session that makes no commits has no spans, and says so.
_Avoid_: per-turn diff, turn diff, snapshot

### The panel

**Trace**:
The flat, ordered stream of everything the session produced — prompts, replies,
thinking, tool calls and their results — parent and agent runs alike.
_Avoid_: log, history, feed

**Command log**:
The panel's card-per-tool-call view. Older and narrower than the trace, which carries
every kind rather than only tool calls.
_Avoid_: timeline (the code still says `Timeline`; the word is being retired)

**Persisted output**:
The full, untruncated result of a tool call, written to disk. The terminal shows an
abbreviation of it; the panel can show all of it.
_Avoid_: full output, raw output

**Notional cost**:
What a session would have cost at published API rates, derived from a dated price
table. On a subscription no money moved, so the figure is always labelled as
notional and never presented as a bill.
_Avoid_: cost, spend, price (unqualified)

**Unpriced**:
A model the price table doesn't know. Its tokens are counted and its dollars are
withheld — never guessed from a neighbouring model, never shown as `$0.00`.
_Avoid_: unknown, missing
