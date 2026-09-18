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
