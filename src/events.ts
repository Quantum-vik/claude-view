/**
 * events.ts
 * ---------
 * The hook/transcript event stream that arrives over the WebSocket.
 *
 * This used to live in `Timeline.tsx`, which owned both the type and the view
 * that rendered it. The view merged into the Stream (#31); the type outlived it
 * because it is the wire shape, not a component's concern.
 *
 * These events are NOT the trace. The trace is read from the transcript on disk
 * and carries every kind — prompts, replies, thinking, tool calls, cost. This
 * stream carries tool calls only, but carries them **sooner**: hooks fire as a
 * tool starts, where the transcript only records that it was called. That is
 * why the Stream still consumes it — it is the only source of "this tool is
 * running right now".
 */

/** One tool call, as the backend broadcasts it. Mirrors `TimelineEvent` in
 *  src-tauri/src/session.rs. */
export interface TimelineEvent {
  /** **The tool-use id.** `apply_transcript` keys on it so hook-derived cards
   *  and transcript records converge on one entry — which is also what lets
   *  this stream join straight onto a trace entry's `toolUseId`. */
  id: string;
  kind: "command";
  tool: string;
  command: string | null;
  status: "running" | "success" | "error" | "interrupted";
  durationMs: number | null;
  ts: number;
  output: string | null;
  /** Omitted for the parent session, set to the subagent id for a child's tool
   *  call. Subagents can be the majority of a session's work, so an unlabelled
   *  card would silently read as the parent's. */
  agentId?: string;
}
