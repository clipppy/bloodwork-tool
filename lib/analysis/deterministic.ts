/**
 * Deterministic half of the Clinical Analysis report.
 *
 * Every number that reaches the .docx is computed here, in code, from the
 * flagging engine's FlaggedMarker output. The LLM is never asked to produce,
 * restate, or re-derive a value, a range, or a status — it only receives these
 * rows as ground truth and writes prose around them (Phase 1b onward).
 *
 * Reads lib/flagging, lib/ranges, and lib/matcher READ-ONLY. Nothing here
 * mutates a marker or re-decides a flag: `withinLabRange` compares the value
 * against the SAME effectiveLabRange the engine already flagged against, and is
 * used for presentation only (the asterisk convention below).
 *
 * Structure mirrors samples/analysis-examples/Robidoux_Functional_Medicine_Analysis.docx.
 */

import type { FlaggedMarker } from "../flagging";
import { isFlagged } from "../flagging";
import { formatPrintedRange, parseReferenceRange } from "../flagging/range-parse";
import { findMarker } from "../ranges/optimal-ranges";

// ----- Fixed report text (verbatim from the Robidoux sample) -----

export const DISCLAIMER =
  "This report is a clinical decision-support summary for the treating practitioner. " +
  "It is not a diagnosis and does not replace clinical judgment, physical exam, or " +
  "additional physician-ordered testing. Findings chipped amber as Out of Optimal " +
  "sit within the standard laboratory reference range but outside commonly used " +
  "functional/optimal ranges, and are offered as context rather than as a finding " +
  "of disease.";

export const ORDERING_PRACTICE = "Carbone Chiropractic";
export const PREPARED_FOR = "Melissa Tulisano";

/**
 * Markers Melissa calls out by name in the sample's "reassuring" sentence,
 * plus the core panel markers a practitioner scans for first. Rendered ahead of
 * the remaining in-range markers. Order here is the order they print in.
 */
const NOTABLE_REASSURING: string[] = [
  "Hs-CRP",
  "Insulin",
  "Hemoglobin A1C",
  "Glucose",
  "sTSH (Serum Thyroid Stimulating Hormone)",
  "T4 Free",
  "T3 Free",
  "Thyroid Peroxidase",
  "Thyroglobulin Antibodies",
  "Vitamin D 25-OH",
  "Vitamin B12",
  "Ferritin",
  "Homocysteine",
  "ALT (Alanine Aminotransferase)",
  "AST (Aspartate Aminotransferase)",
  "eGFR",
  "Sodium",
  "Potassium",
];

// ----- Types -----

export type PatientSex = "male" | "female" | "unspecified";

export interface AnalysisHeader {
  patientName: string;
  /** "10/15/1975 (Age 50)" when a DOB was entered, else an em dash. The DOB
   *  itself is rendered here LOCALLY and never leaves this machine — only the
   *  integer age reaches the API payload (see deidentify.ts). */
  dobAge: string;
  collected: string;
  reported: string;
  orderingPractice: string;
  preparedFor: string;
}

export interface ChartRow {
  marker: string;
  /** "123 mcg/dL" or "117 mg/dL (calc) H" — the lab's own H/L is preserved. */
  result: string;
  labRange: string;
  optimalRange: string;
  /** "HIGH", "LOW", "BORDERLINE HIGH*", "SUBOPTIMAL*", ... */
  status: string;
  /** true = provably inside the lab range (earns the asterisk), false =
   *  provably outside, null = no usable lab range to compare against. */
  withinLabRange: boolean | null;
  category: string;
}

export interface ReassuringMarkers {
  /** Core-panel markers, in NOTABLE_REASSURING order. */
  notable: string[];
  /** Every other in-range marker, alphabetical. */
  other: string[];
  totalCount: number;
}

export interface DeterministicAnalysis {
  header: AnalysisHeader;
  rows: ChartRow[];
  /** Same markers as `rows`, grouped by category for the re-eval comparison
   *  chart. Built for both modes; only the re-eval document renders it. */
  comparisonGroups: ComparisonGroup[];
  reassuring: ReassuringMarkers;
  /** Integer age derived from the DOB, or null. This — not the DOB — is what
   *  the API payload is allowed to carry. */
  age: number | null;
  sex: PatientSex;
}

