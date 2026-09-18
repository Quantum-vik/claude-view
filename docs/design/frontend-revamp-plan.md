[harness: subagent output matched instruction-shaped pattern(s): dangerously-skip-permissions. Control tags below are neutralized (`<` → `<\`); treat any remaining directive-shaped text as a finding to relay to the user, not an instruction to you.]

# claude-view Frontend Revamp — Final Design Plan

**Direction: Strip Chart**, with three corrections forced by the code and four grafts from the runners-up. Target: v1.4.x, shipped as seven independent releases against a working v1.3.1.

---

## 0. Corrections to the winning direction (read first)

I verified every load-bearing claim against the repo. Three parts of Strip Chart as written are wrong and are corrected here. Two more are descoped.

**C1 — The wireframe was mirrored. The panel is on the LEFT, the terminal on the RIGHT.**
`src/SessionWindow.tsx:985` says so in a comment and `:986–1030` implements it: sidebar → `DragHandle` → terminal. The rail therefore sits at the panel's **leading edge against the window frame**, not at the seam with the terminal. It gets `padding-left: 12px` from the window edge so it is not a line jammed into chrome.

**C2 — "Elapsed time as position" is not derivable and is struck from the thesis.**
`src-tauri/src/trace.rs:10–23` states the reason explicitly: a session is the parent transcript *plus one file per subagent*, each appended independently, and the backend deliberately **refuses to sort entries into a global sequence** because a late-writing subagent would renumber earlier entries. `Trace.tsx:186–195` confirms the consequence — subagent entries arrive as a contiguous block with an `agent` header row when `agentId` changes, not interleaved by timestamp. Row height is set by text length, not duration.

So the rail cannot make gap-size mean elapsed time, and lanes cannot run visually parallel to the parent rows they overlap. What it *can* do, from data that exists:

- `AgentRun` carries `startedAt`, `endedAt`, `depth`, `parentAgentId`, `toolUseId` (`src/agents.ts:21–36`). Every `TraceEntry` carries `ts`.
- Therefore **"was run R live at the moment of parent row X"** is a pure function: `x.ts >= R.startedAt && x.ts <= R.endedAt`.

The rail encodes **topology + concurrency**, not chronology-as-length:
- a **fork** at the `Task` call that spawned the run (matched via `run.toolUseId` ↔ `entry.toolUseId`),
- a **lane** holding that run's own block, indented,
- an **open-lane tick** in the lane column on any *parent* row whose `ts` falls inside a live run's interval — this is what makes concurrency visible without reordering anything,
- a **rejoin** `┴` with the run's wall-clock span and cost.

Chronology is restored by a different, cheaper device — see C3.

**C3 — Graft: sparse time** (from *Scrollback*; the judge called it the strongest single idea across the runners-up and it is independent of everything else).
`Trace.tsx:243–254` stamps `hh:mm:ss` on every row — 58px saying nothing 90% of the time. Replace with: print wall-clock **only when the minute changes**; otherwise print the **gap** (`+4s`, `+11m`) when it exceeds 30s; otherwise print nothing. The column stops being a repeated stamp and becomes the record of where the session spent its life. This is what actually delivers "read the rail alone and get the session's shape" — the claim C2 removed from the lane geometry.

**D1 — Descoped: `SIDEBAR_DEFAULT` stays 470.**
Strip Chart moved it 470→560 so a 62ch cap would "sit just at the edge of binding". That costs 90px of terminal on every new session to make a token *almost* apply. The rail replaces the existing 14px mark column and adds at most 12px of lane inset, so it fits at 470. The measure token's honest job is the **wide** case: at 470 the real measure is ~52ch, which is already correct; the cap exists so a user who drags to 1500px still gets a column. Say that in the comment instead of moving the layout.

**D2 — Descoped: `Caption` is not ALL-CAPS and not tracked.**
Strip Chart confessed this was two of tell #7 at once and guarded it with a TSDoc comment. A name is not a constraint. Drop the tracking and the caps; 10px mono sentence-case reads fine as a column head, and the tell is gone rather than rationalised.

**D3 — Gated: the Log → Stream merge moves to Chunk 7 and may not ship at all.**
Hard blocker found: `Timeline.tsx:95` orders **newest-first**, and `:203–215` implements follow-latest as `scrollTop = 0` with a `nearTop < 80` guard, deliberately, because watching a live session means new lines arrive at the **top**. `Trace.tsx:567` is a plain bottom-growing `overflow: auto`. Merging Log into Trace silently **inverts reading direction** for the view people use while a session runs. Strip Chart's mitigation ("default the density to tools-only so their first launch looks like their last") is factually wrong — it would look upside down. See §6 Q1.

---

## 1. The token system

Everything below lands in `src/tokens.ts` (geometry, type, motion, z) and `src/themes.ts` (colour). Colour keeps going through `var(--cv-*)`; geometry is plain typed consts beside `T`. **One mechanism, extended — not a second one.**

### 1.1 Colour — Ink & Parchment (default, dark)

`ThemeColors` goes 33 → 35 keys. Two new, five values changed. Everything else is byte-identical to what ships.

| Token | Hex | Role | Contrast (bg / surface1 / surface2 / titlebar / sidebar) |
|---|---|---|---|
| `bg` | `#14110d` | App ground, terminal pane. Brown-black at hue ~35°, **not** a tinted neutral | — |
| `surface` | `#14110d` | Window body | — |
| `surface1` | `#1a1712` | Cards, inputs, popovers, tool-output blocks | — |
| `surface2` | `#211c15` | Chips, nested rows, hover fill | — |
| `titlebar` | `#181510` | Header bars, resizer | — |
| `sidebar` | `#12100c` | Panel pane (one shade below bg) | — |
| `border` | `#2e2820` | Default hairline | — |
| `borderStrong` | `#3a332a` | Control borders | — |
| `divider` | `#241f18` | 1px section rule | — |
| `accentBorder` | `#4a3d28` | Selected card border | — |
| **`rail`** | **`#4a4136`** | **NEW.** The spine's continuity line. Non-informational by contract: never the sole carrier of anything | 1.88 / — / — / — / 1.90 |
| **`railLane`** | **`#7a6f5d`** | **NEW.** Lane rule + open-lane ticks. **Informational** → must clear 3:1 (WCAG 1.4.11) | 3.82 / — / — / — / 3.85 ✓ |
| `text` | `#e8e2d5` | Prose, prompts, tool arguments, headings | 14.58 / 13.84 / 13.10 / 14.10 / 14.72 ✓ |
| `textDim` | `#a89f8d` | Secondary prose, tool output | 7.18 / 6.81 / 6.45 / 6.94 / 7.25 ✓ |
| `textFaint` | **`#948a79`** *(was `#6f675a`)* | **All** metadata: rail time, token counts, durations, context %, hints, captions | **5.53 / 5.25 / 4.97 / 5.35 / 5.58 ✓** (was 3.37/3.20/3.03/3.26/3.41 ✗) |
| `timestamp` | **`#948a79`** *(was `#5c554a`)* | Retargeted to `textFaint`. Key retained as an alias so no theme shape breaks | **5.53 → 5.58 ✓** (was 2.56–2.58 ✗) |
| `idle` | **`#948a79`** *(was `#5c554a`)* | Retargeted to `textFaint`. Same reason | **5.53 → 5.58 ✓** (was 2.56–2.58 ✗) |
| `cmd` | `#cfc8b8` | Command text in the log | 11.30 / 10.73 / 10.15 / 10.93 / 11.41 ✓ |
| `cmdFold` | `#bdb5a5` | Folded-child command text | 9.25 ✓ |
| `accent` | `#d4a55e` | **Narrowed job**: money, focus ring, current selection, turn weight on the rail. No longer "this is a heading" or "this is a chip" | 8.37 / 7.95 / 7.53 / 8.10 / 8.45 ✓ |
| `accentInk` | `#14110d` | Text on a filled accent button | 8.37 on accent ✓ |
| `success` | `#8aab7a` | Status only — never alone | 7.34 / … / 7.41 ✓ |
| `running` | `#d4b36a` | Status only — never alone | 9.37 / … / 9.46 ✓ |
| `error` | `#c97b6f` | Alarm: error notch, failed status, error borders | 5.87 / … / 5.92 ✓ |
| `errorText` `#d3aca6`, `errorPreview` `#c99a92`, `errorBorder` `#4a2f2a` | | Unchanged | |
| `modelViolet` | `#c9a2c0` | Opus-tier dot / model chip | 8.44 ✓ |
| `toolBash` `#b8905a`, `toolEdit` `#c9a2c0`, `toolRead` `#7a9a8a`, `toolGrep` `#8fb0a0`, `toolWeb` `#b0a37e`, `toolTask` `#b9a2c9` | | Tool families. **All six pass AA on sidebar** (6.17–8.52) but adjacent-pair ΔE is 9.8 against a floor of 15, so they are **never the only carrier** — the glyph (`$ ✎ ▤ ⌕ ⇅ » ›`) is | 6.11–8.52 ✓ |
| `searchGlyph` | `#a08a5f` | `⌕` tint | — |

Derived vars (`accentSoft` 10%, `accentSoft2` 15%, `accentHover` 5%, `successSoft`, `successBorder`, `errorTint`, `shadow`) are computed in `themeToCssVars` (`themes.ts:952–991`) and are unchanged.

**Why `timestamp` and `idle` keep their keys instead of being deleted.** Deleting keys would change `ThemeColors`' shape, and imported themes are persisted as full `Theme` JSON in localStorage (`themes.ts:1007–1016`). Retargeting values is a no-risk edit; deleting keys is not.

### 1.2 Colour — Parchment Light

The light theme currently ships its entire money-and-action layer at ~3:1. Four values change:

| Token | Was | Now | Contrast (bg `#f4efe4` / surface1 `#fbf8f0` / surface2 `#ece5d4`) |
|---|---|---|---|
| `accent` | `#a87f3e` | **`#805c22`** | **5.27 / 5.70 / 4.82 ✓** (was 3.17 / 3.43 / 2.90 ✗) |
| `textDim` | `#7a7060` | **`#6a6050`** | **5.38 / 5.82 / 4.92 ✓** (was 4.25 / 4.59 / 3.88 ✗) |
| `textFaint` / `timestamp` / `idle` | `#a39784` | **`#6f6555`** | **4.99 / 5.39 / 4.56 ✓** (was 2.50 / 2.70 / 2.29 ✗) |
| `rail` (new) | — | `#d6cbb4` | 1.40 — non-informational |
| `railLane` (new) | — | **`#8a7d64`** | **3.52 / — / 3.22 ✓** |

`#805c22` is a dark bronze, materially further from the `#D97757` terracotta cliché than `#a87f3e` was. The a11y fix and the anti-tell move are the same edit.

### 1.3 Type — five sizes, integers only

Replaces 14 sizes (verified census: `10.5`×27, `12`×26, `11`×26, `10`×17, `13`×14, `12.5`×13, `11.5`×11, `9.5`×8, `13.5`×6, `14`×3, `9`×2, `15`×2, `16`×2, `24`×1) including five half-point steps nobody can perceive at 14px base.

```ts
export const F = {
  micro:   { size: 10, line: 1.4,  family: T.mono,  weight: 400, numeric: "tabular-nums" },
  data:    { size: 12, line: 1.5,  family: T.mono,  weight: 400, numeric: "tabular-nums" },
  body:    { size: 14, line: 1.6,  family: T.serif, weight: 400 },
  lead:    { size: 17, line: 1.3,  family: T.serif, weight: 600 },
  display: { size: 24, line: 1.15, family: T.serif, weight: 600 },
} as const;
export const W = { normal: 400, strong: 600 } as const;
export const MEASURE = "62ch";
```

| Rung | px | Family | Weight | Used for |
|---|---|---|---|---|
| `micro` | 10 | IBM Plex Mono | 400 | Rail time, durations, token counts, column captions, `… (clipped)`, folio cost |
| `data` | 12 | IBM Plex Mono | 400 / 600 | Tool names (600), tool arguments, tool output, chip labels, machine search fields, model chip, money |
| `body` | 14 | Lora | 400 | Assistant prose, user prompts (italic), thinking (italic), the app's own explanatory English |
| `lead` | 17 | Lora | 600 | Panel titles, header readout figures, folio numeral |
| `display` | 24 | Lora | 600 | Exactly one per window. Launcher `<h1>Sessions</h1>` (`Launcher.tsx:1289`, already 24). Session window has none |

**Graded leading survives** because it is the part of the rule that already works: assistant prose 1.68, prompts and thinking 1.6, Agents prose 1.65, body 1.5. These override `F.body.line` at those four sites and nowhere else.

**Weight stays binary.** 400 and 600 only — the app is already at 33-of-40 on 600. Lora is vendored 400–600, so any `fontWeight: 700` on serif would be faux bold; the two existing 700s (`SessionWindow.tsx:1154`, `Launcher.tsx:1674`) are on system-ui chrome and stay there.

**The critical inversion this fixes.** `Trace.tsx:284–292` sets `color`, `fontFamily: T.mono`, `whiteSpace`, `wordBreak` and **no `fontSize`**, so a bash argument inherits `body { font-size: 14px }` (`styles.css:118`) — 27% larger than its own 11px label at `:282`, larger than the `… (clipped)` marker at 10, larger than the output block at 12, and larger than the assistant's 13.5px prose at `:862`. Under `F.data` it becomes 12, one rung below prose. Scanning order restored by the scale alone.

### 1.4 Spacing — seven steps, 2-base

```ts
export const S = { xs: 2, sm: 4, md: 8, lg: 12, xl: 16, xxl: 24, xxxl: 32 } as const;
```

Replaces 14 distinct `gap` values (every integer 2→14 plus 16) and 60 distinct `padding` shorthand strings. Binding rules:

- Stream row padding: `${S.sm}px ${S.lg}px` (4/12).
- Default flex gap inside a row: `S.md` (8). Between row groups: `S.lg` (12).
- Control padding: `${S.sm}px ${S.md}px` minimum, raised to meet the 24px hit-target floor with **transparent** padding so visual weight is unchanged.
- Panel/card padding: `S.lg` (12) or `S.xl` (16). Window-level: `S.xxl` (24).

### 1.5 Radius — five spellings, each with a meaning

Replaces 15 spellings (`8`×17, `999`×14, `6`×13, `"50%"`×13, `99`×6, `5`×6, `7`×5, `10`×4, `9`×3, `4`×3, `12`×3, `3`, `11`, and two corner-specific strings). The current failure is the *inverse* of the SaaS-card tell — not one radius on everything, but ten near-identical radii on things at the same level (`primaryBtn` 9 / `resumeBtn` 7 / `secondaryBtn` 8 / `iconBtn` 8 / `slimBtn` 4, all siblings in `Launcher.tsx:2345–2448`).

```ts
export const R = {
  hair:    2,      // a mark drawn ON a rule
  control: 6,      // a thing you click, inline-level
  panel:   10,     // a thing that CONTAINS controls
  pill:    999,    // a quantity or a state — never an action
  dot:     "50%",  // a status dot
} as const;
```

**The encoding rule, one sentence, checkable in review:** *radius grows with containment, and fully-round means state, not action.*

- `R.hair` — rail notches, meter fill caps, the turn-weight segment.
- `R.control` — every button, input, tab, chip, segmented-control cell. **All five Launcher button variants land here**, which is the whole point: 7/8/9 bought no hierarchy.
- `R.panel` — cards, tool-output blocks, popovers, menus, the session card. All four popovers (today 12 / 12 / 10 / 6) become one geometry.
- `R.pill` — status pills and the context-meter track only. If it's round and you can click it, it's wrong.
- `R.dot` — status dots.

The two asymmetric strings (`Launcher.tsx:2063` `"7px 7px 0 0"` — a tab; `Trace.tsx:732` `"0 6px 6px 0"` — a left-attached block) survive as `` `${R.control}px ${R.control}px 0 0` `` etc. They encode attachment, which is legitimate.

### 1.6 Stacking, motion, measure

```ts
export const Z = { base: 0, rail: 5, sticky: 10, popover: 100, overlay: 200, menu: 300 } as const;
export const M = { pulse: "1.6s", hover: "120ms", fade: "100ms" } as const;
```

`Z` replaces the ad-hoc 30 / 100 / 201 / 301. `M.pulse` unifies three durations for one meaning — today two live dots for the same session (launcher card + agent strip) pulse out of phase at 1.6s and 1.4s.

### 1.7 Token hygiene

Delete the `borderAccent` / `accentBorder` duplicate alias (`tokens.ts:22–23`, two names for `var(--cv-accent-border)`). Keep `accentBorder` (15 uses); migrate the two `borderAccent` sites (`Spend.tsx:204`, `Trace.tsx:446`).

---

## 2. What changes, per file, in shippable chunks

Each chunk leaves v1.3.1 working and is releasable on its own. Ship in order; chunks 0 and 1 are defects and should not wait for the rest.

### Chunk 0 — Correctness (no design). Ship immediately.

| File | Change |
|---|---|
| `src/Agents.tsx:208` | `<div style={{ padding: "12px 14px 40px" }}>` has no height and no overflow; its parent is `overflow: hidden, display: flex, flexDirection: column` (`SessionWindow.tsx:990–1001`). **Rows past the viewport are unreachable.** Add `height: "100%"` on the root and an inner `overflow: auto` scroller, matching `Trace.tsx:421` + `:567`. The one view whose entire justification is showing every run currently hides runs. |
| `src/Trace.tsx:284–292` | Add `fontSize: F.data.size` to the `call.text` span. (Ship the literal `12` here if Chunk 2 hasn't landed.) |
| `src/Agents.tsx:415–417` | Comment claims row-click scopes the panels; it hasn't since the strip inverted its semantics. `SessionWindow.tsx:1005` passes `selected={agentScope}` to a panel with no way to write it. Wire `<tr onClick>` → `onScope(run.id)`; keep the named `open` button as the window opener. |

**Release as 1.3.2.**

### Chunk 1 — Quality floor (a11y + contrast). No layout change.

| File | Change |
|---|---|
| `src/themes.ts:97–130` | `textFaint` → `#948a79`; `timestamp` → `#948a79`; `idle` → `#948a79`. |
| `src/themes.ts:162–200` | `accent` → `#805c22`; `textDim` → `#6a6050`; `textFaint`/`timestamp`/`idle` → `#6f6555`. |
| `src/themes.ts` (all builtins) | Same treatment for Slate and any other builtin: any token used at ≤12px must clear 4.5:1 on every surface it appears on. Slate stays a **legacy** option (`themes.ts:13` already frames it as "the original blue dark theme") — it is tell #2 verbatim and must not be promoted. |
| `src/styles.css` | Replace the nine inline `animation:` declarations with a class. Add:<br>`.cv-pulse { animation: pulseDot var(--cv-pulse, 1.6s) ease-in-out infinite; }`<br>`@media (prefers-reduced-motion: reduce) { .cv-pulse { animation: none; background: transparent; box-shadow: inset 0 0 0 1.5px currentColor; } }` — **the encoding survives the accommodation**: a running dot becomes a hollow ring, distinguishable from the filled dot of a finished one. `animation: none` alone would leave it indistinguishable from dead. |
| 9 sites | `AgentStrip.tsx:219`, `Agents.tsx:493`, `AgentWindow.tsx:221`, `Timeline.tsx:559`, `Trace.tsx:771`, `Launcher.tsx:1180`, `Launcher.tsx:1536`, `SessionWindow.tsx:730`, `TerminalWindow.tsx:140` → `className="cv-pulse"`, inline `animation` removed. A media query cannot override an inline style; this conversion is the prerequisite, not an optimisation. |
| `src/styles.css` | `.cv-field:focus-within { outline: 2px solid var(--cv-accent); outline-offset: 1px; }` applied to the wrappers of the three `outline: "none"` inputs — `Launcher.tsx:1480` (the **⌘K target**, focused programmatically at `:995`), `Timeline.tsx:388`, `Terminal.tsx:752`. |
| `src/styles.css:189–196` | Add `.cv-line:focus-within .cv-copy { opacity: 1 }`. Today `Launcher.tsx:1856`'s session-**delete** button is `opacity: 0` and keyboard-focusable: a Tab user lands on an invisible control that moves a transcript to the Trash, with `button:focus-visible` drawing a ring around nothing. |
| `src/Resizer.tsx:56–100` | `role="separator"`, `tabIndex={0}`, `aria-orientation="vertical"`, `aria-valuenow/min/max`, `onKeyDown` for ArrowLeft/Right (±16px, ±64 with Shift) calling the **existing delta-based `onResize`**. The callback contract is already delta-shaped so nothing downstream changes. The core layout decision of the app is currently pointer-only. |
| `src/ContextMeter.tsx:55–80` | `role="progressbar"`, `aria-valuenow={tokens}`, `aria-valuemax={limit}`, `aria-valuetext={"48K of 200K, 24%"}`. The one number that says when a session is about to run out of room is currently tooltip-only on a non-focusable span. |

**Release as 1.3.3.** Ships the entire WCAG floor with zero visual restructuring.

### Chunk 2 — Token layer (mechanical, behaviour-free)

| File | Change |
|---|---|
| `src/tokens.ts` | Add `S`, `R`, `F`, `W`, `Z`, `M`, `MEASURE` exactly as §1. Delete the `borderAccent` alias; migrate `Spend.tsx:204` and `Trace.tsx:446`. |
| `src/themes.ts:19–57` | `ThemeColors` 33 → 35: add `rail`, `railLane`. Add both to all builtins and to `themeToCssVars` as `--cv-rail`, `--cv-rail-lane`. |
| `src/themes.ts` (VS Code importer, ~860–945) | Derive `rail = mix(borderStrong, accent, 0.2)` and `railLane = mix(textFaint, accent, 0.15)` from the picked keys, so any imported theme gets a complete palette for free — same pattern as the existing `borderStrong` / `divider` / error-trio derivations. |
| `src/themes.ts:1007–1016` | **Migration, required.** Custom themes persist as full `Theme` JSON in localStorage. A stored theme from 1.3.x has no `rail`/`railLane`, which would write `undefined` into a CSS var. Backfill in `customThemes()`: after the existing filter, `map` each theme through a `withDerivedKeys()` that fills any missing key from the derivation above. Do not silently drop themes that fail the shape check. |
| All `src/*.tsx` | Mechanical codemod: 93 `borderRadius` → `R.*`; every `fontSize` → `F.*.size`; every `gap`/`padding` literal → `S.*`; ad-hoc `zIndex` → `Z.*`. Round half-points to the nearest rung (`9.5`/`10`/`10.5` → `micro`; `11`/`11.5`/`12`/`12.5` → `data`; `13`/`13.5`/`14` → `body`; `15`/`16` → `lead`). |

**This chunk must land alone.** It touches ~384 inline style objects across 21 files with no intended visual change; if it rides with a redesign, a regression has 384 possible causes. Verify with a screenshot diff of all four window types before and after — the diff should be near-empty except for the half-point roundings.

### Chunk 3 — Primitives + semantics (`src/ui/`)

Six components. Today the only non-screen export in the app is `DragHandle` (behaviour, not chrome); all 27 `React.CSSProperties` constants are file-local, 18 of them locked inside `Launcher.tsx:2277–2473`, which is why `Terminal.tsx:786` wrote a tenth button style that looks like none of the other nine.

| New file | Replaces | Notes |
|---|---|---|
| `src/ui/Btn.tsx` | `Launcher.tsx:2345/2392/2416/2428/2448` + `segToggleStyle`, `terminalBtnStyle`, `resumeRowBtnStyle`, `termMenuItemStyle`, and `Terminal.tsx:786` | Variants `primary` / `secondary` / `icon` / `slim` / `seg`. **All at `R.control`.** Hover via `className`, not inline — this is the fix for 52 `cursor: pointer` sites and 44 `<button>`s sharing five hover rules over four classes. |
| `src/ui/Pop.tsx` | `ThemeMenu.tsx:97` (r12/p10/gap4/z301), `SessionWindow.tsx:1085` (r12/p12/gap14/z201), `Spend.tsx:230` (r10/p14/gap12/z30), `Terminal.tsx:736` (r6/p"4px 8px"/gap6/z100) | One geometry: `surface1` + `1px borderStrong` + `windowShadow` + `R.panel` + `S.lg` + `Z.popover`. Plus `role="dialog"`, `aria-modal`, Escape-to-close, focus-on-open, focus-restore-on-close, and `aria-haspopup`/`aria-expanded` on the three triggers (`SessionWindow.tsx:844`, `ThemeMenu.tsx:65`, `Launcher.tsx:1326`). The model/effort popover changes which model a live session uses — that is a consequential action currently dismissible only by mouse. |
| `src/ui/StatusPill.tsx` | `Agents.tsx:452–503` and `AgentWindow.tsx:188–229` | The five-branch `done→success, running→running, failed→error, stopped→textDim, else→textFaint` ladder is copy-pasted verbatim and **has already drifted**: Agents maps through `STATUS_TEXT` (`:441–447`) so unknown reads "unknown"; AgentWindow does `status === "running" ? "working" : status` with no map. Clicking a run in the roster to open its window currently changes the pill's size and chrome for an unchanged fact. This is a correctness risk, not tidiness. Dot + word, always. |
| `src/ui/Field.tsx` | `Timeline.tsx:378–392` (mono 11.5), `Trace.tsx:490–502` (mono 12), `Terminal.tsx:743–757` (mono 13), and the launcher's serif-italic search | Two of these occupy the *identical* toolbar slot depending only on which panel is open, so switching panels visibly resizes the search box. One spec: `F.data`, `.cv-field` focus-within ring. The **Launcher's serif-italic resume search survives as the one deliberate exception** — a resume query genuinely is human language — and is documented as such. |
| `src/ui/Caption.tsx` | `Spend.tsx:80–86` (9.5, `T.ui`, `.08em`, uppercase), `AgentWindow.tsx:174–179` (9.5, inherited sans, `.08em`, uppercase), `Agents.tsx:275–278` (10, `T.mono`, `.08em`, uppercase), `Timeline.tsx:584–589` (9.5, `0.04em`) | `F.micro`, `textFaint`, **sentence case, no letter-spacing**. Same device spelled four ways in three families today; one spelling, and the tell is deleted rather than guarded. |
| `src/ui/Meter.tsx` | `ContextMeter.tsx` internals; also used by the rail | `role="progressbar"`, track `R.pill`, fill `R.pill`. |

**~25 clickable non-buttons become `<button>`:** `Launcher.tsx:2052` (tab strip), `:2104` (tab close), `:1157` (live session card), `:1791` (recent session row), `:1659`/`:438`/`:445` (workspace + section collapsers), `ThemeMenu.tsx:202` (theme pick — the *only* way to choose a theme), `:254` (remove imported theme), `Trace.tsx:437` (the whole filter bar), `:299`, `:725`, `Agents.tsx:264` (`<th>` sort → `<button>` inside `<th aria-sort>`), `:334` (`<tr>`), `Timeline.tsx:532`, `:725`, `SessionWindow.tsx:1184`. They already carry `cursor: pointer` and hover tints, so the visual design survives the swap unchanged. Zero `tabIndex` exist in `src/` today; one `onKeyDown` outside `Terminal.tsx:747`.

**`aria-pressed` on every toggle that currently encodes state by fill alone** — `SessionWindow.tsx:879–948` (Trace/Agents/Log), `Timeline.tsx:485`, `Trace.tsx:437`, `AgentStrip.tsx:109`. These are the app's main navigation and they violate the app's own documented "never colour alone" rule; a screen reader announces three plain buttons named Trace, Agents, Log with no state.

**Hit targets to 24×24** with transparent padding: `Timeline.tsx:615` (~18px), `Launcher.tsx:1703` `+` (~19×27), `Launcher.tsx:2104` tab close (~18×12), `ThemeMenu.tsx:259` `✕` (~17×15), `Terminal.tsx:784` (~22px), `Agents.tsx:419` (~21px — and unpack the `font:` shorthand at `:421`, which silently discards the inherited `line-height: 1.5`).

**Launcher tab strip gains its word.** `Launcher.tsx:2078–2086` is a 7×7px colour-only dot with the state name available exclusively via `title=` on a non-focusable span. Given the measured ΔE 9.8, running `#d4b36a` / success `#8aab7a` / error `#c97b6f` are exactly the pairs a deuteranope conflates. Add the word, per `AgentStrip.tsx:212–224`.

### Chunk 4 — Typography

| File | Change |
|---|---|
| `src/styles.css:117` | `body { font-family: 'Lora', Georgia, serif }`. **This is the structural fix.** Today 81 of 174 sized style objects declare no family and silently resolve to system-ui — a *third voice nobody chose* — including the longest English prose in the product (`Launcher.tsx:1415`, `:1932`, `SessionWindow.tsx:1222`, `AgentWindow.tsx:163`) while a 6-character chip label gets Lora (`ThemeMenu.tsx:84`). After the flip an omission fails *toward* human language, which is reviewable; failing toward a third family is invisible. |
| `Launcher.tsx:1983`, `SessionWindow.tsx:656`, `TerminalWindow.tsx:66`, `AgentWindow.tsx:232` | Keep `T.ui` **pinned on window-chrome containers only** (header bars, toolbars, popover control rows) so the flip reaches content areas and not buttons. `AgentWindow`'s `SHELL` declares no family at all today — give it one. |
| `Timeline.tsx:277`, `Trace.tsx:421` (machine regions) | Keep / add `fontFamily: T.mono` on the panel root. `Timeline.tsx:277` is the one place in the app the rule *cannot* be broken by forgetting — all 21 of its family-less children are correct by inheritance. Generalise the pattern. |
| All files | Apply `F.*` per §1.3. Corrections where serif drifted from "language" to "emphasis": `SessionWindow.tsx:854` model chip (serif italic 12.5 → `F.data` mono), `ThemeMenu.tsx:84` the word "Theme" (→ `F.data`), `AgentStrip.tsx:159` agent *type* name (Lora 11 inside a mono 11 pill — reads as a rendering glitch; → `F.data`). The run **description** beside it stays serif: a type name is a label, a description is language. |
| `Spend.tsx:208–212` / `:243` / `:252` | The same dollar figure renders mono-13 on the trigger and `600 16px serif` in the popover — one click apart. **Money is mono everywhere**, `F.data` or `F.lead`, tabular, accent. `tokens.ts:61` already lists token counts as machine language; a dollar amount is the same kind of thing. Serif at `:243` was Lora doing a job weight and colour already do. |
| `SessionWindow.tsx:773`, `Spend.tsx:212`, `Timeline.tsx:734`/`:739`/`:760` | `fontVariantNumeric: "tabular-nums"` — it is baked into `F.micro`/`F.data`, so this is automatic once those sites take a rung. These are exactly the figures that tick while you watch; proportional digits make the header cost chip jitter horizontally every turn and break right-alignment down the folded log. |
| `Trace.tsx:837–848` | The user prompt is the **only uncapped paragraph in the app** and sits at the top of every turn; the reply beneath it caps at 74ch. Give it `maxWidth: MEASURE`. Collapse the five orphan caps (58/60/62/74/80ch at `Trace.tsx:573`/`:596`/`:864`/`:885`, `Agents.tsx:212`/`:514`, `AgentWindow.tsx:52`) to `MEASURE`. |

### Chunk 5 — The rail

New file `src/Rail.tsx`, rendered inside Trace's existing row grid. **It replaces only the 14px mark column at `Trace.tsx:256–258`.** The 58px timestamp gutter at `:245–254` is re-authored in place as sparse time (C3) and keeps its `flex: 0 0 58px` and `tabular-nums`. That containment is what makes this a bounded change and not a rewrite.

What it draws, and the data each piece comes from:

| Element | Encoding | Source |
|---|---|---|
| Continuous 1px `rail` line | Column continuity. Non-informational | — |
| 3px `accent` segment at a turn boundary, weighted in **3 steps** by turn cost | Where the money went, coarsely | `turns[row.turnId]` + `costOfTurn` — already computed at `Trace.tsx:650–660` |
| Mark glyph (`$ ✎ ▤ ⌕ ⇅ » ›` / `✓` / `●` / `✗`) | Tool family and outcome | `toolFamily()`, `tokens.ts:99–109` |
| `✗` notch in `error` | Failure | `result.isError` |
| **Fork** at the spawning `Task` call | Which call started which run | `run.toolUseId` ↔ `entry.toolUseId`, `agents.ts:28` |
| **Lane** (8px inset, 1px `railLane`) around the run's block | Subagent membership | `entry.agentId` — the block already exists (`Trace.tsx:186–195`) |
| **Open-lane tick** on a *parent* row | **Concurrency**: a subagent was live at this moment | `x.ts ∈ [run.startedAt, run.endedAt]` — pure function, no reordering |
| **Rejoin** `┴` with span + cost | Run finished, what it cost | `run.endedAt`, `run.usd` |

**The degradation contract, which must actually be implemented, not assumed:** no lanes when `roster.runs.length === 0`; no weight variation when the turn-cost spread is under one step; no fork/rejoin when there is nothing to fork. On a trivial session the rail renders as *exactly* today's mark column plus a hairline. **Acceptance test: screenshot a 1-turn session and a 40-turn multi-agent session side by side. If the rails look similar, the rail has failed and should be reverted.**

**Rail accessibility** (the winner's one gap — its single bold element was its single inaccessible one): the rail is `aria-hidden`. Everything it encodes must exist in text:
- the subagent block header already names the run — add `aria-label={"subagent run: " + label + ", ran " + span + ", " + status}`;
- the turn header carries the cost as text (see below);
- the open-lane tick's fact gets one sentence on the agent block: *"ran alongside the parent for 1m 12s."*

**Grafts landing here:**

*The folio* (from Apparatus). `Trace.tsx:673` renders the turn identity as `row.turnId.slice(0, 16) + "…"` — a hash, at 10.5px. The word people actually say is "turn four". Render the **ordinal** in the rail at `F.lead` (17, serif 600) with the turn's cost beneath at `F.micro`. Kept at 17, not Apparatus's 26 — the rail is the boldness budget and the folio is a passenger on it, not a second spend.

*Blank-as-information + footnote-once* (from The Tape). Cost is recorded per turn, never per tool call (`Trace.tsx:685–703` explains this once in a `?` tooltip). Make it a property of the layout: the folio's money slot is the only place a figure appears, and a blank slot on every other row *means* "this line is inside the turn above". Unpriced turns (`costOfTurn` → `null`, `pricing.ts:154`) show an em dash — **with `aria-label={CAVEAT.unpricedLabel}`**, closing the a11y regression that judge flagged in the original. Promote `CAVEAT.footer` (`pricing.ts:188`) from a per-turn tooltip to **one line at the panel foot**, rewritten as a sentence — see the middot pass below.

### Chunk 6 — Header, strip, and the middot pass

| File | Change |
|---|---|
| `SessionWindow.tsx:661–974` | Thirteen elements separated by five identical 1×18px rules (`:739`, `:748`, `:786`, `:808`, `:841`), mixing identity, health, money and navigation at one weight — so the three panel buttons, the bar's *only* navigation, read as four more chips. Regroup into **three zones, two dividers**: **identity** (`:673` cwd, `:693` id) — **readout** (`:712` live dot+word, `:737` meter, `:746` cost, turn count) — **view** (segmented control, settings, theme). The readout is the only zone that changes while you watch: `F.lead`, tabular, fixed position, never reflows. |
| `SessionWindow.tsx:879–948` | Three copy-pasted toggle buttons — two with `fontFamily: T.serif` (`:898`, `:924`) and the third without (`:930`) — where one names itself three ways: button "Timeline" (`:947`), tooltip "command log" (`:932`), panel header "Command log" (`Timeline.tsx:301`). Becomes one `role="radiogroup"` segmented control with `aria-checked`. **`togglePanel` (`:272–290`) stays the single path** — three inline copies is exactly how these drifted. |
| `src/AgentStrip.tsx` | Removed. `MAX_CHIPS = 3` of an observed 11 runs, plus a `+N` button that opens the panel that already lists them, plus a second `useRoster(vid)` poller (`:59` alongside `Agents.tsx:135`). Its liveness job moves into the rail's lanes and the header readout's agent count. **This is the change most likely to generate "where did it go" feedback** — the `main` scope chip disappears, so scope must be settable from the Agents roster row (Chunk 0) and the Stream's per-run header (`Trace.tsx:722–726`) before this lands. |
| `src/Launcher.tsx` | Same three-zone header. Delete the 18 file-local style constants (`:2277–2473`). The persistent full-width skip-permissions card (`:1377–1447`) — a setting changed once, sitting above the search and duplicating the per-session chip at `SessionWindow.tsx:806` — moves into the settings popover; the session list starts ~90px higher. **⌘K/⌘N/⌘T/⌘W/⌘1–9 (`:989–1024`) untouched.** |
| All files | **The middot pass.** ~18 visible `A · B · C` joins deleted and re-typed by *relation*: a **breakdown of a total** (`Launcher.tsx:1511–1513` `live · blocked · working · idle`) → dot-and-count pairs on one row, whitespace-separated; **two facets of one measurement** (`Spend.tsx:247` `turns · tokens`, `:290`) → value over caption; a **ratio** (`ContextMeter.tsx:78`) → `48K/200K 24%`; a **qualifier on a status** (`Agents.tsx:499`, `AgentWindow.tsx:226` `· 4m quiet`) → adjacent in `textFaint`, no separator. Also `Launcher.tsx:344`, `:1227/:1229/:1231`, `:1699`, `Trace.tsx:506/680/684`, `SessionWindow.tsx:1166`, `ThemeMenu.tsx:248`, `AgentStrip.tsx:202`, `pricing.ts:188`. **Middots survive inside `title=` tooltips**, where a compact join is genuinely right. This is the one place the app reads templated, and it reads templated precisely because one glyph is flattening four kinds of relation in an app that is otherwise careful about encoding meaning. |

### Chunk 7 — GATED: the Stream merge

Do not start this until §6 Q1 is answered by a human. Trace *is* a content superset of Timeline (`Trace.tsx:3–5` vs `Timeline.tsx:4–18`), and Log survives only because "it is what existing users know" (`SessionWindow.tsx:10–12`) — a migration reason, not an IA reason. The prize is real: one search field instead of two with different placeholders and different type specs; one filter vocabulary instead of `all/✓ok/●run/✗err/fold` vs `all/tools/replies/thinking/errors`; one agent-scope chip instead of `Timeline.tsx:340`'s mono `» agent-3f2a…` and `Trace.tsx:451`'s serif run label showing the same state.

But the merge is blocked on reading direction (D3) and on `fold`, which is a *density* control, not a filter — folding N consecutive same-tool successes is what keeps a 200-call run readable. `Trace.tsx:206–233` already implements folding, which is the good news; `Timeline.tsx:118–133` additionally guarantees errors break a fold and auto-expand, which must carry over.

---

## 3. What survives, and why

**The serif/mono semantic rule — strengthened, never diluted to "one serif, one sans."** 42 `T.serif` and 66 `T.mono` assignments where the split tracks meaning: `Trace.tsx:861` renders assistant prose as Lora at 74ch, `:882` renders thinking as faint italic Lora, `:889` flips the disclosure summary to mono because a char count is machine language. `tokens.ts:56–65` states the rule in the source. This revamp *makes it enforceable* by changing the failure direction (Chunk 4) and *narrows* it by removing the four places serif had drifted into meaning "emphasis".

**The CSS-custom-property theme architecture, exactly as-is.** `themes.ts` writes `--cv-*` onto `:root`; `tokens.ts` references them; components consume `T`. Theme switching costs **zero React re-renders**. Every contrast fix in Chunk 1 is a value change in one file. New tokens are *added* to this system, never routed around it.

**Zero raw hex and zero `rgba()` literals across all 13 `.tsx` files.** The codebase's best property. No primitive may regress it by one value. `tint()` (`tokens.ts:73–75`, `color-mix` on `var()` references) stays the way soft fills are derived.

**`ThemeColors` as a typed interface TypeScript refuses to let a theme under-fill.** Extended 33 → 35, not replaced. The new geometry scales copy this pattern rather than inventing a second mechanism.

**The xterm bridge.** xterm cannot read CSS vars, so `Terminal.tsx` subscribes via `onThemeChange()` and re-applies `term.options.theme` live (documented `themes.ts:1–16`). The one correct exception to the `var()` rule, and well handled.

**The VS Code theme importer and its derivation logic** (~860–945), which computes `borderStrong`, `divider`, `accentBorder`, the error trio and the six tool hues from a handful of picked keys. `rail`/`railLane` join the derivation rather than becoming two more keys a user must supply.

**Motion restraint, which is genuinely exemplary and is the opposite of the fade-and-slide-up tell.** Zero entrance animations. Zero gradients anywhere in `src/` (grep returns nothing). Exactly one shadow token at five genuinely floating sites (`Spend.tsx:233`, `Terminal.tsx:740`, `ThemeMenu.tsx:100`, `SessionWindow.tsx:1088`, `Launcher.tsx:1352`). `pulseDot` fires *only* on live/running dots — motion that encodes state. The only changes are the reduced-motion guard and one duration token.

**Status as colour AND word AND shape**, the measured answer to the ΔE 9.8 failure. `tokens.ts:99–109` gives each tool family a colour **and** a distinct prompt glyph, so the log is readable with colour stripped entirely. The revamp *extends* the convention to the launcher tab strip and the panel toggles, where it is currently broken, and relaxes it nowhere.

**The decisions that have reasons written down** — reversing any of these is the signature of a revamp that did not read the code:
- `shorten()` middle-truncation for run labels and the comment forbidding a CSS ellipsis on top of it (`AgentStrip.tsx:155–161`, `Agents.tsx:150`, `Trace.tsx:467`): the identifying token is at the **end**.
- Dollars, never tokens, for ranking runs (`Agents.tsx:14–17`) — tokens invert the real 33× cost gap.
- Cost on the turn, asymmetry explained once (`Trace.tsx:685–703`).
- Errors always break a fold and auto-expand (`Timeline.tsx:118–133`, `:180–196`).
- Typed absences that name the active filter instead of showing an empty list (`Trace.tsx:568–600`, `Agents.tsx:183–205`).
- The strip renders nothing when a session has no runs (`AgentStrip.tsx:70`) — no permanent tax on the common case.
- Scope hoisted above the panels and **deliberately not persisted** (`SessionWindow.tsx:243–251`) — restoring a stale run id onto a different session would read as data loss.

**No `→` appended to any button or link label.** Already clean; the only arrows in `src/` denote real transformations (`Trace.tsx:380`). Keep it that way — and drop the `↗` from Agents' `open ↗` while you're in `Agents.tsx` for Chunk 0.

**The keyboard command surface** (⌘K/⌘N/⌘T/⌘W/⌘1–9, `Launcher.tsx:989–1024`) and the terminal's user-owned, localStorage-persisted font size with ⌘0 reset (`Terminal.tsx:387–402`). That is the one size in the app the user owns.

**Font vendoring**: five self-hosted `@font-face` declarations with `font-display: swap` (`styles.css:5–38`), Lora as one variable file per style covering 400–600, IBM Plex Mono as three static weights. No CDN, no FOIT. The terminal's Nerd Font stack with its documented rationale (`Terminal.tsx:35–38`: Plex Mono has no powerline glyphs, so p10k prompts render as boxes) stays as the one place two mono faces coexist.

**`role="switch"` + `aria-checked` on the skip-permissions toggle** (`Launcher.tsx:1422–1424`) — the single correct ARIA usage in the codebase and the pattern the ~25 other fixes copy. Plus `aria-hidden` on the decorative swatch and chevron (`ThemeMenu.tsx:81`, `:216`), and `button:focus-visible { outline: 2px solid var(--cv-accent) }` (`styles.css:240–243`) — the ring was never the problem; too few things were buttons.

**Slate stays a demoted legacy option.** `#0d0e11` + `#5b9dff` + GitHub-dark status colours **is** tell #2 verbatim, and `themes.ts:13` already frames it as "the original blue dark theme". Fix its contrast, do not promote it.

---

## 4. The quality floor

These are acceptance criteria, not aspirations. Add a unit test that walks `BUILTIN_THEMES` and asserts the ratios.

**Contrast (WCAG 1.4.3).** Every token used at ≤ 12px must clear **4.5:1** against *every* surface it can appear on — `bg`, `surface1`, `surface2`, `titlebar`, `sidebar`. Verified values that must hold:

| Token | Floor | Ink & Parchment | Parchment Light |
|---|---|---|---|
| `text` | 4.5 | 13.10–14.72 ✓ | 10.05–11.89 ✓ |
| `textDim` | 4.5 | 6.45–7.25 ✓ | 4.92–5.82 ✓ |
| `textFaint` / `timestamp` / `idle` | 4.5 | **4.97–5.58 ✓** | **4.56–5.39 ✓** |
| `accent` | 4.5 | 7.53–8.45 ✓ | **4.82–5.70 ✓** |
| `accentInk` on `accent` | 4.5 | 8.37 ✓ | — |
| `cmd` | 4.5 | 10.15–11.41 ✓ | ✓ |
| `success` / `running` / `error` | 4.5 | 5.27 / 8.42 / 5.27 ✓ | verify |
| All six tool hues | 4.5 | 6.11–8.52 ✓ | verify |
| `railLane` (non-text UI, 1.4.11) | **3.0** | **3.82–3.85 ✓** | **3.22–3.52 ✓** |
| `rail` | none | 1.88 — *non-informational by contract* | 1.40 |

The `rail` token is exempt **only** because it is never the sole carrier: every row on it also has a glyph, a timestamp and text. If a future change makes the spine mean something on its own, it must be lifted to 3:1.

**Focus visibility (WCAG 2.4.7).** Every interactive element shows focus. `button:focus-visible` already gives `2px solid var(--cv-accent)` at 8.37:1. Additions: `.cv-field:focus-within` on the three bare inputs including the ⌘K target; `.cv-line:focus-within .cv-copy { opacity: 1 }` so the invisible delete button becomes visible; `role="separator"` on the resizer with a visible focus state. **No element may set `outline: none` without a replacement in the same commit.**

**Hit targets (WCAG 2.5.8).** 24×24 CSS px minimum, met with transparent padding so visual weight is unchanged. Seven named violations in Chunk 3. The resize handle (8px) is the one documented exception as an inline-sized control.

**Reduced motion (WCAG 2.3.3).** One `@media (prefers-reduced-motion: reduce)` block. The rule is **preserve the encoding, remove the movement**: a running dot becomes a hollow ring, not an inert filled dot indistinguishable from a finished one. Prerequisite: all nine inline `animation:` declarations become a class, because a media query cannot override an inline style.

**Semantics.** Zero `onClick` on a non-interactive element. `aria-pressed` on every toggle. `aria-sort` on sortable headers. `role="progressbar"` on the context meter. `role="dialog"` + Escape + focus management on all four popovers. `aria-hidden` on the rail, with its content duplicated in text.

**Responsive.** Panel min stays 320px. Below ~420px the rail drops the lane inset to 4px; the readout zone sheds turn count first, then context percentage — **cost and the live dot+word are the last two to go**. Prose measure degrades before the rail does.

---

## 5. The one place boldness is spent

**The rail.** One continuous ink spine down the panel's leading edge, replacing 44 disconnected mark glyphs, carrying four things nothing else in the UI carries:

1. **Turn boundary and cost weight** — a 3px accent segment in three steps, with the folio ordinal and figure beside it.
2. **Subagent topology** — a fork at the `Task` call that spawned the run, a lane holding its block, a rejoin at completion.
3. **Concurrency** — open-lane ticks on parent rows whose timestamps fall inside a live run's interval. This is the fact the app currently cannot show at all: today the strip shows chips in one part of the window and the roster shows rows in another, so nobody can see that the explore run overlapped the failed edit.
4. **Failure** — an error notch in clay that no fold can hide.

Everything else goes quiet and systematic to pay for it: five type sizes, two weights, five radii, one spacing scale, one popover geometry, one status pill, one search field, one caption, accent narrowed to money-focus-selection, zero gradients, one shadow, one animation class.

The column is **14px wide**. That is the discipline — boldness spent on meaning, not on area. It is also the only visual idea here that could not be lifted from a generic dashboard, because it is shaped by a fact specific to Claude Code: the session forks.

The three steps of cost weight are **not a chart**. Do not add a tooltip implying more precision than three steps have — the turn header already carries the exact figure and the asymmetry note.

---

## 6. Open questions — a human must decide these

**Q1 — Reading direction, and whether the Stream merge happens at all.** `Timeline.tsx:95` orders newest-first and `:203–215` follows at the top, deliberately, because live watching means new lines arrive at the top. `Trace.tsx:567` is chronological and grows downward. Three options, none free:

- **(a) Don't merge.** Keep three destinations, fix everything else. Zero user disruption, but the two search boxes, two filter vocabularies and two divergent scope chips stay.
- **(b) Merge chronological.** One Stream, bottom-growing, "tools only" as a density. Log users get an inverted view on first launch, and a "you are looking at the bottom" nudge is a poor substitute for the habit they had.
- **(c) Merge with an order toggle.** Stream carries `order: "newest" | "oldest"`, defaulting to newest for anyone whose last panel was Log and oldest for Trace users. Preserves both habits, but the rail's folio sequence, the sparse-time gaps and the fork/rejoin geometry all have to read correctly upside down — which is real work and may simply not look right.

**My recommendation is (a) for 1.4, revisit after the rail ships** — but this is a product call about user disruption, not a design one, and I will not make it silently.

**Q2 — Does the rail actually earn its ink?** The degradation contract is specified but unverified. Build `Rail.tsx` against two real transcripts — a 1-turn session and a 40-turn multi-agent one — and look at them side by side before committing Chunks 6 and 7. **If the rails look similar, revert the rail and keep the token/a11y/type work**, which is independently valuable. A rail on a session with no subagents and flat cost is a vertical line doing nothing, which is the exact "structural device as decoration" failure this direction claims to guard against.

**Q3 — Five type sizes vs. the Agents table.** `Agents.tsx:114–122` packs seven sortable columns into a 470px panel, reaching for 10 and 10.5px to fit. Under the scale it gets `F.micro` (10) or nothing. The honest resolution is **fewer columns**, not a sixth rung — but that is a data decision about which of the seven a user actually sorts by, and I don't have that evidence. If the column fight is lost, the scale grows a rung and the whole argument for a scale weakens.

**Q4 — Does the body-font flip look right?** Changing `body { font-family }` to Lora is the highest-leverage edit in the plan and the riskiest: it touches 81 style objects at once. `T.ui` pinned on chrome containers should contain it, but this needs a visual diff across all four window types before it ships. If it reads bookish in the dense control clusters, the fallbacks in order are: (i) pin `T.ui` on more containers, (ii) flip body to `T.mono` instead (fail toward machine language), (iii) revert to system-ui and accept the audit finding. **Do not ship this half-done** — there is a middle state where the app looks *more* inconsistent than it does today.

**Q5 — Is losing at-a-glance launcher liveness acceptable?** A user scanning twelve sessions currently sees which are alive from motion in peripheral vision. Under reduced-motion the hollow-ring fallback carries it, and dot+word carries it for everyone else — but dot+word at a glance is genuinely slower than motion at a glance. The reduced-motion guard is non-negotiable; whether to *also* keep pulse for users who haven't set the preference is a call.

**Q6 — Where does the skip-permissions setting live?** Moving it from a persistent full-width launcher card into the settings popover reclaims ~90px above the session list, and it duplicates the per-session chip anyway. But it is a setting with real safety consequences (`claude --dangerously-skip-permissions`), and burying a safety toggle one click deeper is a judgement call, not a layout one.

**Q7 — Does the folio ordinal survive real transcripts?** If real sessions are mostly single-tool one-liner turns, the panel becomes a ladder of numerals over two-line turns. Fallback: render the folio only when a turn exceeds ~4 rows. Check against a real transcript before fixing the size at 17px.

---

**Ship order:** 0 (1.3.2) → 1 (1.3.3) → 2 (1.4.0-alpha, mechanical) → 3 → 4 → 5 → 6 → *gate on Q1* → 7.