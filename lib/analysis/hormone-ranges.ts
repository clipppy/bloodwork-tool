/**
 * Female hormone functional optimal ranges — ANALYSIS PATH ONLY.
 *
 * Melissa supplied functional optimal ranges for the female hormone panel.
 * Several depend on cycle phase or menopausal status, and all of them assume a
 * female patient, so they cannot live in the shared dictionary (lib/ranges):
 * the data report has no sex input and must keep flagging exactly as before.
 * This module encodes the table and applies it as an OVERLAY on top of the
 * flagging engine's output, inside the Clinical Analysis pipeline, only when
 * the practitioner has told us the patient is female.
 *
 * Division of labour, restated:
 *   - lib/flagging (read-only here) decides the LAB tier from the range printed
 *     on the report, exactly as it always has. That verdict governs the lab tier
 *     (Melissa's rule).
 *   - this module supplies the OPTIMAL tier for the hormones below, and
 *     recomputes the two-tier flag with the same rule the rest of the system
 *     uses (direction from the optimal window, severity from how far out the
 *     value sits and whether it also left the lab range).
 *   - every number stays deterministic. The LLM receives the resulting flags as
 *     ground truth plus the selected status as clinical context.
 *
 * TO EDIT THE RANGES: change PHASE_INDEPENDENT_RANGES / PHASE_DEPENDENT_RANGES
 * below. Keys are the dictionary's canonicalName strings. The `basis` label on
 * each phase-dependent row is Melissa's own row label, kept so the chart note
 * and the report can be proofread against her document.
 */

import type { FlaggedMarker, FlagDirection, FlagSeverity } from "../flagging";
import { isFlagged } from "../flagging";
import { parseReferenceRange } from "../flagging/range-parse";

// ----- Status (the form field) -----

/** The "Cycle phase / menopausal status" dropdown. Stored as the stable key;
 *  the label is what the form shows and the report header prints. */
export type HormoneStatus =
  | "early_follicular"
  | "mid_follicular"
  | "ovulatory"
  | "luteal"
  | "mid_luteal"
  | "postmenopausal"
  | "postmenopausal_hrt"
  | "birth_control"
  | "not_sure";

export const HORMONE_STATUS_OPTIONS: ReadonlyArray<{ value: HormoneStatus; label: string }> = [
  { value: "not_sure", label: "Not sure" },
  { value: "early_follicular", label: "Early follicular (day 1-5)" },
  { value: "mid_follicular", label: "Mid-follicular (day 6-10)" },
  { value: "ovulatory", label: "Ovulatory (day 12-15)" },
  { value: "luteal", label: "Luteal (day 16-20)" },
  { value: "mid_luteal", label: "Mid-luteal (~7 days post-ovulation)" },
  { value: "postmenopausal", label: "Postmenopausal" },
  { value: "postmenopausal_hrt", label: "Postmenopausal on HRT" },
  { value: "birth_control", label: "On hormonal birth control" },
];

export const DEFAULT_HORMONE_STATUS: HormoneStatus = "not_sure";

const STATUS_LABELS: ReadonlyMap<HormoneStatus, string> = new Map(
  HORMONE_STATUS_OPTIONS.map((o) => [o.value, o.label]),
);

/** Form value -> status. Anything missing or unrecognised is "Not sure", which
 *  is the conservative choice: phase-dependent ranges are then NOT applied. */
export function parseHormoneStatus(raw: unknown): HormoneStatus {
  const s = typeof raw === "string" ? raw.trim() : "";
  return STATUS_LABELS.has(s as HormoneStatus) ? (s as HormoneStatus) : DEFAULT_HORMONE_STATUS;
}

export function hormoneStatusLabel(status: HormoneStatus): string {
  return STATUS_LABELS.get(status) ?? STATUS_LABELS.get(DEFAULT_HORMONE_STATUS)!;
}

/** Statuses that name a specific point in the cycle (or past it). These are the
 *  only statuses under which a phase-dependent range is applied. */
const SPECIFIC_PHASES = new Set<HormoneStatus>([
  "early_follicular",
  "mid_follicular",
  "ovulatory",
  "luteal",
  "mid_luteal",
  "postmenopausal",
]);

/** Melissa's caveat: patients on hormonal contraception or HRT do not fit the
 *  functional ranges. No hormone optimal is applied for them — including the
 *  otherwise status-independent SHBG and Pregnenolone. */
