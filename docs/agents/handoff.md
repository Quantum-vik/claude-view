# Handoff — claude-view

**Written** 2026-09-18 ·
**Remote** https://github.com/Quantum-vik/claude-view (public)
**HEAD** `a94494a`, pushed, working tree clean, 128 Rust tests green, `tsc` clean.
**Released** v1.4.1, published and **confirmed installed** (`claude-view-bin 1.4.1-1`).

---

## Read these first, in this order

Everything of substance is already written down somewhere durable. Do not re-derive it.

| What | Where |
|---|---|
| Domain vocabulary — **read before naming anything** | `CONTEXT.md` |
| The frontend revamp plan (token system, chunks, open questions) | `docs/design/frontend-revamp-plan.md` on branch `design/frontend-revamp` |
| Three wayfinder maps, all still open | issues [#11](https://github.com/Quantum-vik/claude-view/issues/11), [#19](https://github.com/Quantum-vik/claude-view/issues/19), [#26](https://github.com/Quantum-vik/claude-view/issues/26) |
| Every decision with its evidence | the resolution comment on each closed issue #12–#31 |
| Research findings | branches `research/run-termination`, `research/run-discovery`, `research/{dedup-key,live-output,pricing,subagent-transcripts}` |
| Prototypes (rebuildable from your own corpus) | `prototypes/{rail,agents-section,panel-full-width}/` |

**All numbered tickets are closed.** Only the three map issues remain open.

---

## Release state — nothing is pending

**v1.4.1 is out, installed and verified.** It carries one fix, `2ce0760`: the Stream used to
preserve the *pixel offset* when a session ended and the order reversed, silently moving the reader
to a different part of the session. It now preserves the *row*.

Verified by measurement, not assertion — a 326-row fixture, `live` flipped true → false:

| | scrollTop | top row |
|---|---|---|
| before (live, newest-first) | 19336 | `r-21564263-` @ -1035 |
| after (ended, oldest-first) | **24522** | `r-21564263-` @ **-1035** |
| control — old pixel-preserving behaviour | 19336 | `r-20631364-` @ -177 |

The control line is the proof: at the old scrollTop the reader lands on a different entry.
Also confirmed: the banner renders on a flip, and does **not** render when the session was already
over at mount.

**The install landed this time.** Earlier in the session a `pacman -U` silently did not take.
Check it properly — `pacman -Q claude-view-bin` for the package, and `/proc/<pid>/exe` for the
running instance, which keeps the old inode (shown as `(deleted)`) until the app is restarted.

`main` is one commit ahead of the `v1.4.1` tag (`a94494a`, a `.gitignore` rule). That is
deliberate and does not need a release.

Release procedure, which has worked five times: bump the version in `package.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and both
`packaging/*/PKGBUILD`; build with `npm run tauri build -- --bundles deb` then
`cd packaging/arch-bin && makepkg -f`; verify; tag; `gh release create`. Budget ~4 minutes for the
Rust compile — run it with `run_in_background`. `dpkg-deb` does not exist on this machine; read deb
metadata with `ar x` + `tar xf control.tar.gz`.

**Installing is the user's job** — `sudo` needs a password. Hand them the `!` form:

```
! sudo pacman -U --noconfirm packaging/arch-bin/claude-view-bin-<ver>-1-x86_64.pkg.tar.zst
```

---

## Mistakes made this session — do not repeat them

1. **A publish gate that verified nothing.** It checked that a string from the deleted view was
   absent from the binary. That string is absent from *every* binary (the JS is compressed inside
   the Tauri asset bundle), so it passed on anything. It was reported to the user as real
   verification. **Any binary-level check must be proven to fail on a known-bad input first.**
2. **Committed real session content twice.** `prototypes/*/fixture.json` and `index.html` carry
   redacted-but-real transcripts. Each prototype has a `.gitignore`, but it was committed to the
   *prototype branch* rather than `main`, so `git add -A` on main swept them in. Both were caught
   before pushing. **Check `git status` output before committing anything under `prototypes/`.**
   Partly fixed since: `a94494a` puts the harness ignore rule on `main`, where every branch
   inherits it. The `prototypes/` gap is still unfixed.
3. **Measured with a broken clock.** `chromium --virtual-time-budget` quantises
   `performance.now()`; every chunk reported "10.0 ms" regardless of size. A second attempt was
   swamped by chromium's ~550 ms process launch. **If a measurement returns suspiciously uniform
   or backwards numbers, it is the instrument.**
4. **Recommended a fix from a web instinct that did not apply.** "709 kB bundle needs code
   splitting" is a web-deployment concern; this is a desktop app reading from local disk. See the
   long comment in `vite.config.ts`.
5. **`sed -i '1s/...'` overwrote a file's opening doc comment.** Anchor line-numbered edits on
   content, not position.
6. **A passing test built on a broken fixture.** Verifying the v1.4.1 reversal, the harness stub
   ignored `read_trace`'s `after` cursor and re-served the same page on every poll, so `useTrace`
   appended the same 400 entries ten times — 3260 rows, 326 distinct keys. With duplicate keys
   `querySelector` matches the first, so the control and the fix reported the identical row and the
   test "passed" while proving nothing. Caught only by counting distinct `data-row` values.
   **When stubbing a paging backend, advance the cursor or serve the page once; and assert on the
   fixture's shape before trusting a result computed from it.**

---

## Environment facts that cost time to learn

- **`hyprctl dispatch` does not work here.** This Hyprland routes dispatchers through a Lua API
  (`hl.dsp.*`); classic syntax errors out. Workspace switching was never solved. Window geometry
  and screenshots via `hyprctl clients -j` + `grim` do work.
- **`sudo` requires a password.** Ask the user to run privileged commands with the `!` prefix.
  Never collect their password — it would be written verbatim into the session transcript.
- **`CLAUDE_CODE_CHILD_SESSION` is inherited and disables transcript writing.** Always launch
  nested Claude Code with `env -u CLAUDE_CODE_CHILD_SESSION`. claude-view now strips it from its
  own PTY for the same reason.
- **UI verification pattern that works**, refined while verifying v1.4.1:
  a throwaway `src/dev-preview.tsx` + `preview.html` stubbing
  `window.__TAURI_INTERNALS__.invoke`, served by `npm run dev`, then run with
  `chromium --headless --virtual-time-budget=9000 --dump-dom`. Both paths are gitignored as of
  `a94494a`. Fixtures come from the opt-in `CV_DUMP_ROSTER=<path> cargo test dump_roster` and
  `CV_DUMP_TRACE=<path> cargo test dump_trace` (the latter's source path is hardcoded).
  Four things that make the difference:
  - **Make the harness self-driving.** No puppeteer or python websocket lib is installed here, so
    CDP is not worth the trouble. Have the page run the scenario itself and write results into a
    `<pre id="result">`, then parse that out of the dumped DOM.
  - **Always compute a control.** Measure what the *old* behaviour would have produced in the same
    run. "The new code did X" is not a result; "the old code would have done Y instead" is.
  - **Never put a real fixture in the repo.** Serve it over HTTP from the scratchpad
    (a 20-line `SimpleHTTPRequestHandler` with an `Access-Control-Allow-Origin` header) so no
    session content can be swept into a commit.
  - **A dev server may already be running on 1420.** Check `ss -ltnp` before starting another;
    an existing one serving the same project root works fine. Do not kill it.
  **Delete the harness afterwards** — it imports fixtures that do not exist on a fresh clone.
- **No TypeScript test runner exists.** `npm run build` is `tsc && vite build`, so type errors
  fail the build, but there are no frontend unit tests. Verify frontend behaviour by rendering it.

---

## Skills

**Installed and worth using:**
- `frontend-design` — Anthropic's official skill, at `.claude/skills/frontend-design/`. Genuinely
  opinionated; it produced a falsifiable claim about this codebase within minutes.
- `wayfinder` — how the three maps were charted. Tracker conventions are in
  `docs/agents/issue-tracker.md`.
- `domain-modeling`, `grilling`, `prototype`, `research` — wayfinder calls these by name.

**Deleted deliberately, do not reinstall:** `senior-architect` and `senior-frontend` from
aitmpl.com. Despite 2,000+ downloads each they are empty templates — their "references" differ
only in the `#` heading, and `bundle_analyzer.py`'s entire `analyze()` sets `findings = []`.
**The tell:** official Anthropic skills carry a `license` field in `components.json`; generated
ones have none. Check that before installing from there.

### Suggested skills for the next session

Call the **Skill** tool for these, depending on what you pick up:

- **`frontend-design`** — before any visual change. The revamp plan leans on it.
- **`domain-modeling`** — before introducing or renaming a concept. `CONTEXT.md` is young and
  still soft.
- **`prototype`** — for anything in map #26 that is a "look at it" question.
- **`run`** — before believing any claim about the running app. This session repeatedly found
  that rendering something contradicted reasoning about it.
- **`dataviz`** — before drawing any chart or meter. Note its validator already **failed** this
  app's palette for categorical use, which is why status is never colour alone.
- **`wayfinder`** — only if starting a new effort or working a map's remaining fog.
- **`pr`** — if opening a pull request.

---

## Where each map stands

**#26 — design system** (the live one). All four tickets closed. Chunks 0–1 shipped. Two findings
reopened assumptions and are recorded on the map: the rail's concurrency tick is **structurally
impossible** (the backend refuses to interleave subagent entries by timestamp, so a tick and its
run are never on screen together), and the folio ordinal fails at a numbered tick every 1.4 rows.
Together they mean **"where boldness gets spent" is reopened, not settled** — that is the map's
organising claim, so read #29's resolution before building anything from the plan.

Still unbuilt from the plan: chunks 2–6 (token layer, `src/ui/` primitives, typography, the rail,
the header/middot pass). **Sparse time** (print the clock only when the minute changes, else the
gap) is independent of the rail, was the clearest win in the prototype, and is not yet shipped.

**#19 — Agents section.** Complete and shipped.

**#11 — the panel becomes the session.** Complete; every fog item built.

---

## Things deliberately left undone

- **`AgentWindow` parses 428 kB of xterm it can never use** (every import is static). A `lazy()`
  import fixes it. Left alone because two attempts to measure the cost came back below the noise
  floor. Reasoning is recorded in `vite.config.ts`. Revisit only if window opens are *observed*
  to be slow.
- **The work email in git history.** Nine commits on `main` carry a corporate address. The user
  was told before the repo was made public and chose not to rewrite history. **Do not raise it
  again unless asked** — it was a decision, not an oversight.
- **One defensive branch in `Trace.tsx` is unexercised.** If the anchored row has been filtered
  out by the time the layout effect looks for it, the anchor leaves the scroll alone rather than
  guessing. No scenario reaches it — row keys are stable across the flip, since the reversal
  reorders blocks without re-keying them. The guard is correct to exist; do not describe it as
  tested behaviour.
- **Vendored skills.** `.agents/` and `.claude/` are gitignored; `skills-lock.json` is tracked.
- **Research leftovers.** ~19 throwaway project dirs (~6.8 MB) under `~/.claude/projects/`
  (`-tmp-rd21-w*`, `-tmp-rt-exp*`) from the #20/#21 research agents. Harmless, but they are
  scanned by the cross-session spend rollup. The user has not asked for them to be removed.

---

## How this user works

Terse instructions, heavy delegation, and they will say "start" or "finish all" and expect the
whole thing. They want to see evidence, not assurances — the most valued output this session was
measurement that *contradicted* a plan. They correct course quickly when shown a number.

Report failures plainly and immediately, including your own. Several of this session's most useful
moments were retractions.
