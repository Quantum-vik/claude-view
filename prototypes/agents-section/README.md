# Prototype: the Agents section (issue #22)

Throwaway. Answers "where does the Agents section live, and what does one row show?"

    python3 gen_fixture.py   # builds fixture.json from a real local session, redacted
    python3 build.py         # inlines it into index.html
    xdg-open index.html      # ← / → or the bottom bar switches variants

Three variants on `?variant=`, mounted inside the real panel shell so each is judged
against the app's own density rather than in a vacuum:

| | | verdict |
|---|---|---|
| **A** | Roster — a third tab | **won** the overview |
| **B** | Band — a strip above the trace | rejected: overflows at 11 runs |
| **C** | Spine — gutter + inline headers | **header won**, gutter rejected |

`fixture.json` and `index.html` are gitignored: they carry real session content.
The generator and the template are the committed artifacts, so anyone can rebuild.

## What the fixture is

The session with the most agent runs on the machine — 11 runs, $164.12 notional,
of which $21.47 (13.1%) is the runs. `gen_fixture.py` reimplements the turn fold
(last-wins on `requestId` → `message.id` → `uuid`) and `src/pricing.ts` in Python,
independently of the Rust ledger — and lands on **$164.12**, the same figure
`UsageLedger` produces. Two separate code paths agreeing is the point.

One run is forced to `running` in the UI so live status can be judged. It is
labelled `DEMO` everywhere it appears; the fixture itself is all-finished.