const EXCLUDED_STATUSES = new Set<HormoneStatus>(["postmenopausal_hrt", "birth_control"]);

export type SpecificPhase =
  | "early_follicular"
  | "mid_follicular"
  | "ovulatory"
  | "luteal"
  | "mid_luteal"
  | "postmenopausal";

export interface OptimalWindow {
  min: number | null;
  max: number | null;
}

// ----- The range table (functional optimal, female) -----

export interface PhaseIndependentRange {
  unit: string;
  premenopausal: OptimalWindow;
  postmenopausal: OptimalWindow;
}

/**
 * Status-independent markers. Pre/post-menopausal is resolved from the status:
 * every cycling phase and "Not sure" count as premenopausal; only
 * "Postmenopausal" selects the postmenopausal column. SHBG and Pregnenolone
 * carry the same window in both columns, i.e. they apply to all statuses.
 */
export const PHASE_INDEPENDENT_RANGES: Readonly<Record<string, PhaseIndependentRange>> = {
  "SHBG (Sex Hormone Binding Globulin)": {
    unit: "nmol/L",
    premenopausal: { min: 50, max: 100 },
    postmenopausal: { min: 50, max: 100 },
  },
  Pregnenolone: {
    unit: "ng/dL",
    premenopausal: { min: 100, max: 250 },
    postmenopausal: { min: 100, max: 250 },
  },
  "DHEA Sulfate": {
    unit: "mcg/dL",
    premenopausal: { min: 150, max: 300 },
    postmenopausal: { min: 75, max: 150 },
  },
  "Testosterone Total": {
    unit: "ng/dL",
    premenopausal: { min: 20, max: 40 },
    postmenopausal: { min: 15, max: 35 },
  },
  "Testosterone Free": {
    unit: "pg/mL",
    premenopausal: { min: 1.0, max: 3.0 },
    postmenopausal: { min: 0.8, max: 2.5 },
  },
  "Testosterone Bioavailable": {
    unit: "ng/dL",
    premenopausal: { min: 2.0, max: 5.0 },
    postmenopausal: { min: 1.5, max: 4.5 },
  },
  "Estrone (E1)": {
    unit: "pg/mL",
    premenopausal: { min: 40, max: 120 },
    postmenopausal: { min: 20, max: 55 },
  },
};

export interface PhaseRow {
  window: OptimalWindow;
  /** Melissa's row label this window was taken from. */
  basis: string;
}

export interface PhaseDependentRange {
  unit: string;
  byPhase: Readonly<Record<SpecificPhase, PhaseRow>>;
}

/**
 * Phase-dependent markers, keyed by the form's status. Where Melissa's table
 * has one row covering two form options (e.g. "follicular" for both early and
 * mid-follicular, "luteal" for both luteal and mid-luteal where she gave no
 * separate mid-luteal row) the same window is repeated under both keys and the
 * `basis` label says which row it came from.
 */