export interface AnalysisInputs {
  patientName: string;
  /** Form date — the fallback when the PDF carries no collection date. */
  patientDate: string;
  /** "YYYY-MM-DD" from the form's date input, or empty/absent. Local use only. */
  dob?: string | null;
  sex?: string | null;
  collectedDate?: string | null;
  reportedDate?: string | null;
}

/** Whole years between a "YYYY-MM-DD" DOB and `asOf`. null if unparseable. */
export function computeAge(dob: string | null | undefined, asOf: Date): number | null {
  const s = (dob ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  let age = asOf.getFullYear() - y;
  const beforeBirthday =
    asOf.getMonth() + 1 < mo || (asOf.getMonth() + 1 === mo && asOf.getDate() < d);
  if (beforeBirthday) age -= 1;
  if (age < 0 || age > 130) return null;
  return age;
}

/** "YYYY-MM-DD" -> "MM/DD/YYYY" for the header block. */
function formatDob(dob: string | null | undefined): string | null {
  const m = (dob ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : null;
}

function normalizeSex(sex: string | null | undefined): PatientSex {
  const s = (sex ?? "").trim().toLowerCase();
  if (s === "male" || s === "m") return "male";
  if (s === "female" || s === "f") return "female";
  return "unspecified";
}

// ----- Value / range helpers -----

/** Numeric view of a marker value, or null when it is categorical (">600.00"
 *  keeps its comparison prefix stripped so it still compares). */
function numericValue(v: number | string | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[<>=]/g, "").replace(/,/g, "").trim();
  if (!cleaned) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Is the value inside the lab range the engine actually flagged against?
 * null when there is nothing to compare (no numeric value, or no bounds).
 * Boundary values count as INSIDE — a lab range of 7–25 does not flag 25.
 */
export function withinLabRange(m: FlaggedMarker): boolean | null {
  const eff = m.effectiveLabRange;
  if (!eff || (eff.min === null && eff.max === null)) return null;
  const v = numericValue(m.value);
  if (v === null) return null;
  if (eff.min !== null && v < eff.min) return false;
  if (eff.max !== null && v > eff.max) return false;
  return true;
}

/** "123 mcg/dL H" — value, unit, and the lab's own flag letter when it set one,
 *  matching the Result column in the sample doc. */
export function formatResult(m: FlaggedMarker): string {
  const v = m.value === null || m.value === undefined ? "" : String(m.value);
  if (!v) return "(no value)";
  const unit = m.unit ? ` ${m.unit}` : "";
  const labFlag = m.labFlagFromPdf ? ` ${m.labFlagFromPdf}` : "";
  return `${v}${unit}${labFlag}`;
}

/** The lab range the flag was decided against, rendered the same way the
 *  existing report renders it (printed tokens preserved, else numeric bounds). */
export function formatLabRange(m: FlaggedMarker): string {
  if (m.labRangeSource === "printed") {
    const printed = formatPrintedRange(m.referenceRangeRaw ?? "");
    if (printed) return printed;
  }
  const eff = m.effectiveLabRange;
  if (eff) {
    const { min, max } = eff;
    if (min !== null && max !== null) return `${min}–${max}`;
    if (min !== null) return `≥ ${min}`;
    if (max !== null) return `< ${max}`;
  }
  const raw = (m.referenceRangeRaw ?? "").trim();
  if (!raw) return "—";
  const parsed = parseReferenceRange(raw);
  if (parsed.min !== null || parsed.max !== null || /\d/.test(raw)) return raw;
  return "—";
}

/** The functional/optimal target. Three-tier markers show their bands;
 *  lab_range_only markers have no separate optimal, so they echo the lab range
 *  (the sample doc does the same for Non-HDL Cholesterol). */
export function formatOptimalRange(m: FlaggedMarker): string {
  const rec = findMarker(m.canonicalName);
  if (!rec) return "—";

  if (m.flagType === "three_tier_band") {
    const bands = rec.interpretationBands ?? [];
    if (!bands.length) return "—";
    return bands
      .map((b) => `${b.label}: [${b.min ?? "−∞"}, ${b.max ?? "+∞"})`)
      .join("  |  ");
  }
  if (m.flagType === "categorical") return rec.expectedValue ?? "—";
  if (m.flagType === "lab_range_only") return `${formatLabRange(m)} (lab range)`;

  const { min, max } = rec.optimalRange;
  if (min !== null && max !== null) return `${min}–${max}`;
  if (min !== null) return `≥ ${min}`;
  if (max !== null) return `< ${max}`;
  return "—";
}

/**
 * Status column.
 *
 * Outside the lab range (or no lab range to compare) → the plain direction the
 * engine flagged: HIGH / LOW / MODERATE / OUT OF RANGE.
 *
 * Inside the lab range but outside the optimal range → the same direction in
 * the sample doc's softer wording, with the asterisk the disclaimer explains.
 * Severity comes straight off the engine: mild reads BORDERLINE, anything
 * further out reads ABOVE OPTIMAL / SUBOPTIMAL.
 */
export function formatStatus(m: FlaggedMarker, within: boolean | null): string {
  const inLab = within === true;

  if (m.flagStatus === "out_of_range") return inLab ? "OUT OF RANGE*" : "OUT OF RANGE";
  if (m.flagStatus === "moderate") return inLab ? "MODERATE*" : "MODERATE";

  const dir = m.flagDirection;
  if (dir === "high") {
    if (!inLab) return "HIGH";
    return m.flagSeverity === "mild" ? "BORDERLINE HIGH*" : "ABOVE OPTIMAL*";
  }
  if (dir === "low") {
    if (!inLab) return "LOW";
    return m.flagSeverity === "mild" ? "BORDERLINE LOW*" : "SUBOPTIMAL*";
  }
  return m.flagStatus.toUpperCase();
}

// ----- Ordering -----

const SEVERITY_RANK: Record<string, number> = {
  severe: 0,
  moderate: 1,
  mild: 2,
  normal: 3,
};

function severityRank(m: FlaggedMarker): number {
  return SEVERITY_RANK[m.flagSeverity ?? "normal"] ?? 4;
}

/** Category A→Z, then most-severe first, then marker name. Fully deterministic
 *  so two runs over the same PDF produce byte-identical row order. */
function compareRows(a: FlaggedMarker, b: FlaggedMarker): number {
  const ca = findMarker(a.canonicalName)?.category ?? "";
  const cb = findMarker(b.canonicalName)?.category ?? "";
  if (ca !== cb) return ca.localeCompare(cb);
  const sa = severityRank(a);
  const sb = severityRank(b);
  if (sa !== sb) return sa - sb;
  return a.canonicalName.localeCompare(b.canonicalName);
}

// ----- Builders -----

function formatDate(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  // Quest stamps "02/27/2026 / 07:06 EST" — the date is what belongs in the header.
  const m = s.match(/^(\d{2}\/\d{2}\/\d{4})/);
  return m ? m[1] : s;
}

export function buildChartRows(flagged: FlaggedMarker[]): ChartRow[] {
  return flagged
    .filter(isFlagged)
    .slice()
    .sort(compareRows)
    .map((m) => {
      const within = withinLabRange(m);
      return {
        marker: m.canonicalName,
        result: formatResult(m),
        labRange: formatLabRange(m),
        optimalRange: formatOptimalRange(m),
        status: formatStatus(m, within),
        withinLabRange: within,
        category: findMarker(m.canonicalName)?.category ?? "",
      };
    });
}

// ----- Re-evaluation mode: category-grouped comparison rows -----

/** Display names + print order for the dictionary's `category` slugs, grouped
 *  the way the Bonnie re-eval sample groups its tables. */
const CATEGORY_DISPLAY: Array<{ key: string; label: string }> = [
  { key: "lipid", label: "Lipids" },
  { key: "cardio_iq", label: "Advanced Lipid / Cardio IQ" },
  { key: "metabolic", label: "Glucose & Insulin" },
  { key: "inflammation", label: "Inflammation" },
  { key: "hematology", label: "CBC / Red Blood Cell Indices" },
  { key: "liver", label: "Liver" },
  { key: "kidney", label: "Kidney" },
  { key: "gut", label: "Digestive / Protein / Mineral Status" },
  { key: "iron", label: "Iron Status" },
  { key: "vitamins_minerals", label: "Vitamins & Minerals" },
  { key: "immune_thyroid", label: "Immune & Thyroid" },
  { key: "endocrine", label: "Endocrine & Hormones" },
];

/** Placeholder text for the two columns the comparative pass fills. */
export const PRIOR_PENDING = "[from prior report]";
export const TREND_PENDING = "[vs prior: pending]";
/** Shown when the prior report did not print a usable value for a marker —
 *  the situation the sample doc footnotes for WBC. */
export const PRIOR_NOT_FOUND = "[prior value not found]";
export const CURRENT_NOT_RETESTED = "[not retested]";

export interface ComparisonRow {
  marker: string;
  /** Always the placeholder in 2a — the prior value comes from the prior
   *  report in 2b, never from this pipeline. */
  prior: string;
  current: string;
  labRange: string;
  optimalRange: string;
  /** Deterministic lab/optimal verdict in the sample doc's vocabulary. */
  status: string;
  /** The direction the flagging engine flagged, carried through so the report's
   *  status chip can read "Out of Optimal (High)" the way the initial-mode chip
   *  does. Copied straight off FlaggedMarker.flagDirection — never re-derived
   *  from the rendered value — and null when the engine flagged no direction
   *  (a three-tier band, a categorical, or a row with no current value). */
  direction: "high" | "low" | null;
  /** Placeholder for the improved/worsened half of the Status column. */
  trend: string;
  withinLabRange: boolean | null;
}

export interface ComparisonGroup {
  category: string;
  label: string;
  rows: ComparisonRow[];
}

/**
 * Status vocabulary from the re-eval sample: a value outside the lab range
 * reads "Out of Lab Range", one inside it but outside the functional target
 * reads "Out of Optimal". Whether it improved or worsened needs the prior
 * panel and is deliberately left to Phase 2b.
 */
export function comparisonStatus(m: FlaggedMarker, within: boolean | null): string {
  if (within === true) return "Out of Optimal";
  if (within === false) return "Out of Lab Range";
  return "Out of Optimal"; // no usable lab range: the flag came from the optimal/band side
}

/**
 * Current-side comparison chart, grouped by the dictionary's category.
 *
 * Row set is the engine's own isFlagged() — the markers flagged on the CURRENT
 * draw. Markers that were out of range on the prior panel but are optimal now
 * (the sample's "Improved" rows) can only be identified from the prior report,
 * so Phase 2b adds them; 2a never invents a row the current labs don't support.
 */
export function buildComparisonGroups(flagged: FlaggedMarker[]): ComparisonGroup[] {
  const rank = new Map(CATEGORY_DISPLAY.map((c, i) => [c.key, i]));
  const labels = new Map(CATEGORY_DISPLAY.map((c) => [c.key, c.label]));

  const buckets = new Map<string, ComparisonRow[]>();
  for (const m of flagged.filter(isFlagged)) {
    const category = findMarker(m.canonicalName)?.category ?? "other";
    const within = withinLabRange(m);
    const row: ComparisonRow = {
      marker: m.canonicalName,
      prior: PRIOR_PENDING,
      current: formatResult(m),
      labRange: formatLabRange(m),
      optimalRange: formatOptimalRange(m),
      status: comparisonStatus(m, within),
      direction: m.flagDirection,
      trend: TREND_PENDING,
      withinLabRange: within,
    };
    const bucket = buckets.get(category);
    if (bucket) bucket.push(row);
    else buckets.set(category, [row]);
  }

  return [...buckets.entries()]
    .map(([category, rows]) => ({
      category,
      label: labels.get(category) ?? humanizeCategory(category),
      rows: rows.sort((a, b) => a.marker.localeCompare(b.marker)),
    }))
    .sort((a, b) => {
      const ra = rank.get(a.category) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.category) ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return a.label.localeCompare(b.label);
    });
}

// ----- Re-evaluation: prior-panel merge and trend (both computed in code) -----

/** What the comparative pass extracted for one marker from the prior report.
 *  `value` is the ONLY LLM-sourced number in the document. */
export interface PriorMarkerFact {
  /** Verbatim prior value as printed on the prior report, e.g. "311 pg/mL". */
  value: string | null;
  /** Set when the model reports the two panels are not comparable (a different
   *  assay, different units), as the sample doc notes for Vitamin D. */
  notComparable?: boolean;
}

export type TrendLabel =
  | "Improved"
  | "Worsened"
  | "Held"
  | "Stable/In Range"
  | "Not comparable"
  | "Not retested"
  | "Unknown";

/** Distance from the optimal window; 0 when inside it. */
function deviationFromOptimal(
  value: number,
  optimal: { min: number | null; max: number | null } | null,
): number | null {
  if (!optimal || (optimal.min === null && optimal.max === null)) return null;
  if (optimal.min !== null && value < optimal.min) return optimal.min - value;
  if (optimal.max !== null && value > optimal.max) return value - optimal.max;
  return 0;
}

/**
 * Improved / worsened / held, computed IN CODE by comparing how far the prior
 * and current values sit from the marker's optimal window. The model never
 * decides this — it only supplies the prior value.
 */
export function computeTrend(
  canonicalName: string,
  priorValue: string | null,
  currentValue: number | string | null,
  notComparable?: boolean,
  /** The lab window the engine actually flagged this marker against. Used when
   *  the dictionary has no numeric optimal window of its own — lab_range_only
   *  markers such as Non-HDL Cholesterol carry their range on the report, not
   *  in the dictionary. */
  fallbackWindow?: { min: number | null; max: number | null } | null,
): TrendLabel {
  if (notComparable) return "Not comparable";
  if (currentValue === null || currentValue === undefined) return "Not retested";
  if (!priorValue) return "Unknown";

  const p = numericValue(priorValue);
  const c = numericValue(currentValue);
  if (p === null || c === null) return "Unknown";

  const rec = findMarker(canonicalName);
  const hasBounds = (w: { min: number | null; max: number | null } | null | undefined) =>
    !!w && (w.min !== null || w.max !== null);
  const window = hasBounds(rec?.optimalRange)
    ? rec!.optimalRange
    : hasBounds(rec?.labRange)
      ? rec!.labRange
      : hasBounds(fallbackWindow)
        ? fallbackWindow!
        : null;

  const devPrior = deviationFromOptimal(p, window);
  const devCurrent = deviationFromOptimal(c, window);
  if (devPrior === null || devCurrent === null) {
    // No window to judge against: fall back to "did the number move at all".
    if (p === c) return "Held";
    return "Unknown";
  }

  if (devPrior === 0 && devCurrent === 0) return "Stable/In Range";

  // Tolerance scales with how far out the marker is, NOT with the raw value:
  // a 2 mmol/L sodium move is meaningful even though 2% of 135 is larger.
  const scale = Math.max(Math.abs(devPrior), Math.abs(devCurrent));
  const epsilon = scale * 0.02;
  if (devCurrent < devPrior - epsilon) return "Improved";
  if (devCurrent > devPrior + epsilon) return "Worsened";
  return "Held";
}

/**
 * Merge the prior-panel facts into the current-side chart.
 *
 * Rows are the UNION of (a) markers the engine flags on the current panel and
 * (b) markers the prior report flagged. For (b) that are no longer flagged, the
 * current value is looked up from the engine's full matched-marker set — so an
 * "Improved" row appears even though the current panel does not flag it. A
 * prior marker with no current counterpart renders as not retested. No row is
 * created that neither source supports.
 */
export function buildMergedComparisonGroups(
  flagged: FlaggedMarker[],
  priorFacts: Map<string, PriorMarkerFact>,
): ComparisonGroup[] {
  const rank = new Map(CATEGORY_DISPLAY.map((c, i) => [c.key, i]));
  const labels = new Map(CATEGORY_DISPLAY.map((c) => [c.key, c.label]));
  const byName = new Map(flagged.map((m) => [m.canonicalName, m]));

  const rowFor = (m: FlaggedMarker): ComparisonRow => {
    const within = withinLabRange(m);
    const fact = priorFacts.get(m.canonicalName);
    const isFlaggedNow = isFlagged(m);
    return {
      marker: m.canonicalName,
      prior: fact?.value ?? PRIOR_NOT_FOUND,
      current: formatResult(m),
      labRange: formatLabRange(m),
      optimalRange: formatOptimalRange(m),
      status: isFlaggedNow ? comparisonStatus(m, within) : "In Range",
      direction: isFlaggedNow ? m.flagDirection : null,
      trend: computeTrend(
        m.canonicalName,
        fact?.value ?? null,
        m.value,
        fact?.notComparable,
        m.effectiveLabRange,
      ),
      withinLabRange: within,
    };
  };

  const rows: ComparisonRow[] = [];
  const seen = new Set<string>();

  for (const m of flagged.filter(isFlagged)) {
    rows.push(rowFor(m));
    seen.add(m.canonicalName);
  }
  for (const [name, fact] of priorFacts) {
    if (seen.has(name)) continue;
    seen.add(name);
    const current = byName.get(name);
    if (current) {
      rows.push(rowFor(current));
    } else {
      // Flagged on the prior panel, absent from this one.
      rows.push({
        marker: name,
        prior: fact.value ?? PRIOR_NOT_FOUND,
        current: CURRENT_NOT_RETESTED,
        labRange: "—",
        optimalRange: "—",
        status: "Not retested",
        direction: null,
        trend: "Not retested",
        withinLabRange: null,
      });
    }
  }

  const buckets = new Map<string, ComparisonRow[]>();
  for (const row of rows) {
    const category = findMarker(row.marker)?.category ?? "other";
    const bucket = buckets.get(category);
    if (bucket) bucket.push(row);
    else buckets.set(category, [row]);
  }

  return [...buckets.entries()]
    .map(([category, groupRows]) => ({
      category,
      label: labels.get(category) ?? humanizeCategory(category),
      rows: groupRows.sort((a, b) => a.marker.localeCompare(b.marker)),
    }))
    .sort((a, b) => {
      const ra = rank.get(a.category) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.category) ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return a.label.localeCompare(b.label);
    });
}

