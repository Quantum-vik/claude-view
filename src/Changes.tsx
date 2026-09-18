/**
 * Changes — what this session did to the repo.
 *
 * The third panel view (#37). Left: every changed file, grouped by area and
 * ranked by churn inside its group. Right: the diff, always on screen.
 *
 * Why not either whole variant from the prototype: a flat list of 60 files
 * buries the thing you most need to see — one real session's largest single
 * change was a 720-line deletion, one row among sixty. Grouping surfaces it.
 * But routing every diff through an overlay is heavy ceremony for "what did
 * this line change", so the diff pane stays put.
 *
 * Two mistakes the prototype made, both invisible until rendered, both easy to
 * reintroduce:
 *
 *   - A fixed-width churn bar shows only the add/remove RATIO. Magnitude is the
 *     entire signal — a 1,055-line addition and a 1-line edit looked identical.
 *     The bar is scaled by total churn against the largest file on screen.
 *   - Opening on file index 0 lands in whichever group happens to sort last, so
 *     the pane disagreed with the visible list. It opens on the largest file of
 *     the largest group.
 *
 * Fetched on demand, not polled: a diff is reviewed, not watched (#36).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { T, tint } from "./tokens";

export interface ChangedFile {
  path: string;
  oldPath: string | null;
  /** A added · M modified · D deleted · R renamed · U untracked. */
  status: string;
  add: number;
  rem: number;
  binary: boolean;
  modeChanged: boolean;
  oldMode: string;
  newMode: string;
  similarity: number | null;
}

export interface CommitSpan {
  sha: string;
  subject: string;
  ts: number;
  files: string[];
  add: number;
  rem: number;
}

export interface ChangeSet {
  baseline: string | null;
  head: string | null;
  files: ChangedFile[];
  spans: CommitSpan[];
  totals: { files: number; add: number; rem: number };
  unavailable?: string;
}

/** Above this many changed lines a file collapses to its header. A generated
 *  lock file runs to thousands of lines nobody reads, and left expanded it
 *  pushes every real change off the screen (#35). */
const COLLAPSE_OVER = 800;

/** Groups, in the order they appear. `Generated` is pinned last however big it
 *  is: churn-ranking is only honest when the ranking reflects attention, and a
 *  lock file earns none. */
const GENERATED = "Generated";

function areaOf(path: string): string {
  if (/(^|\/)(package-lock\.json|Cargo\.lock|.*\.lock)$/.test(path)) return GENERATED;
  if (/\.min\.(js|css)$/.test(path) || /(^|\/)(vendor|node_modules)\//.test(path)) return GENERATED;
  if (path.startsWith("src/") || path.startsWith("src-tauri/src/")) return "Source";
  if (path.startsWith("docs/") || path.endsWith(".md")) return "Writing";
  if (path.startsWith("packaging/") || path.startsWith("prototypes/")) return "Packaging";
  return "Config";
}

const dirOf = (p: string) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i + 1);
};
const baseOf = (p: string) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
};
const churnOf = (f: ChangedFile) => f.add + f.rem;

const STATUS_INK: Record<string, string> = {
  A: T.success,
  M: T.accent,
  D: T.error,
  R: T.modelViolet,
  U: T.textDim,
};

/** Why there is nothing to show. Each cause reads differently to a person and
 *  only some are fixable by them, so none of these share a message (#34). */
const ABSENT: Record<string, { head: string; body: string[] }> = {
  not_a_repo: {
    head: "No diff here",
    body: [
      "This session ran in a directory that isn’t a git repository, so there’s nothing to measure changes against.",
      "Sessions started inside a repo get a full record of what changed.",
    ],
  },
  worktree_gone: {
    head: "That directory is gone",
    body: [
      "This session ran in a worktree that no longer exists on disk.",
      "Its transcript is still readable in the Stream.",
    ],
  },
  no_commits: {
    head: "Nothing to measure from",
    body: [
      "This repository has no commits yet, so there’s no starting point.",
      "Make a first commit and later sessions will show their changes.",
    ],
  },
  older_than_reflog: {
    head: "This session is older than git’s memory",
    body: [
      "The starting point is read from git’s reflog, which keeps about 90 days by default. This session began before that window.",
      "Newer sessions are unaffected.",
    ],
  },
  git_unavailable: {
    head: "git isn’t available",
    body: ["claude-view reads changes by running git, and couldn’t start it."],
  },
};

function Absent({ why }: { why: string }) {
  const m = ABSENT[why] ?? {
    head: "No changes to show",
    body: ["claude-view couldn’t work out what this session changed."],
  };
  return (
    <div style={{ maxWidth: "46ch", margin: "14vh auto", padding: "0 20px" }}>
      <h2 style={{ font: `600 15px ${T.serif}`, color: T.text, margin: "0 0 8px" }}>{m.head}</h2>
      {m.body.map((p) => (
        <p key={p} style={{ font: `13px/1.65 ${T.serif}`, color: T.textDim, margin: "0 0 10px" }}>
          {p}
        </p>
      ))}
    </div>
  );
}

