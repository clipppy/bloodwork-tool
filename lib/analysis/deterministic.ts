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
import { referenceNoteForCell } from "../ranges/reference-note";
import {
  formatOptimalWindow,
  hormoneOverlayOf,
  type HormoneOverlaySummary,
} from "./hormone-ranges";
import type { SalivaCortisolFlags } from "./saliva-cortisol";
import {
  earlierReadingsOf,
  formatEarlierReadings,
  formatSourcesLine,
  sourceOf,
  sourceTag,
  type PanelSource,
} from "./panel-source";

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
  /** "Female" / "Male" / "—" as entered on the form. */
  sex: string;
  /** The selected cycle phase / menopausal status label for a female patient
   *  ("Early follicular (day 1-5)", "Not sure", ...), "n/a" otherwise. Printed
   *  so the report documents which hormone ranges were in force. */
  hormoneStatus: string;
}

export interface ChartRow {
  marker: string;
  /** "123 mcg/dL" or "117 mg/dL (calc) H" — the lab's own H/L is preserved. */
  result: string;
  labRange: string;
  optimalRange: string;
  /** "HIGH", "LOW", "BORDERLINE HIGH*", "SUBOPTIMAL*", ... */
  status: string;
  /** The lab verdict (labVerdict): true = provably inside the lab range (earns
   *  the asterisk), false = outside it — by the range, or by the lab's own H/L
   *  when there is no range — null = nothing to compare against. The tier and
   *  the chip colour are both read off this: only false charts red. */
  withinLabRange: boolean | null;
  category: string;
  /** "Quest · 08/26": which uploaded report this value came from. Set only
   *  when the composite panel spans more than one distinct lab or date;
   *  null for a single-report run, which therefore renders as before. */
  sourceTag: string | null;
  /** "earlier 4.1 g/dL · Quest 06/02": older readings of the same marker from
   *  other uploaded reports, display only. null when there are none. */
  earlier: string | null;
}

/** How the row builders tag provenance. Off by default so every existing
 *  caller (and a single-report run) produces untagged rows. */
export interface RowTagOptions {
  /** Print per-row source tags (the composite spans >1 lab or date). */
  multiSource?: boolean;
  /** Include the year in the tag (the composite spans >1 year). */
  withYear?: boolean;
}

function tagFor(m: FlaggedMarker, opts: RowTagOptions): string | null {
  if (!opts.multiSource) return null;
  const s = sourceOf(m);
  return s ? sourceTag(s, opts.withYear ?? false) : null;
}

