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
  "additional physician-ordered testing. Findings marked with an asterisk (*) fall " +
  "within the standard laboratory reference range but outside commonly used " +
  "functional/optimal ranges.";

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

/** Placeholder text for the two columns Phase 2b sources from the prior report. */
export const PRIOR_PENDING = "[from prior report]";
export const TREND_PENDING = "[vs prior: pending]";

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
