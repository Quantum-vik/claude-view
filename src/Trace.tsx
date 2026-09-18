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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { T, tint, toolFamily } from "./tokens";
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
      // affordance worth keeping from Timeline.tsx.
      if (!row.result?.isError) {
        let j = i;
        const run: ToolRow[] = [row];
        while (j + 1 < visible.length) {
          const n = visible[j + 1];
          if (n.kind !== "tool" || n.tool !== e.tool || (n.agentId ?? null) !== agent) break;
          const nr = n.toolUseId ? resultFor.get(n.toolUseId) : undefined;
          if (nr?.isError) break;
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

const Gutter = ({ ts, mark, color }: { ts: number; mark: string; color?: string }) => (
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
      {hhmmss(ts)}
    </span>
    <span style={{ flex: "0 0 14px", textAlign: "center", color: color ?? T.textFaint, fontSize: 11 }}>
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

const ToolCard = memo(function ToolCard({ row }: { row: ToolRow }) {
  const { call, result } = row;
  const fam = toolFamily(call.tool ?? "");
  const err = result?.isError === true;
  const [open, setOpen] = useState(false);
  const out = result?.text ?? "";
  const long = out.split("\n").length > 6 || out.length > 400;
  const shown = open || !long ? out : out.split("\n").slice(0, 6).join("\n");

  return (
    <div style={ROW}>
      <Gutter ts={call.ts} mark={err ? "✗" : "✓"} color={err ? T.error : T.success} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ color: fam.color, fontWeight: 600, fontSize: 11, fontFamily: T.mono }}>
          {fam.glyph} {call.tool}
        </span>
        <span
          style={{
            color: T.text,
            fontFamily: T.mono,
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
}

export default function Trace({ vid, modelId }: Props) {
  const { entries, turns, unavailable, loading, sources } = useTrace(vid);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const rows = useMemo(
    () => buildRows(entries, turns, filter, query),
    [entries, turns, filter, query],
  );

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
          <span
            key={f}
            onClick={() => setFilter(f)}
            style={{
              fontSize: 11,
              padding: "3px 9px",
              borderRadius: 999,
              cursor: "pointer",
              fontFamily: T.mono,
              color: filter === f ? T.accent : T.textDim,
              background: filter === f ? tint(T.accent, 0.15) : "transparent",
              border: `1px solid ${filter === f ? T.borderAccent : "transparent"}`,
            }}
          >
            {label}
          </span>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search the whole trace…"
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
          {sources.length > 1 && `${sources.length - 1} subagents · `}
          {rows.length} rows
        </span>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "6px 0 40px" }}>
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
        {rows.map((r) => (
          <RowView key={r.key} row={r} turns={turns} modelId={modelId} />
        ))}
      </div>
    </div>
  );
}

const RowView = memo(function RowView({
  row,
  turns,
  modelId,
}: {
  row: Row;
  turns: Record<string, TokenUsage>;
  modelId: string | null;
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
    return (
      <div
        style={{
          display: "flex",
          gap: 9,
          alignItems: "baseline",
          margin: "8px 0 2px 22px",
          padding: "6px 10px",
          borderLeft: `2px solid var(--cv-tool-task)`,
          background: tint("var(--cv-tool-task)", 0.05),
          fontSize: 11,
          fontFamily: T.mono,
          color: "var(--cv-tool-task)",
        }}
      >
        » subagent <b>{row.agentId.slice(0, 12)}</b>
        <span style={{ marginLeft: "auto", color: T.textFaint }}>{row.count} entries</span>
      </div>
    );
  }

  if (row.kind === "fold") {
    const fam = toolFamily(row.tool);
    return (
      <div style={{ ...ROW, color: T.textFaint, fontSize: 11.5, fontFamily: T.mono }}>
        <Gutter ts={row.rows[0].call.ts} mark="⌄" />
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

  if (row.kind === "tool") return <ToolCard row={row.row} />;

  const e = row.entry;
  if (e.kind === "prompt") {
    return (
      <div style={ROW}>
        <Gutter ts={e.ts} mark="▍" color={T.accent} />
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
        <Gutter ts={e.ts} mark="✻" color={T.modelViolet} />
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
      <Gutter ts={e.ts} mark="◦" />
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
