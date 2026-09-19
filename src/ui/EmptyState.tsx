/**
 * What a panel says when it has nothing to show.
 *
 * Empty states are the app's most repeated writing and its least reviewed, so
 * the shape is fixed here rather than retyped: a serif heading, one or more
 * dim paragraphs, a measure that stays readable.
 *
 * The rule this encodes — from every map that has touched a panel — is that
 * absence is reported BY CAUSE. "No changes to show" is not an answer; "this
 * session is older than git's memory" is. The component takes a heading and
 * body precisely so each caller has to say which of its causes this is.
 */
import type { ReactNode } from "react";
import { T } from "../tokens";

export function EmptyState({ head, children }: { head: string; children: ReactNode }) {
  return (
    <div style={{ maxWidth: "46ch", margin: "14vh auto", padding: "0 20px" }}>
      <h2 style={{ font: `600 15px ${T.serif}`, color: T.text, margin: "0 0 8px" }}>{head}</h2>
      <div style={{ font: `13px/1.65 ${T.serif}`, color: T.textDim }}>{children}</div>
    </div>
  );
}

/** One paragraph of an empty state's body. */
export function EmptyLine({ children }: { children: ReactNode }) {
  return <p style={{ margin: "0 0 10px" }}>{children}</p>;
}