function Stat({ add, rem }: { add: number; rem: number }) {
  return (
    <span style={{ fontFamily: T.mono, fontSize: 10.5, whiteSpace: "nowrap" }}>
      <span style={{ color: T.success }}>+{add}</span>{" "}
      <span style={{ color: T.error }}>−{rem}</span>
    </span>
  );
}

/** Width carries magnitude, the split carries the ratio. Both are load-bearing:
 *  a fixed width silently reduces this to the ratio alone. */
function ChurnBar({ f, largest }: { f: ChangedFile; largest: number }) {
  const width = Math.max(4, Math.round((churnOf(f) / Math.max(1, largest)) * 92));
  return (
    <span
      aria-hidden
      style={{ display: "flex", width, height: 3, borderRadius: 2, overflow: "hidden", flex: "none" }}
    >
      <i style={{ flex: f.add || 0, background: T.success }} />
      <i style={{ flex: f.rem || 0, background: T.error }} />
    </span>
  );
}

export default function Changes({ vid }: { vid: string }) {
  const [cs, setCs] = useState<ChangeSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const patchFor = useRef<string | null>(null);

  const pull = useCallback(async () => {
    try {
      setCs((await invoke("read_changes", { viewerId: vid })) as ChangeSet);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [vid]);

  useEffect(() => {
    void pull();
  }, [pull]);

  const groups = useMemo(() => {
    if (!cs) return [];
    const m = new Map<string, ChangedFile[]>();
    for (const f of cs.files) {
      const a = areaOf(f.path);
      (m.get(a) ?? m.set(a, []).get(a)!).push(f);
    }
    for (const fs of m.values()) fs.sort((a, b) => churnOf(b) - churnOf(a));
    return [...m.entries()].sort((a, b) =>
      // Generated last whatever its size; everything else by how much of the
      // session it accounts for.
      a[0] === GENERATED ? 1 : b[0] === GENERATED ? -1 : b[1].length - a[1].length,
    );
  }, [cs]);

  // The first row of the first group, which is what the eye lands on. Index 0
  // would be whichever file git happened to list first.
  const firstRow = groups[0]?.[1][0]?.path ?? null;
  const current = sel ?? firstRow;

  useEffect(() => {
    if (!current || patchFor.current === current) return;
    patchFor.current = current;
    setPatch(null);
    setExpanded(false);
    invoke("read_patch", { viewerId: vid, path: current })
      .then((p) => setPatch(p as string))
      .catch(() => setPatch(""));
  }, [current, vid]);

  const largest = useMemo(
    () => Math.max(1, ...(cs?.files ?? []).map(churnOf)),
    [cs],
  );
  const file = cs?.files.find((f) => f.path === current) ?? null;

  if (error) return <Absent why="git_unavailable" />;
  if (!cs) return <div style={{ padding: 20, color: T.textDim, font: `13px ${T.serif}` }}>Reading…</div>;
  if (cs.unavailable) return <Absent why={cs.unavailable} />;
  if (!cs.files.length)
    return (
      <div style={{ maxWidth: "46ch", margin: "14vh auto", padding: "0 20px" }}>
        <h2 style={{ font: `600 15px ${T.serif}`, color: T.text, margin: "0 0 8px" }}>
          This session changed no files
        </h2>
        <p style={{ font: `13px/1.65 ${T.serif}`, color: T.textDim, margin: 0 }}>
          Nothing on disk differs from where it started, at {cs.baseline}.
        </p>
      </div>
    );

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
      <div
        style={{
          width: 330,
          flex: "none",
          overflow: "auto",
          borderRight: `1px solid ${T.border}`,
          background: T.sidebar,
        }}
      >
        <div
          style={{
            padding: "9px 12px",
            borderBottom: `1px solid ${T.divider}`,
            color: T.textFaint,
            fontFamily: T.mono,
            fontSize: 11,
          }}
        >
          {cs.totals.files} files · <Stat add={cs.totals.add} rem={cs.totals.rem} /> · since{" "}
          <span style={{ color: T.accent }}>{cs.baseline}</span>
        </div>

        {groups.map(([name, fs]) => {
          const add = fs.reduce((a, f) => a + f.add, 0);
          const rem = fs.reduce((a, f) => a + f.rem, 0);
          return (
            <div key={name}>
              <div
                style={{
                  position: "sticky",
                  top: 0,
                  zIndex: 2,
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  padding: "6px 12px 4px",
                  background: T.sidebar,
                  borderBottom: `1px solid ${T.divider}`,
                }}
              >
                <b style={{ font: `600 12.5px ${T.serif}`, color: T.text }}>{name}</b>
                <span style={{ color: T.textFaint, fontSize: 10.5, fontFamily: T.mono }}>{fs.length}</span>
                <span style={{ marginLeft: "auto" }}>
                  <Stat add={add} rem={rem} />
                </span>
              </div>
              {fs.map((f) => {
                const on = f.path === current;
                return (
                  <button
                    key={f.path}
                    onClick={() => setSel(f.path)}
                    title={f.path}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      width: "100%",
                      textAlign: "left",
                      padding: on ? "4px 12px 4px 10px" : "4px 12px",
                      border: "none",
                      borderLeft: on ? `2px solid ${T.accent}` : "none",
                      background: on ? tint(T.accent, 0.12) : "transparent",
                      color: T.text,
                      cursor: "pointer",
                      fontFamily: T.mono,
                      fontSize: 11.5,
                    }}
                  >
                    <span
                      aria-hidden
                      style={{ width: 12, textAlign: "center", fontWeight: 600, color: STATUS_INK[f.status] ?? T.textDim }}
                    >
                      {f.status}
                    </span>
                    <span
                      style={{
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {/* Directory, not just the filename: one real session had
                          four .gitignores and three template.htmls. */}
                      <span style={{ color: T.textFaint }}>{dirOf(f.path)}</span>
                      <span style={{ color: T.text }}>{baseOf(f.path)}</span>
                    </span>
                    <ChurnBar f={f} largest={largest} />
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      <div style={{ flex: 1, minWidth: 0, overflow: "auto", padding: "0 14px 40px" }}>
        {file && (
          <div
            style={{
              position: "sticky",
              top: 0,
              background: T.surface,
              padding: "11px 0 8px",
              borderBottom: `1px solid ${T.divider}`,
            }}
          >
            <div style={{ fontFamily: T.mono, fontSize: 12.5 }}>
              <span style={{ color: T.textFaint }}>{dirOf(file.path)}</span>
              <b style={{ color: T.text }}>{baseOf(file.path)}</b>
            </div>
            <div style={{ color: T.textFaint, fontFamily: T.mono, fontSize: 11, marginTop: 3 }}>
              {/* git does not record renames — it infers them from similarity,
                  and the threshold is a dial. Say so rather than asserting it. */}
              {file.oldPath && (
                <>
                  looks renamed from {file.oldPath}
                  {file.similarity != null && ` (${file.similarity}% similar)`} ·{" "}
                </>
              )}
              {file.modeChanged && (
                <>
                  mode {file.oldMode} → {file.newMode} ·{" "}
                </>
              )}
              <Stat add={file.add} rem={file.rem} />
            </div>
          </div>
        )}
        <DiffBody file={file} patch={patch} expanded={expanded} onExpand={() => setExpanded(true)} />
      </div>
    </div>
  );
}

/** Rows with nothing to render say what they are instead of showing an empty
 *  pane — a delete has no "after", a binary has no readable diff, and a
 *  mode-only change has no lines at all (#35). */
function DiffBody({
  file,
  patch,
  expanded,
  onExpand,
}: {
  file: ChangedFile | null;
  patch: string | null;
  expanded: boolean;
  onExpand: () => void;
}) {
  const note = (s: string) => (
    <div style={{ padding: "14px 0", color: T.textDim, font: `13px ${T.serif}` }}>{s}</div>
  );
  if (!file) return null;
  if (file.binary) return note("Binary file — no readable diff.");
  if (file.modeChanged && churnOf(file) === 0)
    return note(`Permissions changed from ${file.oldMode} to ${file.newMode}. The contents are unchanged.`);
  if (file.status === "U") return note("New file, not yet added to git.");
  if (patch === null) return note("Loading…");
  if (!patch.trim()) return note("No textual diff.");

  if (churnOf(file) > COLLAPSE_OVER && !expanded)
    return (
      <div style={{ padding: "14px 0" }}>
        <div style={{ color: T.textDim, font: `13px ${T.serif}`, marginBottom: 8 }}>
          {churnOf(file).toLocaleString()} changed lines, collapsed so it doesn’t bury the rest.
        </div>
        <button
          onClick={onExpand}
          style={{
            background: T.surface2,
            border: `1px solid ${T.borderStrong}`,
            borderRadius: 6,
            color: T.text,
            cursor: "pointer",
            fontFamily: T.mono,
            fontSize: 11.5,
            padding: "4px 10px",
          }}
        >
          Show the diff
        </button>
      </div>
    );

  return (
    <pre
      style={{
        margin: 0,
        padding: "10px 0",
        fontFamily: T.mono,
        fontSize: 11.5,
        lineHeight: 1.45,
        overflowX: "auto",
      }}
    >
      {patch.split("\n").map((l, i) => (
        <div
          key={i}
          style={{
            color: l.startsWith("@@")
              ? T.modelViolet
              : /^(\+\+\+|---|diff |index |new file|deleted file|old mode|new mode)/.test(l)
                ? T.textFaint
                : l.startsWith("+")
                  ? T.success
                  : l.startsWith("-")
                    ? T.error
                    : T.cmd,
            whiteSpace: "pre",
          }}
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}
