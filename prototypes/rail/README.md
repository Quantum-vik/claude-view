# Prototype: the rail (issue #29)

Throwaway. Answers "does the rail earn its ink?"

    python3 gen_fixture.py   # three windows from a REAL local transcript, redacted
    python3 build.py
    xdg-open index.html      # ?f=single|short|runs|multi

`fixture.json` and `index.html` are gitignored: they carry real session content.

## Verdict: partially — two of the four things it carries do not survive real data

| element | verdict |
|---|---|
| spine + weighted turn tick | **keep** — 3 steps, readable |
| sparse time | **keep** — the clearest win in the prototype |
| error notch | **keep** |
| fork / lane / rejoin | **keep**, but it only reads *locally* |
| folio ordinal | **cut** — a numbered tick every **1.4 rows** |
| concurrency tick | **cut** — structurally cannot work; see below |

The concurrency tick was the rail's headline justification. It fails because the backend returns
the parent transcript in full and *then* each subagent file — `trace.rs` refuses to interleave by
timestamp on purpose. So a tick and the run it refers to are never on screen together:

```
multi  (first 900 entries)   40 parent rows overlap a live run    0 rows belong to a run
runs   (window at the fork)   0 parent rows overlap a live run   40 rows belong to a run
```
