/**
 * Repeated-marker dedupe for the Clinical Analysis path.
 *
 * A merged upload (two Quest layouts of one draw stapled into a single PDF, or
 * a panel that prints a marker in two sections) can carry the same canonical
 * marker twice. The chart must not print two Albumin rows for one draw.
 *
 * Rule, per canonical marker with more than one matched result:
 *   - keep ONE row: prefer the result that carries a unit, then the one whose
 *     lab range was read off the report, then the first in document order;
 *   - drop every other result whose value is NOT materially different from
 *     the kept one;
 *   - keep a materially different result as its own row, tagged `repeatOf`
 *     so the chart labels it "(repeat)" (deterministic.displayMarkerName).
 *
 * "Materially different" means: the two values disagree on which chart tier
 * or direction they land in, or (both numeric) they differ by more than
 * MATERIAL_RELATIVE_DIFFERENCE of the larger magnitude, or (either
 * non-numeric) the printed values differ. Albumin 4.2 vs 4.1 (2.4%, both
 * optimal) is one row; Albumin 4.2 vs 3.4 (one optimal, one low) is two.
 *
 * The whole upload is treated as one draw, as the rest of the tool already
 * does (one collection date per upload). Unmatched markers pass through
 * untouched. Document order is preserved. Pure; never re-flags anything.
 */

import type { FlaggedMarker } from "../flagging";
import { markerTier, rowDirection } from "./deterministic";

/** Relative difference above which two results for one marker are both kept. */
export const MATERIAL_RELATIVE_DIFFERENCE = 0.05;

/** A result kept alongside an earlier result for the same marker. */
export interface RepeatFlaggedMarker extends FlaggedMarker {
  /** The canonical name of the marker this is a repeat of (its own name). */
  repeatOf: string;
}

export function isRepeatMarker(m: FlaggedMarker): m is RepeatFlaggedMarker {
  return typeof (m as Partial<RepeatFlaggedMarker>).repeatOf === "string";
}

function numeric(v: number | string | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[<>=]/g, "").replace(/,/g, "").trim();
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Are two results for one marker different enough that hiding one would
 *  hide information? Exported for the test. */
export function materiallyDifferent(a: FlaggedMarker, b: FlaggedMarker): boolean {
  if (markerTier(a) !== markerTier(b)) return true;
  if (rowDirection(a) !== rowDirection(b)) return true;
  const na = numeric(a.value);
  const nb = numeric(b.value);
  if (na === null || nb === null) {
    return String(a.value).trim().toLowerCase() !== String(b.value).trim().toLowerCase();
  }
  const scale = Math.max(Math.abs(na), Math.abs(nb));
  if (scale === 0) return false;
  return Math.abs(na - nb) / scale > MATERIAL_RELATIVE_DIFFERENCE;
}

/** Lower is better. Unit first, then a range read off the report, then
 *  document order (the index breaks every tie deterministically). */
function keeperRank(m: FlaggedMarker, index: number): number {
  const unit = m.unit && m.unit.trim() ? 0 : 1;
  const printed = m.labRangeSource === "printed" || m.labRangeSource === "sex_selected" ? 0 : 1;
  return unit * 1_000_000 + printed * 100_000 + index;
}

export function dedupeRepeatedMarkers(flagged: FlaggedMarker[]): FlaggedMarker[] {
  const groups = new Map<string, number[]>();
  flagged.forEach((m, i) => {
    if (m.matchStatus !== "matched") return;
    const list = groups.get(m.canonicalName);
    if (list) list.push(i);
    else groups.set(m.canonicalName, [i]);
  });

  const drop = new Set<number>();
  const repeat = new Set<number>();
  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    const keeper = indices
      .slice()
      .sort((a, b) => keeperRank(flagged[a], a) - keeperRank(flagged[b], b))[0];
    for (const i of indices) {
      if (i === keeper) continue;
      if (materiallyDifferent(flagged[keeper], flagged[i])) repeat.add(i);
      else drop.add(i);
    }
  }

  if (drop.size === 0 && repeat.size === 0) return flagged;
  const out: FlaggedMarker[] = [];
  flagged.forEach((m, i) => {
    if (drop.has(i)) return;
    if (repeat.has(i)) {
      const tagged: RepeatFlaggedMarker = {
        ...m,
        repeatOf: m.canonicalName,
        flagNotes: [
          ...m.flagNotes,
          "second result for this marker on the same upload; kept because it differs materially from the first",
        ],
      };
      out.push(tagged);
      return;
    }
    out.push(m);
  });
  return out;
}
