/**
 * models.ts
 * ---------
 * Single source of truth for the model switcher AND the per-model effort toggle.
 *
 * These are the models Claude Code's `/model` command accepts under a Pro/Max
 * subscription (verified against the installed CLI binary's alias table), plus
 * each model's reasoning-effort range. Both controls render from this catalog,
 * so nothing is hardcoded in the component — extend the array here and the UI
 * follows.
 *
 * The switcher injects `/model <alias>` into the session PTY; the effort toggle
 * injects `/effort <level>`. Both are real Claude Code slash commands.
 *
 * Effort model (from the CLI): the API exposes five levels — Low · Medium ·
 * High · X-High · Max — but each model offers a different range and default.
 * `ultracode` = X-High plus standing permission for multi-agent workflows; it's
 * a Claude-Code-only convenience on Opus-tier models, not a separate API level.
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** All five effort levels in ascending order. */
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"] as const;

export const EFFORT_LABEL: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

export interface ModelDef {
  /** Sent verbatim as `/model <alias>`. */
  alias: string;
  label: string;
  /** Version/variant suffix shown dimmer after the label, e.g. "4.8" or
   *  "4.6 · 1M". Omitted for Default (which tracks whatever the CLI default is). */
  version?: string;
  /** Effort levels this model supports (subset of EFFORTS). Levels outside this
   *  set are shown ghosted in the toggle. */
  supported: readonly Effort[];
  /** The level marked DEFAULT in the toggle. */
  defaultEffort: Effort;
  /** Opus-tier: exposes the Ultracode segment (X-High + multi-agent workflows). */
  ultracode?: boolean;
}

const FULL: readonly Effort[] = EFFORTS; // low → max
const FAST: readonly Effort[] = ["low", "medium", "high"]; // Haiku: no X-High / Max

export const MODELS: readonly ModelDef[] = [
  { alias: "default",     label: "Default",                        supported: FULL, defaultEffort: "high",   ultracode: true },
  { alias: "opus",        label: "Opus",     version: "4.8",       supported: FULL, defaultEffort: "high",   ultracode: true },
  { alias: "opusplan",    label: "Opus Plan", version: "4.8",      supported: FULL, defaultEffort: "high",   ultracode: true },
  { alias: "sonnet",      label: "Sonnet",   version: "4.6",       supported: FULL, defaultEffort: "high" },
  { alias: "sonnet[1m]",  label: "Sonnet",   version: "4.6 · 1M",  supported: FULL, defaultEffort: "high" },
  { alias: "haiku",       label: "Haiku",    version: "4.5",       supported: FAST, defaultEffort: "medium" },
] as const;

export function modelByAlias(alias: string | null): ModelDef | undefined {
  return MODELS.find((m) => m.alias === alias);
}

/** Map a full transcript model id → our switcher alias (best-effort family
 *  match). Unknown ids fall back to "default". */
export function aliasForModelId(id: string | null): string {
  if (!id) return "default";
  if (/opus/i.test(id)) return "opus";
  if (/sonnet/i.test(id)) return "sonnet";
  if (/haiku/i.test(id)) return "haiku";
  return "default";
}

/** Pretty label for a full transcript model id, e.g. "claude-opus-4-8" →
 *  "Opus 4.8", "claude-haiku-4-5-20251001" → "Haiku 4.5", "claude-fable-5" →
 *  "Fable 5". Handles models outside the switcher list (Fable) gracefully. */
export function displayModelId(id: string | null): string {
  if (!id) return "";
  const parts = id.replace(/^claude-/, "").split("-");
  const fam = parts.shift() ?? id;
  const ver = parts.filter((p) => !/^\d{8}$/.test(p)).join("."); // drop date suffix
  const cap = fam.charAt(0).toUpperCase() + fam.slice(1);
  return ver ? `${cap} ${ver}` : cap;
}
