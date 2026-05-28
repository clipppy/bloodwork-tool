/**
 * Flagging engine: matched-marker → flagged-marker. Driven by FlagType.
 *
 * Does NOT mutate the marker dictionary or call any external service. Pure
 * function of (MatchedMarker, OPTIMAL_RANGES). Markers with matchStatus
 * !== "matched" pass through with flagStatus: "not_flaggable".
 */

import type { MatchedMarker } from "../matcher";
import {
  findMarker,
  type FlagType,
  type InterpretationBand,
  type MarkerRange,
} from "../ranges/optimal-ranges";

export type FlagStatus =
  | "optimal"
  | "moderate"
  | "high"
  | "low"
  | "out_of_range"
  | "not_flaggable"
  | "informational";

export type FlagDirection = "high" | "low" | null;

export type FlagSeverity = "normal" | "mild" | "moderate" | "severe" | null;

export type ComparedAgainst = "optimal" | "lab" | "expected_value" | null;

export interface FlaggedMarker extends MatchedMarker {
  flagStatus: FlagStatus;
  flagDirection: FlagDirection;
  flagSeverity: FlagSeverity;
  comparedAgainst: ComparedAgainst;
  flagType: FlagType | null;
  flagNotes: string[];
}

// ----- helpers -----

function toNumber(v: number | string): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = v.replace(/[<>=]/g, "").trim();
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function emptyFlag(
  m: MatchedMarker,
  status: FlagStatus,
  notes: string[],
  flagType: FlagType | null = null,
): FlaggedMarker {
  return {
    ...m,
    flagStatus: status,
    flagDirection: null,
    flagSeverity: null,
    comparedAgainst: null,
    flagType,
    flagNotes: notes,
  };
}

/** Severity for optimal_two_tier: mild within 20% of the optimal bound,
 *  moderate if still inside lab range, severe outside lab range. */
function optimalSeverity(
  value: number,
  optimal: { min: number | null; max: number | null },
  lab: { min: number | null; max: number | null },
  direction: "high" | "low",
): FlagSeverity {
  const bound = direction === "high" ? optimal.max : optimal.min;
  if (bound === null) return "moderate";
  const distance = Math.abs(value - bound);
  const tolerance = Math.abs(bound) * 0.2;
  if (distance <= tolerance) return "mild";
  // Outside lab range entirely → severe.
  if (direction === "high" && lab.max !== null && value > lab.max) return "severe";
  if (direction === "low" && lab.min !== null && value < lab.min) return "severe";
  return "moderate";
}

/** Determine which interpretation band a numeric value sits in. Bands are
 *  half-open on the high side: [min, max). The first band's min may be null
 *  (interpreted as -Infinity), the last band's max may be null (+Infinity). */
function bandFor(value: number, bands: InterpretationBand[]): InterpretationBand | null {
  for (const b of bands) {
    const min = b.min ?? -Infinity;
    const max = b.max ?? Infinity;
    if (value >= min && value < max) return b;
  }
  // Fall back to last band if value exactly equals the final max (rare).
  for (const b of bands) {
    if (b.max !== null && value === b.max) return b;
  }
  return null;
}

/** Map a band's label → FlagStatus. The flagging engine doesn't care about
 *  the band's exact label beyond Optimal vs Moderate vs everything-else. */
function bandToStatus(label: string): FlagStatus {
  const lower = label.toLowerCase();
  if (lower === "optimal" || lower === "negative") return "optimal";
  if (lower === "moderate" || lower === "equivocal" || lower === "borderline") return "moderate";
  return "high";
}

// ----- per-FlagType handlers -----

function flagOptimalTwoTier(
  m: MatchedMarker,
  rec: MarkerRange,
  extraNotes: string[],
): FlaggedMarker {
  const value = toNumber(m.value);
  if (value === null) {
    return emptyFlag(
      m,
      "not_flaggable",
      [...extraNotes, `value "${m.value}" is not numeric`],
      rec.flagType,
    );
  }
  const optimal = rec.optimalRange;
  if (optimal.min === null && optimal.max === null) {
    return emptyFlag(
      m,
      "not_flaggable",
      [...extraNotes, "marker classified optimal_two_tier but has no optimal range"],
      rec.flagType,
    );
  }
  let direction: FlagDirection = null;
  if (optimal.max !== null && value > optimal.max) direction = "high";
  else if (optimal.min !== null && value < optimal.min) direction = "low";

  if (direction === null) {
    return {
      ...m,
      flagStatus: "optimal",
      flagDirection: null,
      flagSeverity: "normal",
      comparedAgainst: "optimal",
      flagType: rec.flagType,
      flagNotes: extraNotes,
    };
  }
  return {
    ...m,
    flagStatus: direction,
    flagDirection: direction,
    flagSeverity: optimalSeverity(value, optimal, rec.labRange, direction),
    comparedAgainst: "optimal",
    flagType: rec.flagType,
    flagNotes: extraNotes,
  };
}

