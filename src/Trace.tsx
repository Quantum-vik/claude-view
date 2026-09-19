/**
 * Trace.tsx
 * ---------
 * The panel that makes the terminal optional: every prompt, assistant message,
 * thinking block, tool call and subagent run, with cost on the turn.
 *
 * Fed by the `read_trace` command over issue #18's pager — pulled a page at a
 * time from the
 * transcripts on disk, because the largest real transcript parses in 46 ms and
 * caching it would be all the invalidation cost of a cache for no gain.
 *
 * Rendering follows the reactions recorded on #17:
 *
 *   - Serif is for human language, mono for machine language. A tool's error
 *     output is mono; a sentence Claude wrote about it is serif.
 *   - Thinking renders INLINE. Measured across 1,015 real blocks the median
 *     length is 0 and the max 364, so a disclosure hid less than the prose
 *     above it. Empty blocks never arrive (dropped server-side); the collapse
 *     branch survives above THINK_INLINE_MAX for a CLI that someday persists
 *     full reasoning.
 *   - Cost lives on the TURN. Tool rows carry no price, because usage is
 *     recorded per API request and splitting it across a turn's tool calls
 *     would be inventing data. The asymmetry is explained once, on the turn
 *     header, rather than defended on every row.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { T, tint, toolFamily } from "./tokens";
import { Button, Stat } from "./ui";
import type { ChangeSet, CommitSpan } from "./Changes";
import { useRoster } from "./Agents";
import type { TimelineEvent } from "./events";
import { runLabel, shorten, formatDuration, formatRunUsd, type AgentRun } from "./agents";
import { formatUsd, type TokenUsage } from "./cost";
import { CAVEAT, costOfTurn } from "./pricing";

/** Above this many characters a thinking block collapses. Real data maxes at 364. */
const THINK_INLINE_MAX = 600;
/** Fold this many consecutive same-tool successes behind one line. */
const FOLD_MIN = 3;
const PAGE_LIMIT = 500;

export type EntryKind = "prompt" | "assistant" | "thinking" | "tool" | "toolresult";

export interface TraceEntry {
  kind: EntryKind;
  offset: number;
  agentId?: string;
  turnId?: string;
  ts: number;
  text?: string;
  tool?: string;
  toolUseId?: string;
  isError?: boolean;
  persistedOutputPath?: string;
  truncated?: boolean;
}

interface TracePage {
  entries: TraceEntry[];
  cursor: string;
  hasMore: boolean;
  sources: string[];
  turns: Record<string, TokenUsage>;
  /** Present only when the trace could not be read — a typed absence, never an
   *  empty page, so "I cannot see" never renders as "nothing happened". */
  unavailable?: "no_transcript" | "unreadable";
}

/** A tool call joined to its result — the two arrive as separate entries. */
interface ToolRow {
  call: TraceEntry;
  result?: TraceEntry;
}

type Row =
  | { kind: "turn"; key: string; turnId: string; ts: number }
  | { kind: "entry"; key: string; entry: TraceEntry }
  | { kind: "tool"; key: string; row: ToolRow }
  | { kind: "fold"; key: string; tool: string; count: number; rows: ToolRow[] }
  | { kind: "agent"; key: string; agentId: string; count: number };

type Filter = "all" | "tools" | "replies" | "thinking" | "errors";

