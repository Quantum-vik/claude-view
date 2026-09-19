/**
 * Added and removed line counts.
 *
 * Extracted because it existed twice — `Trace.tsx` and `Changes.tsx` grew their
 * own copies within a day of each other, already differing in spacing. That is
 * the whole argument for this directory: a shape used in two places drifts in
 * two directions.
 */
import { T } from "../tokens";

export function Stat({
  add,
  rem,
  size = 10.5,
}: {
  add: number;
  rem: number;
  /** The panel uses 10.5 in dense rows and 11.5 in headers. */
  size?: number;
}) {
  return (
    <span style={{ fontFamily: T.mono, fontSize: size, whiteSpace: "nowrap" }}>
      {/* U+2212 MINUS, not a hyphen: it aligns with the digits in a tabular
          font, where a hyphen sits high and short. */}
      <span style={{ color: T.success }}>+{add}</span>{" "}
      <span style={{ color: T.error }}>−{rem}</span>
    </span>
  );
}