function flagLabRangeOnly(
  m: MatchedMarker,
  rec: MarkerRange,
  extraNotes: string[],
): FlaggedMarker {
  const notes = [...extraNotes];
  if (rec.cyclePhaseDependent) {
    notes.push(
      "cycle-phase dependent; flag uses widest range — clinical interpretation required",
    );
  }
  const value = toNumber(m.value);
  if (value === null) {
    return emptyFlag(
      m,
      "not_flaggable",
      [...notes, `value "${m.value}" is not numeric`],
      rec.flagType,
    );
  }
  const lab = rec.labRange;
  if (lab.min === null && lab.max === null) {
    return emptyFlag(
      m,
      "not_flaggable",
      [...notes, "no range available, refer to lab report"],
      rec.flagType,
    );
  }
  let direction: FlagDirection = null;
  if (lab.max !== null && value > lab.max) direction = "high";
  else if (lab.min !== null && value < lab.min) direction = "low";
  if (direction === null) {
    return {
      ...m,
      flagStatus: "optimal",
      flagDirection: null,
      flagSeverity: "normal",
      comparedAgainst: "lab",
      flagType: rec.flagType,
      flagNotes: notes,
    };
  }
  return {
    ...m,
    flagStatus: direction,
    flagDirection: direction,
    flagSeverity: "moderate",
    comparedAgainst: "lab",
    flagType: rec.flagType,
    flagNotes: notes,
  };
}

function flagThreeTierBand(
  m: MatchedMarker,
  rec: MarkerRange,
  extraNotes: string[],
): FlaggedMarker {
  const value = toNumber(m.value);
  if (value === null) {
    return emptyFlag(
      m,
      "not_flaggable",
      [...extraNotes, `value "${m.value}" is not numeric`],
      rec.flagType,
    );
  }
  const bands = rec.interpretationBands ?? [];
  if (bands.length === 0) {
    return emptyFlag(
      m,
      "not_flaggable",
      [...extraNotes, "marker classified three_tier_band but has no interpretationBands"],
      rec.flagType,
    );
  }
  const band = bandFor(value, bands);
  if (!band) {
    return emptyFlag(
      m,
      "not_flaggable",
      [...extraNotes, `value ${value} did not fall in any interpretation band`],
      rec.flagType,
    );
  }
  const status = bandToStatus(band.label);
  // bandDirection encodes direction-of-bad. For three_tier_band, flagDirection
  // is "high" when the value lies in a non-optimal band. The engine does not
  // distinguish above-vs-below for three-tier markers — the band itself is
  // the verdict, and bandDirection lets the report explain "high HDL Large
  // means below the threshold" if needed.
  const direction: FlagDirection = status === "optimal" ? null : "high";
  const severity: FlagSeverity =
    status === "optimal" ? "normal" : status === "moderate" ? "moderate" : "severe";
  const notes = [...extraNotes, `band=${band.label} (compared against three-tier thresholds)`];
  if (rec.bandDirection === "higher_is_better" && status !== "optimal") {
    notes.push("higher values are healthier for this marker — a 'high' band means value sits below the optimal threshold");
  }
  return {
    ...m,
    flagStatus: status,
    flagDirection: direction,
    flagSeverity: severity,
    comparedAgainst: "optimal",
    flagType: rec.flagType,
    flagNotes: notes,
  };
}

function flagCategorical(
  m: MatchedMarker,
  rec: MarkerRange,
  extraNotes: string[],
): FlaggedMarker {
  if (rec.expectedValue === undefined) {
    return emptyFlag(
      m,
      "informational",
      [...extraNotes, "categorical marker with no expectedValue — informational only"],
      rec.flagType,
    );
  }
  const value = String(m.value).trim();
  const matches = value.toLowerCase() === rec.expectedValue.toLowerCase();
  return {
    ...m,
    flagStatus: matches ? "optimal" : "out_of_range",
    flagDirection: null,
    flagSeverity: matches ? "normal" : "moderate",
    comparedAgainst: "expected_value",
    flagType: rec.flagType,
    flagNotes: [
      ...extraNotes,
      `expected "${rec.expectedValue}", got "${value}"`,
    ],
  };
}

// ----- public API -----

export function flagMarker(m: MatchedMarker): FlaggedMarker {
  if (m.matchStatus !== "matched") {
    return emptyFlag(
      m,
      "not_flaggable",
      ["marker not matched to optimal-ranges"],
      null,
    );
  }
  const rec = findMarker(m.canonicalName);
  if (!rec) {
    return emptyFlag(
      m,
      "not_flaggable",
      [`canonicalName "${m.canonicalName}" not found in optimal-ranges (matcher/dictionary drift)`],
      null,
    );
  }

  const extraNotes: string[] = [];
  if (m.confirmationPending) {
    extraNotes.push("range pending confirmation from Melissa");
  }

  switch (rec.flagType) {
    case "optimal_two_tier":
      return flagOptimalTwoTier(m, rec, extraNotes);
    case "lab_range_only":
      return flagLabRangeOnly(m, rec, extraNotes);
    case "three_tier_band":
      return flagThreeTierBand(m, rec, extraNotes);
    case "categorical":
      return flagCategorical(m, rec, extraNotes);
    default: {
      const _exhaustive: never = rec.flagType;
      return emptyFlag(
        m,
        "not_flaggable",
        [...extraNotes, `unknown flagType: ${String(_exhaustive)}`],
        null,
      );
    }
  }
}

export function flagMarkers(matched: MatchedMarker[]): FlaggedMarker[] {
  return matched.map(flagMarker);
}

/** Convenience: returns true if the flag indicates a problem the report
 *  should surface (any non-optimal, non-informational, flaggable status). */
export function isFlagged(f: FlaggedMarker): boolean {
  return (
    f.flagStatus === "high" ||
    f.flagStatus === "low" ||
    f.flagStatus === "moderate" ||
    f.flagStatus === "out_of_range"
  );
}