function hhmmss(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The timestamp of a row that actually RENDERS a clock.
 *
 *  Turn and agent headers are stamped in the data but draw no gutter, so they
 *  must not take part: letting a turn header claim its minute silently stole
 *  the clock from the first real row under it, and since that is the row a
 *  reader looks at to place a turn in time, every turn lost its timestamp. */
function rowTs(row: Row): number {
  switch (row.kind) {
    case "entry":
      return row.entry.ts;
    case "tool":
      return row.row.call.ts;
    case "fold":
      return row.rows[0]?.call.ts ?? 0;
    default:
      return 0;
  }
}

/** Print the clock only when the minute changes; otherwise leave the gap.
 *
 *  Measured in the rail prototype (#29) as the clearest single win in it, and
 *  the only one independent of the rail — which is why it survived the rail
 *  being cut. A full hh:mm:ss on every row is 58px of near-identical digits
 *  repeated down the panel: the eye reads it as texture, not as time, and the
 *  one row where time actually jumped is camouflaged by its neighbours.
 *
 *  Keyed by row, computed in DISPLAY order — the Stream reverses by turn while
 *  a session is live, so "the row above" is not "the row before" in the data.
 */
function clockRows(rows: Row[]): Set<string> {
  const show = new Set<string>();
  let lastMinute = -1;
  for (const r of rows) {
    const ts = rowTs(r);
    if (!ts) continue;
    const minute = Math.floor(ts / 60000);
    if (minute !== lastMinute) {
      show.add(r.key);
      lastMinute = minute;
    }
  }
  return show;
}

/** Pull the whole trace, page by page, and keep the cursor for the next call. */
function useTrace(vid: string) {
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [turns, setTurns] = useState<Record<string, TokenUsage>>({});
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sources, setSources] = useState<string[]>([]);
  const cursor = useRef("");
  const busy = useRef(false);

  const pull = useCallback(async () => {
    if (busy.current || !vid) return;
    busy.current = true;
    try {
      // Keep pulling while the server says there is more, so the panel settles
      // on the complete session rather than a first page.
      for (let guard = 0; guard < 200; guard++) {
        // A Tauri command, not a fetch: the webview is a different origin from
        // the local HTTP server, which exists for hooks and scripting and has
        // no CORS layer. `GET /trace/:id` remains available to scripts.
        const page = (await invoke("read_trace", {
          viewerId: vid,
          after: cursor.current || null,
          limit: PAGE_LIMIT,
        })) as TracePage;
        if (page.unavailable) {
          setUnavailable(page.unavailable);
          break;
        }
        setUnavailable(null);
        cursor.current = page.cursor;
        if (page.sources?.length) setSources(page.sources);
        if (page.entries.length) {
          setEntries((prev) => prev.concat(page.entries));
        }
        if (page.turns) {
          // Last-wins, matching the backend: a turn's output grows across the
          // records that carry it.
          setTurns((prev) => ({ ...prev, ...page.turns }));
        }
        if (!page.hasMore) break;
      }
    } catch {
      setUnavailable("unreadable");
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [vid]);

  useEffect(() => {
    void pull();
    // The transcript is written a beat after the event (0.135s / 0.244s
    // measured), so a modest poll keeps the panel current without the 1.5s the
    // tailer historically used.
    const t = setInterval(() => void pull(), 1200);
    return () => clearInterval(t);
  }, [pull]);

  return { entries, turns, unavailable, loading, sources };
}

/** Join tool calls to their results, then group into display rows. */
function buildRows(
  entries: TraceEntry[],
  turns: Record<string, TokenUsage>,
  filter: Filter,
  query: string,
  running?: Set<string>,
): Row[] {
  const q = query.trim().toLowerCase();
  const resultFor = new Map<string, TraceEntry>();
  for (const e of entries) {
    if (e.kind === "toolresult" && e.toolUseId) resultFor.set(e.toolUseId, e);
  }

  const matches = (e: TraceEntry, r?: TraceEntry) => {
    if (filter === "tools" && e.kind !== "tool") return false;
    if (filter === "replies" && e.kind !== "assistant" && e.kind !== "prompt") return false;
    if (filter === "thinking" && e.kind !== "thinking") return false;
    if (filter === "errors" && !(e.kind === "tool" && r?.isError)) return false;
    if (!q) return true;
    const hay = `${e.text ?? ""} ${e.tool ?? ""} ${r?.text ?? ""}`.toLowerCase();
    return hay.includes(q);
  };

  const rows: Row[] = [];
  let curTurn: string | null = null;
  let curAgent: string | null = null;
  let agentRun = 0;

  const visible = entries.filter((e) => {
    if (e.kind === "toolresult") return false; // folded into its call
    return matches(e, e.kind === "tool" && e.toolUseId ? resultFor.get(e.toolUseId) : undefined);
  });

  for (let i = 0; i < visible.length; i++) {
    const e = visible[i];
    const agent = e.agentId ?? null;

    if (agent !== curAgent) {
      curAgent = agent;
      curTurn = null;
      if (agent) {
        agentRun = visible.filter((x) => x.agentId === agent).length;
        rows.push({ kind: "agent", key: `a-${agent}`, agentId: agent, count: agentRun });
      }
    }
    // Turn headers are for the parent: a subagent's turns belong to its own
    // block and would otherwise interleave two numbering schemes.
    if (!agent && e.turnId && e.turnId !== curTurn && turns[e.turnId]) {
      curTurn = e.turnId;
      rows.push({ kind: "turn", key: `t-${e.turnId}`, turnId: e.turnId, ts: e.ts });
    }

    if (e.kind === "tool") {
      const row: ToolRow = {
        call: e,
        result: e.toolUseId ? resultFor.get(e.toolUseId) : undefined,
      };
      // Fold a run of consecutive same-tool successes behind one line — the
      // affordance worth keeping from the command log.
      //
      // An IN-FLIGHT tool is never folded and always breaks a run. Folding one
      // hides the single row the reader most needs to see: without this, three
      // consecutive Bash calls with the last still running collapse to
      // "3 × Bash" and the running state vanishes. Found by testing the merge,
      // not by reading it.
      const isRunning = (t?: TraceEntry) =>
        t?.toolUseId ? running?.has(t.toolUseId) === true : false;
      if (!row.result?.isError && !isRunning(e)) {
        let j = i;
        const run: ToolRow[] = [row];
        while (j + 1 < visible.length) {
          const n = visible[j + 1];
          if (n.kind !== "tool" || n.tool !== e.tool || (n.agentId ?? null) !== agent) break;
          const nr = n.toolUseId ? resultFor.get(n.toolUseId) : undefined;
          if (nr?.isError || isRunning(n)) break;
          run.push({ call: n, result: nr });
          j++;
        }
        if (run.length >= FOLD_MIN) {
          rows.push({
            kind: "fold",
            key: `f-${e.offset}-${agent ?? ""}`,
            tool: e.tool ?? "Tool",
            count: run.length,
            rows: run,
          });
          i = j;
          continue;
        }
      }
      rows.push({ kind: "tool", key: `r-${e.offset}-${agent ?? ""}`, row });
      continue;
    }
    rows.push({ kind: "entry", key: `e-${e.offset}-${agent ?? ""}`, entry: e });
  }
  return rows;
}

const Gutter = ({
  showClock = true,
  ts,
  mark,
  color,
  pulse,
}: {
  ts: number;
  mark: string;
  color?: string;
  pulse?: boolean;
  showClock?: boolean;
}) => (
  <>
    <span
      style={{
        flex: "0 0 58px",
        fontSize: 10,
        color: T.timestamp,
        fontFamily: T.mono,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {showClock ? hhmmss(ts) : ""}
    </span>
    <span
      className={pulse ? "cv-pulse" : undefined}
      style={{ flex: "0 0 14px", textAlign: "center", color: color ?? T.textFaint, fontSize: 11 }}
    >
      {mark}
    </span>
  </>
);

const ROW: React.CSSProperties = {
  display: "flex",
  gap: 9,
  padding: "3px 14px",
  alignItems: "baseline",
};

const ToolCard = memo(function ToolCard({
  row,
  running,
  showClock,
}: {
  row: ToolRow;
  running?: boolean;
  showClock?: boolean;
}) {
  const { call, result } = row;
  const fam = toolFamily(call.tool ?? "");
  const err = result?.isError === true;
  // In flight: the hooks say so and no result has landed. A transcript records
  // that a tool was CALLED, never that it has not come back — so without the
  // hook overlay the Stream would render a running tool identically to one
  // that returned nothing, which is the one way this merge could lose to the
  // command log it replaces.
  const inFlight = running === true && !result;
  const [open, setOpen] = useState(false);
  const out = result?.text ?? "";
  const long = out.split("\n").length > 6 || out.length > 400;
  const shown = open || !long ? out : out.split("\n").slice(0, 6).join("\n");

  return (
    <div style={ROW}>
      <Gutter
        showClock={showClock}
        ts={call.ts}
        mark={inFlight ? "●" : err ? "✗" : "✓"}
        color={inFlight ? T.running : err ? T.error : T.success}
        pulse={inFlight}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ color: fam.color, fontWeight: 600, fontSize: 11, fontFamily: T.mono }}>
          {fam.glyph} {call.tool}
        </span>
        <span
          style={{
            color: T.text,
            fontFamily: T.mono,
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {" "}
          {call.text}
        </span>
        {call.truncated && <span style={{ color: T.textFaint, fontSize: 10 }}> … (clipped)</span>}
        {out && (
          <div
            onClick={() => long && setOpen((o) => !o)}
            style={{
              margin: "4px 0 6px",
              padding: "7px 10px",
              background: err ? T.errorTint : T.surface1,
              borderLeft: `2px solid ${err ? T.error : T.border}`,
              color: err ? T.errorText : T.textDim,
              whiteSpace: "pre-wrap",
              fontFamily: T.mono,
              fontSize: 12,
              cursor: long ? "pointer" : "default",
              maxHeight: open ? "none" : 240,
              overflow: "hidden",
            }}
          >
            {shown}
            {long && !open && (
              <div style={{ color: T.textFaint, fontSize: 11, marginTop: 4 }}>
                ⌄ click to expand
                {result?.persistedOutputPath ? " — full output on disk" : ""}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

interface Props {
  vid: string;
  /** The session's model, for pricing turns. */
  modelId: string | null;
  /** The agent run the panel is scoped to, held above the panels so it
   *  survives switching between the trace and the command log (#25). */
  agentScope: string | null;
  onScope: (agentId: string | null) => void;
  /** The scope is a property of the surrounding window, not a filter the
   *  reader chose — set by `AgentWindow`, where the whole window IS one run.
   *
   *  Suppresses the removable pill (clearing it would show the entire session
   *  inside a window titled for one agent), the per-run headers (the window
   *  header already carries that identity), and the sibling-run count (a
   *  window showing one run has no business advertising its parent's others). */
  scopeLocked?: boolean;
  /** Hook-derived cards, keyed by tool-use id (`TimelineEvent.id` IS the
   *  tool-use id — see `apply_transcript` in session.rs). They arrive over the
   *  WebSocket ahead of the transcript, so they are the only source of "this
   *  tool is running RIGHT NOW": a transcript cannot express in-flight. */
  events?: TimelineEvent[];
  /** Live sessions read newest-first, ended ones oldest-first (#28). DERIVED
   *  from session state, never offered as a control — the direction tracks the
   *  use case instead of asking the reader to know which one they are in. */
  live?: boolean;
}

/** Commit spans for the session, so a turn can show what it left on disk (#36).
 *
 *  Fetched once, not polled: a diff is reviewed rather than watched, and the
 *  Stream already polls the transcript. A failure is silent on purpose — a
 *  session outside a repo has no spans, and that is not an error worth
 *  interrupting the stream for. The Changes panel is where absence is explained.
 */
function useCommitSpans(vid: string): CommitSpan[] {
  const [spans, setSpans] = useState<CommitSpan[]>([]);
  useEffect(() => {
    let live = true;
    invoke("read_changes", { viewerId: vid })
      .then((cs) => live && setSpans((cs as ChangeSet).spans ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [vid]);
  return spans;
}

export default function Trace({
  vid,
  modelId,
  agentScope,
  onScope,
  scopeLocked = false,
  events = [],
  live = false,
}: Props) {
  const { entries, turns, unavailable, loading, sources } = useTrace(vid);
  const { roster } = useRoster(vid);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [exporting, setExporting] = useState<string | null>(null);

  /** Export the whole trace, not the on-screen filtered view: a file that
   *  silently contained only what kind-tab and search happened to leave visible
   *  would be a trap. The ONE exception is a locked scope — in an agent window
   *  the run is the window's subject, not a filter the reader applied, so
   *  exporting its parent's whole session is the surprising outcome. */
  const doExport = useCallback(
    async (format: "md" | "json") => {
      setExporting(format);
      try {
        const path = await save({
          defaultPath: `claude-view-${vid.slice(0, 8)}.${format}`,
          filters: [
            format === "md"
              ? { name: "Markdown", extensions: ["md"] }
              : { name: "JSON", extensions: ["json"] },
          ],
        });
        if (!path) return; // user cancelled — not an error
        // The backend writes it: handing the body to the webview would mean
        // granting the frontend a write-any-file capability it has no other
        // need for.
        const out = (await invoke("export_trace", {
          viewerId: vid,
          format,
          dest: path,
          agent: scopeLocked ? agentScope : null,
        })) as { path: string; entries: number };
        setExported(`${out.entries} entries → ${out.path}`);
      } catch (e) {
        // Surface it rather than failing silently — an export that quietly
        // does nothing is indistinguishable from one that worked.
        setExportError(String(e));
      } finally {
        setExporting(null);
      }
    },
    [vid],
  );
  const [exportError, setExportError] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  /**
   * Keep the reader in place when the session ends.
   *
   * `live` flipping reverses the whole stream. Measured before this existed:
   * scrollTop stayed at 21808 of 48463 while the content under it reversed —
   * the reader was silently moved from 45% into a newest-first list to 45%
   * into an oldest-first one, a different part of the session, with nothing
   * said. Preserving the pixel offset is exactly the wrong thing; what has to
   * be preserved is the ROW.
   *
   * So: before the flip repaints, remember which row is at the top of the
   * viewport and how far into it we are; afterwards, put that same row back
   * there. The order changes around the reader instead of under them.
   */
  const scrollerRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const prevLive = useRef(live);
  /** Set when the order flips under an open panel, so the change is announced
   *  rather than merely survived. Not shown on first mount — a session that was
   *  already over when you opened it never reversed. */
  const [reversed, setReversed] = useState(false);

  if (prevLive.current !== live && scrollerRef.current) {
    const sc = scrollerRef.current;
    const top = sc.getBoundingClientRect().top;
    let best: { key: string; offset: number } | null = null;
    for (const el of Array.from(sc.querySelectorAll<HTMLElement>("[data-row]"))) {
      const r = el.getBoundingClientRect();
      if (r.bottom < top) continue; // fully scrolled past
      best = { key: el.dataset.row as string, offset: r.top - top };
      break;
    }
    anchor.current = best;
    prevLive.current = live;
    setReversed(true);
  }

  useLayoutEffect(() => {
    const a = anchor.current;
    const sc = scrollerRef.current;
    if (!a || !sc) return;
    anchor.current = null;
    const el = sc.querySelector<HTMLElement>(`[data-row="${CSS.escape(a.key)}"]`);
    if (!el) return; // the row was filtered out — leave the scroll alone
    const delta = el.getBoundingClientRect().top - sc.getBoundingClientRect().top - a.offset;
    sc.scrollTop += delta;
  }, [live]);

  const byAgent = useMemo(() => {
    const m = new Map<string, AgentRun>();
    for (const r of roster.runs) m.set(r.id, r);
    return m;
  }, [roster.runs]);
  const scopedRun = agentScope ? byAgent.get(agentScope) : undefined;

  // Scope narrows the stream to one run before kind and query touch it. The
  // three compose as AND, which is the only unsurprising answer.
  const scoped = useMemo(
    () => (agentScope ? entries.filter((e) => e.agentId === agentScope) : entries),
    [entries, agentScope],
  );

  const spans = useCommitSpans(vid);

  /** Which turn each commit belongs to: the last turn that had started when the
   *  commit was made. Entry timestamps are epoch MILLIseconds and git's are
   *  seconds, which is the kind of mismatch that silently assigns everything to
   *  turn one. */
  const spansByTurn = useMemo(() => {
    const m = new Map<string, CommitSpan[]>();
    if (!spans.length) return m;
    const starts: { id: string; ts: number }[] = [];
    let cur = "";
    for (const e of scoped) {
      if (e.turnId && e.turnId !== cur && !e.agentId) {
        cur = e.turnId;
        starts.push({ id: e.turnId, ts: e.ts });
      }
    }
    for (const sp of spans) {
      const at = sp.ts * 1000;
      let owner: string | null = null;
      for (const t of starts) {
        if (t.ts <= at) owner = t.id;
        else break;
      }
      // A commit made before the first turn belongs to no turn on screen —
      // dropping it beats attributing it to a turn that had not happened.
      if (owner) (m.get(owner) ?? m.set(owner, []).get(owner)!).push(sp);
    }
    return m;
  }, [spans, scoped]);

  /** Tool-use ids the hooks say are in flight. `TimelineEvent.id` IS the
   *  tool-use id, so this joins straight onto a trace entry's `toolUseId`.
   *  Without it the Stream cannot show a running tool at all — the transcript
   *  only records a `tool_use`, never "and it has not come back yet". */
  const running = useMemo(() => {
    const m = new Set<string>();
    for (const e of events) if (e.status === "running") m.add(e.id);
    return m;
  }, [events]);

  const rows = useMemo(() => {
    const built = buildRows(scoped, turns, filter, query, running);
    if (!live) return built;
    // Newest-first while the session is live — but reversed BY TURN, not by
    // row. Reversing rows outright would put each turn's header after its own
    // entries and its cost under the wrong turn. Blocks stay internally
    // ordered; only their order flips.
    const blocks: Row[][] = [];
    for (const r of built) {
      if (r.kind === "turn" || r.kind === "agent" || blocks.length === 0) blocks.push([r]);
      else blocks[blocks.length - 1].push(r);
    }
    blocks.reverse();
    return blocks.flat();
  }, [scoped, turns, filter, query, live, running]);

  /** Which rows print a clock. Derived from the FINAL order, so it stays
   *  correct when the stream reverses on a session ending. */
  const clocks = useMemo(() => clockRows(rows), [rows]);

  const tabs: Array<[Filter, string]> = [
    ["all", "all"],
    ["tools", "tools"],
    ["replies", "replies"],
    ["thinking", "thinking"],
    ["errors", "errors"],
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          padding: "7px 14px",
          borderBottom: `1px solid ${T.border}`,
          background: T.sidebar,
          flexShrink: 0,
        }}
      >
        {tabs.map(([f, label]) => (
          <Button key={f} variant="chip" on={filter === f} onClick={() => setFilter(f)}>
            {label}
          </Button>
        ))}
        {agentScope && !scopeLocked && (
          <span
            title={scopedRun ? runLabel(scopedRun) : agentScope}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: tint("var(--cv-tool-task)", 0.15),
              border: `1px solid ${tint("var(--cv-tool-task)", 0.45)}`,
              borderRadius: 999,
              padding: "2px 4px 2px 9px",
              fontSize: 11,
              fontFamily: T.serif,
              color: "var(--cv-tool-task)",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {/* Middle-truncated: an agent description's identifying token is
                at the END, so a right-ellipsis makes runs indistinguishable. */}
            {shorten(scopedRun ? runLabel(scopedRun) : `agent-${agentScope.slice(0, 12)}`, 30)}
            <button
              onClick={() => onScope(null)}
              title="Show the whole session again"
              style={{
                background: "none",
                border: "none",
                color: "inherit",
                cursor: "pointer",
                fontSize: 13,
                lineHeight: 1,
                padding: "1px 5px",
              }}
            >
              ✕
            </button>
          </span>
        )}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={agentScope ? "search within this run…" : "search the whole trace…"}
          style={{
            flex: 1,
            maxWidth: 360,
            background: T.surface2,
            border: `1px solid ${T.border}`,
            color: T.text,
            borderRadius: 5,
            padding: "4px 9px",
            font: `12px ${T.mono}`,
          }}
        />
        <span style={{ marginLeft: "auto", fontSize: 11, color: T.textFaint, fontFamily: T.mono }}>
          {!scopeLocked && sources.length > 1 && `${sources.length - 1} subagents · `}
          {rows.length} rows
        </span>
        {(["md", "json"] as const).map((f) => (
          <button
            key={f}
            onClick={() => void doExport(f)}
            disabled={exporting !== null || !!unavailable}
            title={
              f === "md"
                ? "Export the whole session as Markdown — readable, shareable"
                : "Export the whole session as JSON — tokens per turn, every entry"
            }
            style={{
              background: T.surface2,
              border: `1px solid ${T.border}`,
              borderRadius: 6,
              color: exporting === f ? T.accent : T.textDim,
              cursor: exporting || unavailable ? "default" : "pointer",
              fontSize: 10.5,
              fontFamily: T.mono,
              padding: "3px 8px",
              opacity: unavailable ? 0.4 : 1,
            }}
          >
            {exporting === f ? "…" : `↓ ${f}`}
          </button>
        ))}
      </div>

      {exported && (
        <div
          onClick={() => setExported(null)}
          style={{
            padding: "6px 14px",
            background: tint(T.success, 0.12),
            color: T.success,
            fontSize: 11.5,
            fontFamily: T.mono,
            cursor: "pointer",
          }}
        >
          Exported {exported} (click to dismiss)
        </div>
      )}
      {exportError && (
        <div
          onClick={() => setExportError(null)}
          style={{
            padding: "6px 14px",
            background: T.errorTint,
            color: T.errorText,
            fontSize: 11.5,
            fontFamily: T.mono,
            cursor: "pointer",
          }}
        >
          Export failed: {exportError} (click to dismiss)
        </div>
      )}

      {reversed && (
        <div
          onClick={() => setReversed(false)}
          style={{
            padding: "6px 14px",
            background: tint(T.running, 0.12),
            borderBottom: `1px solid ${tint(T.running, 0.3)}`,
            color: T.running,
            fontSize: 11.5,
            fontFamily: T.mono,
            cursor: "pointer",
          }}
        >
          {live
            ? "Session resumed — newest turns are at the top again."
            : "Session ended — the stream now reads oldest-first. You are still on the same turn."}{" "}
          <span style={{ color: T.textFaint }}>(click to dismiss)</span>
        </div>
      )}

      <div ref={scrollerRef} style={{ flex: 1, overflow: "auto", padding: "6px 0 40px" }}>
        {unavailable && (
          <div style={{ padding: 20, color: T.textDim, font: `13px ${T.serif}` }}>
            {unavailable === "no_transcript" ? (
              <>
                <b style={{ color: T.running }}>No transcript for this session.</b>
                <div style={{ marginTop: 6, fontSize: 12.5, maxWidth: "62ch" }}>
                  Claude Code has not written one yet, or it is not writing one at all — a session
                  launched from inside another Claude Code session inherits{" "}
                  <code style={{ fontFamily: T.mono }}>CLAUDE_CODE_CHILD_SESSION</code> and disables
                  transcript persistence. The terminal still works; the trace cannot.
                </div>
              </>
            ) : (
              <b style={{ color: T.error }}>The transcript could not be read.</b>
            )}
          </div>
        )}
        {!unavailable && loading && entries.length === 0 && (
          <div style={{ padding: 20, color: T.textFaint, font: `italic 13px ${T.serif}` }}>
            Reading the transcript…
          </div>
        )}
        {!unavailable && !loading && rows.length === 0 && (
          <div
            style={{
              padding: 20,
              color: T.textDim,
              font: `13px ${T.serif}`,
              maxWidth: "58ch",
              lineHeight: 1.6,
            }}
          >
            {/* Naming the filter matters: "no thinking in this run" and "no
                match for that word" are different facts, and a reader who
                cannot tell them apart concludes the panel is broken. */}
            {entries.length === 0
              ? "Nothing in the trace yet."
              : scoped.length === 0
                ? `Nothing from ${scopedRun ? runLabel(scopedRun) : "this run"} in the trace yet.`
                : query.trim()
                  ? `No match for “${query.trim()}”${agentScope ? " within this run" : ""}${filter !== "all" ? ` among ${filter}` : ""}.`
                  : `No ${filter} ${agentScope ? "in this run" : "in this session"}.`}
          </div>
        )}
        {rows.map((r) => (
          // data-row is the anchor the reversal uses to keep the reader in
          // place; the wrapper exists for that and nothing else.
          <div key={r.key} data-row={r.key}>
            <RowView
              row={r}
              turns={turns}
              spans={spansByTurn.get(r.kind === "turn" ? r.turnId : "")}
              showClock={clocks.has(r.key)}
              modelId={modelId}
              runs={byAgent}
              running={running}
              hideAgentHeaders={scopeLocked}
              onScopeTo={scopeLocked ? undefined : onScope}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** What a turn left on disk, shown on the turn it landed in.
 *
 *  #37 rejected folding the whole diff into the Stream — browsing 60 files
 *  belongs in the Changes panel — but kept its premise: seeing WHEN something
 *  changed is worth having where you read the session. So this is a count and a
 *  churn figure, never a file list.
 *
 *  A turn that changed nothing renders nothing at all. No bar, no "0 files": a
 *  change mark is a signal that something happened, and a column of empty ones
 *  trains the eye to stop looking.
 */
function TurnChanges({ spans }: { spans: CommitSpan[] }) {
  const files = new Set<string>();
  let add = 0;
  let rem = 0;
  for (const s of spans) {
    for (const f of s.files) files.add(f);
    add += s.add;
    rem += s.rem;
  }
  const n = files.size;
  return (
    <span
      title={spans.map((s) => `${s.sha}  ${s.subject}`).join("\n")}
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 6,
        padding: "0 7px",
        borderRadius: 3,
        background: tint(T.accent, 0.1),
        color: T.textDim,
      }}
    >
      <span>
        {n} file{n === 1 ? "" : "s"}
      </span>
      <Stat add={add} rem={rem} />
    </span>
  );
}

const RowView = memo(function RowView({
  row,
  turns,
  spans,
  showClock,
  modelId,
  runs,
  running,
  hideAgentHeaders,
  onScopeTo,
}: {
  row: Row;
  turns: Record<string, TokenUsage>;
  modelId: string | null;
  /** Tool-use ids the hooks report as in flight. */
  running?: Set<string>;
  /** Roster metadata by agent id, so a run's block can open with what it was
   *  asked to do instead of a hex prefix. */
  runs: Map<string, AgentRun>;
  /** Commits made during this turn, if any. Absent for every other row kind,
   *  and for a turn that left nothing on disk — which is most of them: one
   *  measured session had 147 turns and 10 commits. */
  spans?: CommitSpan[];
  /** Print the clock on this row. False for a row in the same minute as the one
   *  above it — the gutter keeps its width so nothing shifts. */
  showClock?: boolean;
  /** The surrounding window already names the run — don't repeat it per block. */
  hideAgentHeaders?: boolean;
  /** Filter the trace to this run. Lives on the run header because that is
   *  where "isolate what I am already reading" is the obvious gesture —
   *  clicking a run in the roster or the strip OPENS it instead. */
  onScopeTo?: (agentId: string) => void;
}) {
  if (row.kind === "turn") {
    const u = turns[row.turnId];
    const usd = u
      ? costOfTurn(modelId, {
          input: u.input,
          cacheRead: u.cacheRead,
          cacheWrite5m: u.cacheWrite5m,
          cacheWrite1h: u.cacheWrite1h,
          output: u.output,
        })
      : null;
    const tokens = u ? u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h + u.output : 0;
    return (
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "baseline",
          padding: "9px 14px 3px",
          fontSize: 10.5,
          color: T.textFaint,
          fontFamily: T.mono,
          borderTop: `1px solid ${tint(T.border, 0.7)}`,
        }}
      >
        <span>turn</span>
        <span style={{ color: T.textDim }}>{row.turnId.slice(0, 16)}…</span>
        {spans?.length ? <TurnChanges spans={spans} /> : null}
        <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums", color: T.textDim }}>
          {tokens.toLocaleString()} tokens
          {usd !== null ? (
            <>
              {" · "}
              <b style={{ color: T.accent, fontWeight: 600 }}>{formatUsd(usd)}</b>
            </>
          ) : (
            <span style={{ color: T.running }}> · {CAVEAT.unpricedLabel}</span>
          )}
          {/* The asymmetry explained ONCE, where the absence is, rather than
              defended on every row. */}
          <span
            title={
              "Cost is recorded per turn, not per tool call, so individual tool rows show no " +
              "price — splitting a turn across its tool calls would be inventing data. A subagent " +
              "block does show one: its cost is measured from the subagent's own transcript.\n\n" +
              CAVEAT.tooltip
            }
            style={{
              marginLeft: 5,
              cursor: "help",
              borderBottom: `1px dotted ${T.textFaint}`,
            }}
          >
            ?
          </span>
        </span>
      </div>
    );
  }

  if (row.kind === "agent") {
    if (hideAgentHeaders) return null;
    // Promoted from a hairline to a real section opening (#22). The prototype's
    // spine and band both lost to this: identity and cost belong exactly where
    // the run's work appears, not in a rail beside it.
    const run = runs.get(row.agentId);
    const usd = run?.model
      ? costOfTurn(run.model, {
          input: run.usage.input,
          cacheWrite5m: run.usage.cacheWrite5m,
          cacheWrite1h: run.usage.cacheWrite1h,
          cacheRead: run.usage.cacheRead,
          output: run.usage.output,
        })
      : null;
    return (
      <div
        onClick={onScopeTo ? () => onScopeTo(row.agentId) : undefined}
        title={onScopeTo ? "Show only this run" : undefined}
        style={{
          margin: "14px 14px 6px 22px",
          padding: "9px 12px",
          border: `1px solid ${tint("var(--cv-tool-task)", 0.4)}`,
          borderLeft: `3px solid var(--cv-tool-task)`,
          borderRadius: "0 6px 6px 0",
          background: tint("var(--cv-tool-task)", 0.06),
          cursor: onScopeTo ? "pointer" : undefined,
        }}
      >
        <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
          {/* The description is human language, so serif — the rule tokens.ts
              already sets for the panel. */}
          <span style={{ fontFamily: T.serif, fontSize: 14, lineHeight: 1.35, color: T.text }}>
            {run ? runLabel(run) : `agent-${row.agentId.slice(0, 12)}`}
          </span>
          {run && (
            <span
              title={
                run.status === "running"
                  ? "No result for this run's task call yet — still running, or the session ended mid-run. The transcript cannot tell those apart."
                  : run.status === "unknown"
                    ? "No task call recorded for this run, so whether it finished is unknowable."
                    : "The parent session recorded a result for this run's task call."
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                font: `10.5px ${T.mono}`,
                color:
                  run.status === "done"
                    ? T.success
                    : run.status === "running"
                      ? T.running
                      : T.textFaint,
              }}
            >
              <span
                className={run.status === "running" ? "cv-pulse" : undefined}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 99,
                  background: "currentColor",
                }}
              />
              {run.status}
            </span>
          )}
        </div>
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "baseline",
            marginTop: 5,
            font: `10.5px ${T.mono}`,
            color: T.textFaint,
            flexWrap: "wrap",
          }}
        >
          {run?.agentType && <span style={{ color: "var(--cv-tool-task)" }}>{run.agentType}</span>}
          {run?.model && <span>{run.model.replace(/^claude-/, "").replace(/-\d{8}$/, "")}</span>}
          {run && run.endedAt > run.startedAt && (
            <span>{formatDuration(run.endedAt - run.startedAt)}</span>
          )}
          <span>{run ? `${run.tools} tools` : `${row.count} entries`}</span>
          {/* A subagent block is the ONE place a cost figure sits on something
              that is not a turn — and only because it is measured from the
              run's own transcript, never amortized (#15). */}
          {usd !== null && (
            <span style={{ marginLeft: "auto", color: T.textDim }}>
              {/* Same formatter as the roster: a run showing $3.00 here and
                  $2.995 there is one number in two dialects. */}
              <b style={{ color: T.accent, fontVariantNumeric: "tabular-nums" }}>
                {formatRunUsd(usd)}
              </b>{" "}
              measured
            </span>
          )}
        </div>
      </div>
    );
  }

  if (row.kind === "fold") {
    const fam = toolFamily(row.tool);
    return (
      <div style={{ ...ROW, color: T.textFaint, fontSize: 11.5, fontFamily: T.mono }}>
        <Gutter ts={row.rows[0].call.ts} mark="⌄" showClock={showClock} />
        <span>
          {row.count} ×{" "}
          <span style={{ color: fam.color }}>
            {fam.glyph} {row.tool}
          </span>{" "}
          — all succeeded
        </span>
      </div>
    );
  }

  if (row.kind === "tool")
    return (
      <ToolCard
        row={row.row}
        running={row.row.call.toolUseId ? running?.has(row.row.call.toolUseId) : false}
        showClock={showClock}
      />
    );

  const e = row.entry;
  if (e.kind === "prompt") {
    return (
      <div style={ROW}>
        <Gutter ts={e.ts} mark="▍" color={T.accent} showClock={showClock} />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            font: `italic 13px/1.6 ${T.serif}`,
            color: T.text,
            borderLeft: `2px solid ${T.accent}`,
            paddingLeft: 10,
            margin: "5px 0",
            whiteSpace: "pre-wrap",
          }}
        >
          {e.text}
        </div>
      </div>
    );
  }
  if (e.kind === "assistant") {
    return (
      <div style={ROW}>
        <Gutter ts={e.ts} mark="✻" color={T.modelViolet} showClock={showClock} />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            font: `13.5px/1.68 ${T.serif}`,
            color: T.text,
            maxWidth: "74ch",
            whiteSpace: "pre-wrap",
          }}
        >
          {e.text}
        </div>
      </div>
    );
  }
  // Thinking: inline. Empty blocks never arrive — the server drops them.
  const text = e.text ?? "";
  const long = text.length > THINK_INLINE_MAX;
  return (
    <div style={ROW}>
      <Gutter ts={e.ts} mark="◦" showClock={showClock} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          font: `italic 12.5px/1.6 ${T.serif}`,
          color: T.textFaint,
          maxWidth: "80ch",
          whiteSpace: "pre-wrap",
        }}
      >
        {long ? (
          <details>
            <summary style={{ cursor: "pointer", font: `11px ${T.mono}` }}>
              thinking — {text.length} chars
            </summary>
            {text}
          </details>
        ) : (
          text
        )}
      </div>
    </div>
  );
});