export const PHASE_DEPENDENT_RANGES: Readonly<Record<string, PhaseDependentRange>> = {
  "Estradiol (E2)": {
    unit: "pg/mL",
    byPhase: {
      early_follicular: { window: { min: 40, max: 100 }, basis: "early follicular" },
      mid_follicular: { window: { min: 50, max: 150 }, basis: "mid-follicular" },
      ovulatory: { window: { min: 150, max: 400 }, basis: "surge/ovulatory" },
      luteal: { window: { min: 75, max: 250 }, basis: "luteal" },
      mid_luteal: { window: { min: 100, max: 250 }, basis: "mid-luteal" },
      postmenopausal: { window: { min: 10, max: 30 }, basis: "postmenopausal untreated" },
    },
  },
  Progesterone: {
    unit: "ng/mL",
    byPhase: {
      early_follicular: { window: { min: 0.1, max: 0.5 }, basis: "follicular" },
      mid_follicular: { window: { min: 0.1, max: 0.5 }, basis: "follicular" },
      ovulatory: { window: { min: 0.5, max: 2.0 }, basis: "surge" },
      luteal: { window: { min: 5, max: 15 }, basis: "luteal" },
      mid_luteal: { window: { min: 12, max: 25 }, basis: "mid-luteal" },
      postmenopausal: { window: { min: null, max: 0.2 }, basis: "postmenopausal (<= 0.2)" },
    },
  },
  "FSH (Follicle Stimulating Hormone)": {
    unit: "mIU/mL",
    byPhase: {
      early_follicular: { window: { min: 3, max: 8 }, basis: "follicular" },
      mid_follicular: { window: { min: 3, max: 8 }, basis: "follicular" },
      ovulatory: { window: { min: 6, max: 25 }, basis: "surge" },
      luteal: { window: { min: 1.5, max: 7 }, basis: "luteal" },
      mid_luteal: { window: { min: 1.5, max: 7 }, basis: "luteal (no separate mid-luteal row)" },
      postmenopausal: { window: { min: 30, max: null }, basis: "postmenopausal (>= 30)" },
    },
  },
  "LH (Luteinizing Hormone)": {
    unit: "mIU/mL",
    byPhase: {
      early_follicular: { window: { min: 2, max: 10 }, basis: "follicular" },
      mid_follicular: { window: { min: 2, max: 10 }, basis: "follicular" },
      ovulatory: { window: { min: 20, max: 75 }, basis: "surge" },
      luteal: { window: { min: 1, max: 10 }, basis: "luteal" },
      mid_luteal: { window: { min: 1, max: 10 }, basis: "luteal (no separate mid-luteal row)" },
      postmenopausal: { window: { min: 15, max: 55 }, basis: "postmenopausal" },
    },
  },
};

/** Every canonical name the overlay knows about. Estriol, Prolactin, AMH,
 *  Cortisol and total Estrogens are deliberately absent: no optimal supplied. */
export const HORMONE_OVERLAY_MARKERS: ReadonlyArray<string> = [
  ...Object.keys(PHASE_INDEPENDENT_RANGES),
  ...Object.keys(PHASE_DEPENDENT_RANGES),
];

// ----- Resolution: (marker, status) -> what to do -----

export type HormoneResolution =
  | { kind: "range"; window: OptimalWindow; basis: string; unit: string }
  /** HRT / hormonal birth control: no hormone optimal applies. */
  | { kind: "excluded"; reason: string }
  /** Phase-dependent marker, but the status does not name a phase. */
  | { kind: "phase_required" }
  /** Not a marker this overlay covers. */
  | { kind: "not_covered" };

function excludedReason(status: HormoneStatus): string {
  return status === "birth_control"
    ? "patient is on hormonal birth control"
    : "patient is postmenopausal on HRT";
}

export function resolveHormoneOptimal(
  canonicalName: string,
  status: HormoneStatus,
): HormoneResolution {
  const independent = PHASE_INDEPENDENT_RANGES[canonicalName];
  const dependent = PHASE_DEPENDENT_RANGES[canonicalName];
  if (!independent && !dependent) return { kind: "not_covered" };

  if (EXCLUDED_STATUSES.has(status)) {
    return { kind: "excluded", reason: excludedReason(status) };
  }

  if (independent) {
    const post = status === "postmenopausal";
    const window = post ? independent.postmenopausal : independent.premenopausal;
    const same =
      independent.premenopausal.min === independent.postmenopausal.min &&
      independent.premenopausal.max === independent.postmenopausal.max;
    return {
      kind: "range",
      window,
      basis: same ? "all statuses" : post ? "postmenopausal" : "premenopausal",
      unit: independent.unit,
    };
  }

  // Phase-dependent.
  if (!SPECIFIC_PHASES.has(status)) return { kind: "phase_required" };
  const row = dependent!.byPhase[status as SpecificPhase];
  return { kind: "range", window: row.window, basis: row.basis, unit: dependent!.unit };
}

// ----- Printed phase tables (lab tier) -----

/**
 * Quest prints the lab reference for FSH / LH / Estradiol / Progesterone as a
 * phase table ("Follicular Phase 2.5-10.2 | Mid-cycle Peak 3.1-17.7 | Luteal
 * Phase 1.5-9.1 | Postmenopausal 23.0-116.3"). The engine correctly refuses to
 * flag against one arbitrary row of that table, so for these markers it has no
 * lab tier. Once the practitioner has named the phase, the row for that phase
 * IS the lab range printed for this patient, so the overlay selects it. Returns
 * null when the status names no phase or the text has no row for it.
 */