function earlierFor(m: FlaggedMarker, opts: RowTagOptions): string | null {
  if (!opts.multiSource) return null;
  return formatEarlierReadings(earlierReadingsOf(m), opts.withYear ?? false);
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
  /** Markers inside BOTH the lab range and the functional optimal target, as
   *  chart rows (status "OPTIMAL") for the chart's green "What's Working"
   *  tier. Same formatters and order as `rows`; the engine's verdict is
   *  never re-derived here. Rendered only; never part of the API payload. */
  optimalRows: ChartRow[];
  /** Integer age derived from the DOB, or null. This — not the DOB — is what
   *  the API payload is allowed to carry. */
  age: number | null;
  sex: PatientSex;
  /** What the female-hormone overlay did on this panel (status, markers it
   *  supplied an optimal for, plain-English notes). null when it did not run. */
  hormone: HormoneOverlaySummary | null;
  /** 4-point salivary cortisol facts when a saliva report was uploaded and
   *  read (lib/analysis/saliva-cortisol); null otherwise. */
  salivaCortisol: SalivaCortisolFlags | null;
  /** Non-fatal note when a saliva report was uploaded but could not be read,
   *  so the document says so instead of silently omitting the section. */
  salivaCortisolNote: string | null;
  /** The uploaded blood reports that parsed, in upload order (one entry for
   *  a single-file run). */
  sources: PanelSource[];
  /** True when the composite spans more than one distinct lab or date, i.e.
   *  the chart rows carry source tags. */
  multiSource: boolean;
  /** True when the sources span more than one year (tags carry the year). */
  spansYears: boolean;
  /** Per-file notices for uploaded blood reports that could not be read.
   *  Printed in the document; never fatal. */
  sourceNotices: string[];
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
  /** Result of lib/analysis/hormone-ranges applyHormoneOverlay(), when the
   *  caller ran it over the flagged set it is passing in. */
  hormone?: HormoneOverlaySummary | null;
  /** Result of lib/analysis/saliva-cortisol flagSalivaCortisol(), when a
   *  saliva cortisol report was uploaded and read. */
  salivaCortisol?: SalivaCortisolFlags | null;
  /** Set when a saliva report was uploaded but could not be read. */
  salivaCortisolNote?: string | null;
  /** The blood reports that parsed (lib/analysis/merge-panels). Omitted by
   *  the single-report callers and the tests: the header then prints
   *  `collectedDate` as before and no row carries a source tag. */
  sources?: PanelSource[] | null;
  multiSource?: boolean;
  spansYears?: boolean;
  sourceNotices?: string[] | null;
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

/**
 * The lab-range verdict the chart tiers and chips are decided from.
 *
 * Same answer as withinLabRange when there is a range to compare against.
 * When there is none, the lab's own H/L printed beside the value is the lab's
 * verdict and counts as "outside" (false); with neither, null. Only a false
 * here can put a marker in the red tier — a marker with no lab range to
 * compare against is tiered by its functional optimal alone.
 */
export function labVerdict(m: FlaggedMarker): boolean | null {
  const within = withinLabRange(m);
  if (within !== null) return within;
  if (m.labFlagFromPdf === "H" || m.labFlagFromPdf === "L") return false;
  return null;
}

/** Which side of the lab range the value sits on: read off the same
 *  effectiveLabRange as withinLabRange, else off the lab's own H/L. null when
 *  the value is inside the range or there is nothing to compare against. */
export function labDirection(m: FlaggedMarker): "high" | "low" | null {
  const eff = m.effectiveLabRange;
  const v = numericValue(m.value);
  if (eff && v !== null) {
    if (eff.max !== null && v > eff.max) return "high";
    if (eff.min !== null && v < eff.min) return "low";
    if (eff.min !== null || eff.max !== null) return null;
  }
  if (m.labFlagFromPdf === "H") return "high";
  if (m.labFlagFromPdf === "L") return "low";
  return null;
}

/** The direction a chart row reports: the engine's flag direction, else (for a
 *  value the engine read as optimal but the lab range excludes) the lab side. */
export function rowDirection(m: FlaggedMarker): "high" | "low" | null {
  return m.flagDirection ?? labDirection(m);
}

/** The three chart tiers, worst first. Named for what they mean so the Word
 *  generator and the tests read the same vocabulary. */
export type MarkerTier = "outside-lab" | "outside-optimal" | "optimal";

/**
 * Tier precedence: LAB RANGE FIRST, then the functional optimal.
 *
 *   outside the lab range (labVerdict false)        -> "outside-lab"   (red)
 *   inside it, or no lab range, but engine-flagged  -> "outside-optimal" (amber)
 *   inside both                                      -> "optimal"       (green)
 *
 * The engine's own verdict is not re-derived: a marker it flagged stays
 * flagged. What this adds is the case the engine's optimal_two_tier handler
 * reads as "optimal" because the value sits inside the functional window even
 * though the lab range excludes it (Total Cholesterol 205 against a lab range
 * of <200 and a functional window of 150-220): the lab range governs, so the
 * marker charts red, never green. null for a marker that could not be
 * evaluated at all (not_flaggable / informational).
 */
export function markerTier(m: FlaggedMarker): MarkerTier | null {
  if (m.flagStatus === "not_flaggable" || m.flagStatus === "informational") return null;
  if (labVerdict(m) === false) return "outside-lab";
  if (isFlagged(m)) return "outside-optimal";
  if (m.flagStatus === "optimal") return "optimal";
  return null;
}

/** A marker that belongs in the flagged chart (red or amber tier). */
export function isChartFlagged(m: FlaggedMarker): boolean {
  const tier = markerTier(m);
  return tier === "outside-lab" || tier === "outside-optimal";
}

/** A marker that belongs in the green "What's Working" tier. */
export function isChartOptimal(m: FlaggedMarker): boolean {
  return markerTier(m) === "optimal";
}

/** Suffix the chart prints on a second, materially different result for a
 *  marker already on the panel (see lib/analysis/dedupe). */
export const REPEAT_SUFFIX = " (repeat)";

/** The name a chart row / payload entry prints for a marker. The canonical
 *  name, plus the repeat suffix when the dedupe pass kept this result as a
 *  repeat of an earlier one. Lookups (category, optimal range, body system)
 *  keep using canonicalName. */
export function displayMarkerName(m: FlaggedMarker): string {
  const repeat = (m as { repeatOf?: string }).repeatOf;
  return repeat ? `${m.canonicalName}${REPEAT_SUFFIX}` : m.canonicalName;
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
  const parsed = raw ? parseReferenceRange(raw) : null;
  if (parsed && (parsed.min !== null || parsed.max !== null || /\d/.test(raw))) return raw;
  // No numeric range: show the stratified table the lab printed rather than an
  // em dash, which would read as "no reference was printed at all".
  const note = referenceNoteForCell(m.referenceNoteRaw);
  if (note) return note;
  return "—";
}

/** The functional/optimal target. Three-tier markers show their bands;
 *  lab_range_only markers have no separate optimal, so they echo the lab range
 *  (the sample doc does the same for Non-HDL Cholesterol). */
export function formatOptimalRange(m: FlaggedMarker): string {
  // Analysis-path hormone overlay: the functional window came from the
  // practitioner's female hormone table, not the dictionary.
  const overlay = hormoneOverlayOf(m);
  if (overlay) return formatOptimalWindow(overlay.optimal);

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
 * Status column. Follows the same lab-first rule as markerTier, so the status
 * wording, the chip colour and the tier can never disagree.
 *
 * Outside the lab range (`within` false) → the plain direction: HIGH / LOW /
 * MODERATE / OUT OF RANGE. For a value the engine read as optimal but the lab
 * range excludes, the direction is the lab side (Cholesterol 205 vs <200 →
 * HIGH).
 *
 * Not outside it → the sample doc's softer wording. Severity comes straight
 * off the engine: mild reads BORDERLINE, anything further out reads ABOVE
 * OPTIMAL / SUBOPTIMAL. The asterisk the disclaimer explains ("sits within the
 * standard laboratory reference range") is added only when that is provable
 * (`within` true); with no lab range to compare against the wording stands
 * without it.
 */
export function formatStatus(m: FlaggedMarker, within: boolean | null): string {
  const outsideLab = within === false;
  const star = within === true ? "*" : "";

  if (m.flagStatus === "out_of_range") return `OUT OF RANGE${star}`;
  if (m.flagStatus === "moderate") return `MODERATE${star}`;

  const dir = rowDirection(m);
  if (dir === "high") {
    if (outsideLab) return "HIGH";
    return m.flagSeverity === "mild" ? `BORDERLINE HIGH${star}` : `ABOVE OPTIMAL${star}`;
  }
  if (dir === "low") {
    if (outsideLab) return "LOW";
    return m.flagSeverity === "mild" ? `BORDERLINE LOW${star}` : `SUBOPTIMAL${star}`;
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

/** The red and amber tiers: every marker the engine flagged, plus any the lab
 *  range excludes even though the engine read it as optimal (markerTier). */
export function buildChartRows(flagged: FlaggedMarker[], opts: RowTagOptions = {}): ChartRow[] {
  return flagged
    .filter(isChartFlagged)
    .slice()
    .sort(compareRows)
    .map((m) => {
      const within = labVerdict(m);
      return {
        marker: displayMarkerName(m),
        result: formatResult(m),
        labRange: formatLabRange(m),
        optimalRange: formatOptimalRange(m),
        status: formatStatus(m, within),
        withinLabRange: within,
        category: findMarker(m.canonicalName)?.category ?? "",
        sourceTag: tagFor(m, opts),
        earlier: earlierFor(m, opts),
      };
    });
}

/** The green tier: every marker inside BOTH the lab range and the functional
 *  optimal, in the same category / name order, with the status the chip
 *  vocabulary already knows ("OPTIMAL" -> green). A marker the engine could
 *  not evaluate (not_flaggable / informational) is in neither list. */
export function buildOptimalRows(flagged: FlaggedMarker[], opts: RowTagOptions = {}): ChartRow[] {
  return flagged
    .filter(isChartOptimal)
    .slice()
    .sort(compareRows)
    .map((m) => ({
      marker: displayMarkerName(m),
      result: formatResult(m),
      labRange: formatLabRange(m),
      optimalRange: formatOptimalRange(m),
      status: "OPTIMAL",
      withinLabRange: labVerdict(m),
      category: findMarker(m.canonicalName)?.category ?? "",
      sourceTag: tagFor(m, opts),
      earlier: earlierFor(m, opts),
    }));
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
  /** Provenance tags, as on ChartRow; null unless the composite is multi-source. */
  sourceTag: string | null;
  earlier: string | null;
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
  if (within === false) return "Out of Lab Range";
  // Inside the lab range, or no usable lab range: the flag came from the
  // optimal/band side (same lab-first rule as markerTier).
  return "Out of Optimal";
}

/**
 * Current-side comparison chart, grouped by the dictionary's category.
 *
 * Row set is the engine's own isFlagged() — the markers flagged on the CURRENT
 * draw. Markers that were out of range on the prior panel but are optimal now
 * (the sample's "Improved" rows) can only be identified from the prior report,
 * so Phase 2b adds them; 2a never invents a row the current labs don't support.
 */
export function buildComparisonGroups(
  flagged: FlaggedMarker[],
  opts: RowTagOptions = {},
): ComparisonGroup[] {
  const rank = new Map(CATEGORY_DISPLAY.map((c, i) => [c.key, i]));
  const labels = new Map(CATEGORY_DISPLAY.map((c) => [c.key, c.label]));

  const buckets = new Map<string, ComparisonRow[]>();
  for (const m of flagged.filter(isChartFlagged)) {
    const category = findMarker(m.canonicalName)?.category ?? "other";
    const within = labVerdict(m);
    const row: ComparisonRow = {
      marker: displayMarkerName(m),
      prior: PRIOR_PENDING,
      current: formatResult(m),
      labRange: formatLabRange(m),
      optimalRange: formatOptimalRange(m),
      status: comparisonStatus(m, within),
      direction: rowDirection(m),
      trend: TREND_PENDING,
      withinLabRange: within,
      sourceTag: tagFor(m, opts),
      earlier: earlierFor(m, opts),
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
  /** A window that outranks the dictionary's: the female-hormone overlay's
   *  functional optimal for this marker, when the analysis applied one. */
  preferredWindow?: { min: number | null; max: number | null } | null,
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
  const window = hasBounds(preferredWindow)
    ? preferredWindow!
    : hasBounds(rec?.optimalRange)
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
  opts: RowTagOptions = {},
): ComparisonGroup[] {
  const rank = new Map(CATEGORY_DISPLAY.map((c, i) => [c.key, i]));
  const labels = new Map(CATEGORY_DISPLAY.map((c) => [c.key, c.label]));
  const byName = new Map(flagged.map((m) => [displayMarkerName(m), m]));

  const rowFor = (m: FlaggedMarker): ComparisonRow => {
    const within = labVerdict(m);
    const fact = priorFacts.get(m.canonicalName);
    const isFlaggedNow = isChartFlagged(m);
    return {
      marker: displayMarkerName(m),
      prior: fact?.value ?? PRIOR_NOT_FOUND,
      current: formatResult(m),
      labRange: formatLabRange(m),
      optimalRange: formatOptimalRange(m),
      status: isFlaggedNow ? comparisonStatus(m, within) : "In Range",
      direction: isFlaggedNow ? rowDirection(m) : null,
      trend: computeTrend(
        m.canonicalName,
        fact?.value ?? null,
        m.value,
        fact?.notComparable,
        m.effectiveLabRange,
        hormoneOverlayOf(m)?.optimal ?? null,
      ),
      withinLabRange: within,
      sourceTag: tagFor(m, opts),
      earlier: earlierFor(m, opts),
    };
  };

  const rows: ComparisonRow[] = [];
  const seen = new Set<string>();

  for (const m of flagged.filter(isChartFlagged)) {
    rows.push(rowFor(m));
    seen.add(displayMarkerName(m));
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
        sourceTag: null,
        earlier: null,
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
  // Inside both ranges. A value the lab range excludes is never "reassuring",
  // even when the engine read it as inside the functional window.
  const optimal = flagged.filter(isChartOptimal);
  const label = (m: FlaggedMarker) =>
    `${displayMarkerName(m)} (${m.value}${m.unit ? ` ${m.unit}` : ""})`;

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
  const sources = inputs.sources ?? [];
  const multiSource = !!inputs.multiSource && sources.length > 0;
  const spansYears = !!inputs.spansYears;
  const tagOpts: RowTagOptions = { multiSource, withYear: spansYears };

  // One report: the draw date as before. Several: every source, so the header
  // documents which lab and date each part of the composite came from.
  const drawDate = formatDate(inputs.collectedDate) || inputs.patientDate;
  const collected = sources.length > 1 ? `Blood: ${formatSourcesLine(sources)}` : drawDate;
  const reported = formatDate(inputs.reportedDate) || "—";

  // Age as of the (most recent) draw when a collection date is known, else today.
  const collectedMatch = drawDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
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

  const sex = normalizeSex(inputs.sex);
  const hormone = inputs.hormone ?? null;
  const sexDisplay = sex === "female" ? "Female" : sex === "male" ? "Male" : "—";
  // Self-documenting header: which hormone ranges were in force. Only a female
  // patient has a status; everyone else reads "n/a" so the cell never looks
  // like a value the tool should have had.
  const hormoneStatus =
    sex === "female" ? (hormone?.statusLabel ?? "Not provided") : "n/a";

  return {
    header: {
      patientName: inputs.patientName,
      dobAge,
      collected,
      reported,
      orderingPractice: ORDERING_PRACTICE,
      preparedFor: PREPARED_FOR,
      sex: sexDisplay,
      hormoneStatus,
    },
    rows: buildChartRows(flagged, tagOpts),
    comparisonGroups: buildComparisonGroups(flagged, tagOpts),
    reassuring: buildReassuring(flagged),
    optimalRows: buildOptimalRows(flagged, tagOpts),
    age,
    sex,
    hormone,
    salivaCortisol: inputs.salivaCortisol ?? null,
    salivaCortisolNote: inputs.salivaCortisolNote ?? null,
    sources,
    multiSource,
    spansYears,
    sourceNotices: [...(inputs.sourceNotices ?? [])],
  };
}