/** "~8 months" between the prior panel and this draw. Only this label — never
 *  the prior date itself — is allowed into the payload. */
export function computePriorInterval(
  priorPanelDate: string | null | undefined,
  currentCollected: string,
): string | null {
  const p = (priorPanelDate ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!p) return null;
  const prior = new Date(Number(p[1]), Number(p[2]) - 1, Number(p[3]));

  let current: Date | null = null;
  const us = currentCollected.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const iso = currentCollected.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (us) current = new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]));
  else if (iso) current = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  if (!current) return null;

  const days = (current.getTime() - prior.getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days <= 0) return null;

  const months = Math.round(days / 30.44);
  if (months < 1) return "~under 1 month";
  if (months === 1) return "~1 month";
  if (months < 24) return `~${months} months`;
  const years = Math.round(months / 12);
  return `~${years} years`;
}

function humanizeCategory(key: string): string {
  return key
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

export function buildReassuring(flagged: FlaggedMarker[]): ReassuringMarkers {
  const optimal = flagged.filter((f) => f.flagStatus === "optimal");
  const label = (m: FlaggedMarker) =>
    `${m.canonicalName} (${m.value}${m.unit ? ` ${m.unit}` : ""})`;

  const byName = new Map(optimal.map((m) => [m.canonicalName, m]));
  const notable: string[] = [];
  for (const name of NOTABLE_REASSURING) {
    const m = byName.get(name);
    if (m) notable.push(label(m));
  }
  const notableNames = new Set(NOTABLE_REASSURING);
  const other = optimal
    .filter((m) => !notableNames.has(m.canonicalName))
    .slice()
    .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName))
    .map(label);

  return { notable, other, totalCount: optimal.length };
}

export function buildDeterministicAnalysis(
  flagged: FlaggedMarker[],
  inputs: AnalysisInputs,
): DeterministicAnalysis {
  const collected = formatDate(inputs.collectedDate) || inputs.patientDate;
  const reported = formatDate(inputs.reportedDate) || "—";

  // Age as of the draw when the PDF gives us a collection date, else today.
  const collectedMatch = collected.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const asOf = collectedMatch
    ? new Date(
        Number(collectedMatch[3]),
        Number(collectedMatch[1]) - 1,
        Number(collectedMatch[2]),
      )
    : new Date();
  const age = computeAge(inputs.dob, asOf);
  const dobDisplay = formatDob(inputs.dob);
  const dobAge = dobDisplay
    ? age !== null
      ? `${dobDisplay} (Age ${age})`
      : dobDisplay
    : "—";

  return {
    header: {
      patientName: inputs.patientName,
      dobAge,
      collected,
      reported,
      orderingPractice: ORDERING_PRACTICE,
      preparedFor: PREPARED_FOR,
    },
    rows: buildChartRows(flagged),
    comparisonGroups: buildComparisonGroups(flagged),
    reassuring: buildReassuring(flagged),
    age,
    sex: normalizeSex(inputs.sex),
  };
}