export function selectPrintedPhaseRow(
  printed: string | null | undefined,
  status: HormoneStatus,
): OptimalWindow | null {
  if (!printed || !SPECIFIC_PHASES.has(status)) return null;

  const wanted: "follicular" | "midcycle" | "luteal" | "postmenopausal" =
    status === "early_follicular" || status === "mid_follicular"
      ? "follicular"
      : status === "ovulatory"
        ? "midcycle"
        : status === "luteal" || status === "mid_luteal"
          ? "luteal"
          : "postmenopausal";

  // Tokenise on the row labels; whatever follows a label up to the next label
  // is that row's range text.
  const labelRe =
    /(follicular(?:\s+phase)?|mid[-\s]?cycle(?:\s+peak)?|ovulat\w*(?:\s+phase)?|luteal(?:\s+phase)?|post-?menopausal)\s*:?\s*/gi;
  const text = String(printed).replace(/[\r\n]+/g, " ");
  const hits: Array<{ key: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = labelRe.exec(text)) !== null) {
    const lower = m[1].toLowerCase();
    const key = lower.startsWith("follicular")
      ? "follicular"
      : lower.startsWith("mid") || lower.startsWith("ovulat")
        ? "midcycle"
        : lower.startsWith("luteal")
          ? "luteal"
          : "postmenopausal";
    hits.push({ key, start: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < hits.length; i++) {
    if (hits[i].key !== wanted) continue;
    const segment = text.slice(hits[i].end, i + 1 < hits.length ? hits[i + 1].start : undefined);
    const cleaned = segment.replace(/\|/g, " ").trim();
    const parsed = parseReferenceRange(cleaned);
    if (parsed.min !== null || parsed.max !== null) return { min: parsed.min, max: parsed.max };
  }
  return null;
}

// ----- Overlay annotation carried on the marker -----

export interface HormoneOverlayInfo {
  /** The functional optimal window the flag was decided against. */
  optimal: OptimalWindow;
  unit: string;
  /** Melissa's row label ("early follicular", "premenopausal", "all statuses"). */
  basis: string;
  status: HormoneStatus;
  /** True when the lab tier came from the phase row of a printed phase table. */
  labRowFromPhaseTable: boolean;
}

/** FlaggedMarker plus the overlay's annotation. lib/flagging is read-only, so
 *  the extra field lives on this analysis-side extension type and callers read
 *  it through hormoneOverlayOf(). */
export interface HormoneFlaggedMarker extends FlaggedMarker {
  hormoneOverlay?: HormoneOverlayInfo;
}

export function hormoneOverlayOf(m: FlaggedMarker): HormoneOverlayInfo | null {
  return (m as HormoneFlaggedMarker).hormoneOverlay ?? null;
}

/** "50–100", "≥ 30", "≤ 0.2". Inclusive glyphs because the comparison is
 *  inclusive (a value equal to the bound is inside the window). */
export function formatOptimalWindow(w: OptimalWindow): string {
  if (w.min !== null && w.max !== null) return `${w.min}–${w.max}`;
  if (w.min !== null) return `≥ ${w.min}`;
  if (w.max !== null) return `≤ ${w.max}`;
  return "—";
}

// ----- Overlay application -----

export type OverlaySex = "male" | "female" | null;

export interface HormoneOverlayOptions {
  sex: OverlaySex;
  status: HormoneStatus;
}

export interface HormoneOverlaySummary {
  /** The selected status, or null when the overlay did not run (sex not F). */
  status: HormoneStatus | null;
  statusLabel: string | null;
  /** Canonical names whose optimal tier came from this overlay. */
  applied: string[];
  /** Plain-English notes for the chart footnote and the model's context. Empty
   *  when the panel carries none of the covered hormones. */
  notes: string[];
}

export interface HormoneOverlayResult {
  markers: FlaggedMarker[];
  summary: HormoneOverlaySummary;
}

function toNumber(v: number | string | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[<>=]/g, "").replace(/,/g, "").trim();
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Unit equality loose enough for the lab's spelling: case-insensitive,
 *  whitespace-free, and mcg == ug == µg. Empty report unit is accepted. */
function unitsMatch(reported: string, expected: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/µ|μ/g, "u")
      .replace(/mcg/g, "ug");
  const r = norm(reported);
  return r === "" || r === norm(expected);
}

/**
 * Same rule as the engine's optimal_two_tier severity (lib/flagging
 * optimalSeverity, not exported): mild within 20% of the optimal bound,
 * severe when the value also left the lab range, moderate otherwise.
 */
function overlaySeverity(
  value: number,
  optimal: OptimalWindow,
  lab: OptimalWindow,
  direction: "high" | "low",
): FlagSeverity {
  const bound = direction === "high" ? optimal.max : optimal.min;
  if (bound === null) return "moderate";
  const distance = Math.abs(value - bound);
  const tolerance = Math.abs(bound) * 0.2;
  if (distance <= tolerance) return "mild";
  if (direction === "high" && lab.max !== null && value > lab.max) return "severe";
  if (direction === "low" && lab.min !== null && value < lab.min) return "severe";
  return "moderate";
}

function hasBounds(w: OptimalWindow | null | undefined): w is OptimalWindow {
  return !!w && (w.min !== null || w.max !== null);
}

function shortName(canonicalName: string): string {
  const m = canonicalName.trim().match(/^(.*\S)\s*\(([^()]*)\)$/);
  if (!m || m[1].length < 2 || m[2].trim().length < 2) return canonicalName.trim();
  return m[1];
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Apply the female hormone optimal ranges to the engine's output.
 *
 * Returns the input array unchanged (same object identities) when the sex is
 * not female, so the male and sex-unknown paths are provably untouched. For a
 * female patient, each covered hormone on the panel is handled per
 * resolveHormoneOptimal(); everything else passes through by identity.
 */
export function applyHormoneOverlay(
  flagged: FlaggedMarker[],
  opts: HormoneOverlayOptions,
): HormoneOverlayResult {
  if (opts.sex !== "female") {
    return {
      markers: flagged,
      summary: { status: null, statusLabel: null, applied: [], notes: [] },
    };
  }

  const status = opts.status;
  const statusLabel = hormoneStatusLabel(status);
  const applied: Array<{
    canonicalName: string;
    name: string;
    window: OptimalWindow;
    unit: string;
    basis: string;
  }> = [];
  const phaseRequired: string[] = [];
  const excluded: string[] = [];
  const unitMismatch: string[] = [];
  const labGoverns: string[] = [];
  const labRowSelected: string[] = [];

  const markers = flagged.map((m): FlaggedMarker => {
    if (m.matchStatus !== "matched") return m;
    const res = resolveHormoneOptimal(m.canonicalName, status);
    if (res.kind === "not_covered") return m;
    if (res.kind === "excluded") {
      excluded.push(shortName(m.canonicalName));
      return m;
    }
    if (res.kind === "phase_required") {
      phaseRequired.push(shortName(m.canonicalName));
      return m;
    }

    const value = toNumber(m.value);
    if (value === null) return m;
    if (!unitsMatch(m.unit ?? "", res.unit)) {
      unitMismatch.push(`${shortName(m.canonicalName)} (reported in ${m.unit}, functional range in ${res.unit})`);
      return m;
    }

    const notes = [...m.flagNotes];

    // Lab tier: the engine's own effective range (printed when it parsed, else
    // the dictionary fallback). When it had none and the report printed a
    // phase table, the row for the selected phase is the printed lab range.
    let lab: OptimalWindow = m.effectiveLabRange ?? { min: null, max: null };
    let labRangeSource = m.labRangeSource;
    let labRowFromPhaseTable = false;
    if (!hasBounds(lab)) {
      const row =
        selectPrintedPhaseRow(m.referenceRangeRaw, status) ??
        selectPrintedPhaseRow(m.referenceNoteRaw, status);
      if (row) {
        lab = row;
        labRangeSource = "printed";
        labRowFromPhaseTable = true;
        labRowSelected.push(shortName(m.canonicalName));
        notes.push(
          `lab range: ${statusLabel} row selected from the printed phase table (${formatOptimalWindow(row)})`,
        );
      }
    }

    const overlay: HormoneOverlayInfo = {
      optimal: res.window,
      unit: res.unit,
      basis: res.basis,
      status,
      labRowFromPhaseTable,
    };
    const name = shortName(m.canonicalName);
    applied.push({
      canonicalName: m.canonicalName,
      name,
      window: res.window,
      unit: res.unit,
      basis: res.basis,
    });
    notes.push(
      `functional optimal ${formatOptimalWindow(res.window)} ${res.unit} (female, ${res.basis}) applied in the analysis path`,
    );

    let direction: FlagDirection = null;
    if (res.window.max !== null && value > res.window.max) direction = "high";
    else if (res.window.min !== null && value < res.window.min) direction = "low";

    if (direction !== null) {
      const result: HormoneFlaggedMarker = {
        ...m,
        flagStatus: direction,
        flagDirection: direction,
        flagSeverity: overlaySeverity(value, res.window, lab, direction),
        comparedAgainst: "optimal",
        flagType: "optimal_two_tier",
        effectiveLabRange: lab,
        labRangeSource,
        flagNotes: notes,
        hormoneOverlay: overlay,
      };
      // The overlay has a real range now; the lab-flag safety net no longer
      // describes this marker.
      if (m.labFlagFallback) result.labFlagFallback = false;
      return result;
    }

    // Inside the functional window. The lab tier still governs: a value the lab
    // range (or the lab's own H/L, when we have no range) calls out stays
    // flagged, with the optimal window shown beside it.
    const outsideLab =
      (lab.min !== null && value < lab.min) || (lab.max !== null && value > lab.max);
    if (outsideLab || (m.labFlagFallback && isFlagged(m))) {
      labGoverns.push(name);
      const labDirection: FlagDirection = outsideLab
        ? lab.max !== null && value > lab.max
          ? "high"
          : "low"
        : m.flagDirection;
      const result: HormoneFlaggedMarker = {
        ...m,
        flagStatus: labDirection ?? m.flagStatus,
        flagDirection: labDirection,
        flagSeverity: outsideLab ? "moderate" : m.flagSeverity,
        comparedAgainst: "lab",
        effectiveLabRange: lab,
        labRangeSource,
        flagNotes: [
          ...notes,
          "inside the functional optimal window but outside the lab range; the lab range governs",
        ],
        hormoneOverlay: overlay,
      };
      return result;
    }

    const result: HormoneFlaggedMarker = {
      ...m,
      flagStatus: "optimal",
      flagDirection: null,
      flagSeverity: "normal",
      comparedAgainst: "optimal",
      flagType: "optimal_two_tier",
      effectiveLabRange: lab,
      labRangeSource,
      flagNotes: notes,
      hormoneOverlay: overlay,
    };
    return result;
  });

  // ----- Notes (only about hormones actually on this panel) -----
  const notes: string[] = [];
  if (applied.length) {
    const parts = applied.map(
      (a) => `${a.name} ${formatOptimalWindow(a.window)} ${a.unit} (${a.basis})`,
    );
    notes.push(
      `Hormone functional optimal ranges supplied by the practitioner (female, status: ${statusLabel}) were applied to ${parts.join("; ")}. The lab range printed on the report still governs the lab tier.`,
    );
  }
  if (labRowSelected.length) {
    notes.push(
      `For ${joinNames(labRowSelected)} the lab range shown is the ${statusLabel} row of the phase table printed on the report.`,
    );
  }
  if (labGoverns.length) {
    notes.push(
      `${joinNames(labGoverns)} ${labGoverns.length === 1 ? "sits" : "sit"} inside the functional optimal window but outside the printed lab range; the lab range governs, so ${labGoverns.length === 1 ? "it stays" : "they stay"} flagged.`,
    );
  }
  if (phaseRequired.length) {
    notes.push(
      `Cycle phase / menopausal status was not provided, so ${joinNames(phaseRequired)} ${phaseRequired.length === 1 ? "is" : "are"} shown against the printed lab range only; ${phaseRequired.length === 1 ? "its" : "their"} functional optimal range depends on cycle phase.`,
    );
  }
  if (excluded.length) {
    notes.push(
      `Hormone functional optimal ranges were not applied because the ${excludedReason(status)}; patients on hormonal contraception or HRT do not fit those ranges. ${joinNames(excluded)} ${excluded.length === 1 ? "is" : "are"} shown against the printed lab range only.`,
    );
  }
  if (unitMismatch.length) {
    notes.push(
      `Functional optimal range not applied to ${joinNames(unitMismatch)}: the units differ.`,
    );
  }

  return {
    markers,
    summary: {
      status,
      statusLabel,
      applied: applied.map((a) => a.canonicalName),
      notes,
    },
  };
}
