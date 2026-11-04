/**
 * Word generator for the Clinical Analysis report.
 *
 * Separate from generator/word.ts, which builds the existing data report and is
 * not touched by this feature. Structure mirrors
 * samples/analysis-examples/Robidoux_Functional_Medicine_Analysis.docx:
 *
 *   Title / subtitle
 *   Header block (patient, dates, practice)  <- identifiers merged in LOCALLY
 *   Decision-support disclaimer
 *   1. Clinical Presentation Summary         <- LLM (Phase 1b)
 *   2. Lab Findings by Severity (chart)     <- DETERMINISTIC rows (this file)
 *                                             + LLM per-marker Interpretation notes
 *   3. Root Cause Analysis by Marker/Pattern <- LLM (Phase 1b)
 *   4. Phased Functional Medicine Protocol   <- LLM (Phase 1b)
 *   5. Summary of Findings - In Plain Language <- LLM (Phase 1b)
 *   Footer note
 *
 * The four LLM sections currently render labelled placeholders. Every number in
 * section 2 comes from lib/analysis/deterministic.ts, never from a model.
 *
 * Section 2 (and Part II of the re-eval) is grouped by SEVERITY TIER, worst
 * first, matching the practitioner's validated layout: red = outside the lab
 * reference range, amber = inside it but outside the functional optimal
 * target, green = optimal ("What's Working"). Body system is the secondary
 * order inside each tier. The tier is read off the deterministic status /
 * withinLabRange the same way the chip colour is; nothing is re-flagged here.
 *
 * The chart prints in its own LANDSCAPE section (the practitioner's wide
 * format) so the Interpretation column - the model's one-or-two-sentence
 * plain-language note per flagged marker, joined to its row by canonical name -
 * has room to read. A marker with no note gets a blank cell, never an error.
 * The in-range tier carries no notes.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  AlignmentType,
  BorderStyle,
  WidthType,
  ShadingType,
  PageOrientation,
  type ISectionOptions,
} from "docx";
import {
  DISCLAIMER,
  PRIOR_NOT_FOUND,
  PRIOR_PENDING,
  type ChartRow,
  type ComparisonRow,
  type DeterministicAnalysis,
} from "../analysis/deterministic";
import { groupBySystem, type BodySystemGroup } from "../analysis/body-systems";
import {
  SYMPTOM_TAG_LABEL,
  type AnalysisNarrative,
  type NarrativeBlock,
  type ReevalNarrative,
} from "../analysis/prompt";
import {
  cortisolStatusWord,
  formatCortisolResult,
} from "../analysis/saliva-cortisol";

// ----- Brand (matches generator/word.ts; duplicated because those constants
// are module-private there and that file is intentionally not modified) -----
const NAVY = "1B365D";
const TEAL = "4A90A4";
const LIGHT_TEAL = "DCE9EE";
const GREY = "666666";
const LIGHT_GREY = "CCCCCC";
const TREND_GREEN = "2E7D32";
const TREND_RED = "C00000";

// Status-chip fills. Chip text is always bold white, so each fill is dark
// enough to clear 4.5:1 contrast against white.
const CHIP_LAB = "C00000"; // outside the standard lab range
const CHIP_OPTIMAL = "B26A00"; // inside the lab range, outside the functional target
const CHIP_IN_RANGE = "2E7D32"; // inside both ranges (green tier; re-eval "In Range")
const CHIP_NEUTRAL = "6E6E6E"; // re-eval only: not retested / nothing to compare
const CHIP_NEW = "4A5B6E"; // re-eval only: no prior value, so nothing to trend

const PAGE_WIDTH = 12240;
const PAGE_HEIGHT = 15840;
const PAGE_MARGIN = 1440;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2; // 9360

// Column widths: every table's numbers go into its `columnWidths` as well as
// each cell's `width`, and sum to the section's content width. Without
// columnWidths the docx writer emits a tblGrid of 100-twip columns; Word
// happens to re-fit from the cell widths, but every other renderer (Pages,
// LibreOffice, Google Docs, most PDF converters) honours the grid and squeezes
// the table into an unreadable mess. The grid is the fix.

// The chart section is landscape: the same sheet turned, same margins.
const LANDSCAPE_CONTENT_WIDTH = PAGE_HEIGHT - PAGE_MARGIN * 2; // 12960

// Tier A/B chart in landscape, with the Interpretation column widest. The
// range columns hold "Reference" on one line; Status fits the longest chip
// label ("Out of Lab Range") on one line, the direction on its own line.
const LC_MARKER = 1500;
const LC_RESULT = 1400;
const LC_LAB = 1500;
const LC_OPTIMAL = 1500;
const LC_STATUS = 2000;
const LC_NOTE = 5060;
const LANDSCAPE_CHART_GRID = [LC_MARKER, LC_RESULT, LC_LAB, LC_OPTIMAL, LC_STATUS, LC_NOTE];

// Condensed in-range table in landscape: five columns, no notes.
const LO_MARKER = 2600;
const LO_RESULT = 2600;
const LO_LAB = 2400;
const LO_OPTIMAL = 2400;
const LO_STATUS = 2960;
const LANDSCAPE_OPTIMAL_GRID = [LO_MARKER, LO_RESULT, LO_LAB, LO_OPTIMAL, LO_STATUS];

// Header block: label/value twice across.
const HDR_LABEL = 1900;
const HDR_VALUE = 2780;
const HEADER_GRID = [HDR_LABEL, HDR_VALUE, HDR_LABEL, HDR_VALUE];

const FOOTER_NOTE =
  "Prepared as clinical decision support based on the laboratory results named above. " +
  "Not a substitute for evaluation by a licensed physician. Recommended follow-up " +
  "testing should be ordered by the treating provider.";

/**
 * Renders with the model's narrative when one is supplied; without it, the four
 * narrative sections fall back to labelled placeholders, which is what makes a
 * document still recoverable after an API failure.
 */
export async function generateAnalysisReport(
  analysis: DeterministicAnalysis,
  narrative?: AnalysisNarrative | null,
): Promise<Buffer> {
  return Packer.toBuffer(buildDocument(analysis, narrative ?? null));
}

/**
 * Re-evaluation variant, mirroring
 * samples/analysis-examples/"Bonnie St. Germain - BW Re-eval 1.docx":
 * header line, Part I Overview, Part II legend + category-grouped comparison
 * chart, Parts III-V. Phase 2a fills the current side of the chart from the
 * flagging engine; the Prior column, the improved/worsened trend, and the four
 * narrative Parts render as labelled placeholders until Phase 2b.
 */
export async function generateReevalReport(
  analysis: DeterministicAnalysis,
  priorReportIngested: boolean,
  narrative?: ReevalNarrative | null,
  /** Prior draw date, "YYYY-MM-DD" as the form collects it. Optional so the
   *  existing call sites keep compiling; the Previous Draw row is omitted
   *  rather than guessed when it is not supplied. */
  priorPanelDate?: string | null,
): Promise<Buffer> {
  return Packer.toBuffer(
    buildReevalDocument(
      analysis,
      priorReportIngested,
      narrative ?? null,
      priorPanelDate ?? null,
    ),
  );
}

// ----- Document assembly -----

function buildDocument(
  analysis: DeterministicAnalysis,
  narrative: AnalysisNarrative | null,
): Document {
  // Three docx sections: portrait up to the chart, the chart in landscape,
  // portrait from the cortisol table onwards. `children` is re-pointed at each.
  const before: Array<Paragraph | Table> = [];
  const chart: Array<Paragraph | Table> = [];
  const after: Array<Paragraph | Table> = [];
  let children = before;

  // Title block
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: "FUNCTIONAL MEDICINE LAB ANALYSIS",
          bold: true,
          color: NAVY,
          size: 32,
          font: "Arial",
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: "Clinical Correlation & Phased Protocol Recommendations",
          italics: true,
          color: TEAL,
          size: 24,
          font: "Arial",
        }),
      ],
    }),
  );

  // Header block
  children.push(buildHeaderTable(analysis));
  children.push(blank());

  // Disclaimer
  children.push(
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: DISCLAIMER,
          italics: true,
          color: GREY,
          size: 20,
          font: "Arial",
        }),
      ],
    }),
  );

  // 1. Clinical Presentation Summary — LLM
  children.push(sectionHeading("1. Clinical Presentation Summary"));
  children.push(
    ...(narrative
      ? renderBlocks(narrative.clinicalPresentation)
      : [
          llmPlaceholder(
            "Clinical Presentation Summary",
            "Written from the practitioner's intake / symptom notes. No lab values are authored here.",
          ),
        ]),
  );

  // 2. Chart — DETERMINISTIC rows + LLM interpretation notes (landscape)
  children = chart;
  children.push(sectionHeading("2. Lab Findings by Severity"));
  children.push(buildColorKey(false));
  // Three severity tiers, worst first; body system is the order inside each.
  // Flagged rows are untouched — only the split points are new. The green
  // tier is the in-range markers, which the chart previously left out.
  const notes = narrative ? narrative.markerNotes : EMPTY_NOTES;
  for (const { tier, items } of groupByTier(
    [...analysis.rows, ...analysis.optimalRows],
    tierForChartRow,
  )) {
    children.push(tierHeading(tier));
    if (items.length === 0) {
      children.push(tierEmptyNote(tier));
      continue;
    }
    if (tier === "optimal") {
      children.push(buildOptimalTable(groupBySystem(items, (r) => r.marker)));
      children.push(blank());
      continue;
    }
    for (const group of groupBySystem(items, (r) => r.marker)) {
      children.push(groupHeading(group.system));
      children.push(buildChartTable(group.items, notes));
      children.push(blank());
    }
  }
  children.push(...buildHormoneNotes(analysis));

  // Back to portrait: the cortisol table has its own portrait grid.
  children = after;
  // Salivary cortisol (when a saliva report was uploaded), with the endocrine
  // findings; the model's diurnal reading sits under its own table.
  children.push(...buildSalivaCortisolSection(analysis, narrative ? narrative.cortisol : null));
  // Narrative reading of the in-range markers (LLM). The code-built list of
  // in-range markers that used to follow it is now the chart's green tier.
  if (narrative) children.push(...renderBlocks(narrative.reassuring));

  // 3. Root Cause Analysis — LLM
  children.push(sectionHeading("3. Root Cause Analysis by Marker/Pattern"));
  children.push(
    ...(narrative
      ? renderBlocks(narrative.rootCause)
      : [
          llmPlaceholder(
            "Root-Cause Analysis",
            "Reasoning per marker/pattern, grounded in the verified chart above. The chart's values, ranges, and statuses are supplied to the model as ground truth and are never re-derived by it.",
          ),
        ]),
  );

  // 4. Phased Protocol — LLM
  children.push(sectionHeading("4. Phased Functional Medicine Protocol"));
  children.push(
    ...(narrative
      ? renderBlocks(narrative.protocol)
      : [
          llmPlaceholder(
            "Phased Protocol",
            "Phase goals and interventions at category / practitioner-discretion depth. The practitioner reviews and selects the actual products.",
          ),
        ]),
  );

  // 5. Plain-language summary — LLM
  children.push(sectionHeading("5. Summary of Findings — In Plain Language"));
  children.push(
    ...(narrative
      ? renderBlocks(narrative.patientSummary)
      : [llmPlaceholder("Patient Summary", "Plain-language recap for the patient.")]),
  );

  // Footer note
  children.push(blank());
  children.push(
    new Paragraph({
      spacing: { before: 240 },
      children: [
        new TextRun({
          text: FOOTER_NOTE,
          italics: true,
          color: GREY,
          size: 18,
          font: "Arial",
        }),
      ],
    }),
  );

  return new Document({
    creator: "Carbone Chiropractic Center, LLC",
    title: "Functional Medicine Lab Analysis",
    description: "Clinical correlation and phased protocol recommendations",
    sections: [
      docSection(before, "portrait"),
      docSection(chart, "landscape"),
      docSection(after, "portrait"),
    ],
  });
}

/** No narrative (placeholder document): every Interpretation cell is blank. */
const EMPTY_NOTES: ReadonlyMap<string, string> = new Map();

/**
 * One docx section. A section break always starts a new page, so the chart
 * opens on its own landscape page and the prose resumes on a portrait one.
 * Same margins either way; docx swaps width/height for landscape itself.
 */
function docSection(
  children: Array<Paragraph | Table>,
  orientation: "portrait" | "landscape",
): ISectionOptions {
  return {
    properties: {
      page: {
        size: {
          width: PAGE_WIDTH,
          height: PAGE_HEIGHT,
          orientation:
            orientation === "landscape" ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
        },
        margin: {
          top: PAGE_MARGIN,
          right: PAGE_MARGIN,
          bottom: PAGE_MARGIN,
          left: PAGE_MARGIN,
        },
      },
    },
    children,
  };
}

// ----- Re-evaluation document -----

function buildReevalDocument(
  analysis: DeterministicAnalysis,
  priorReportIngested: boolean,
  narrative: ReevalNarrative | null,
  priorPanelDate: string | null,
): Document {
  const before: Array<Paragraph | Table> = [];
  const chart: Array<Paragraph | Table> = [];
  const after: Array<Paragraph | Table> = [];
  let children = before;
  const h = analysis.header;

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: "CARBONE CHIROPRACTIC CENTER, LLC",
          bold: true,
          color: NAVY,
          size: 28,
          font: "Arial",
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: "FUNCTIONAL MEDICINE FOLLOW-UP REPORT — COMPARATIVE ANALYSIS",
          bold: true,
          color: TEAL,
          size: 24,
          font: "Arial",
        }),
      ],
    }),
    // Sample renders this as one line: "Patient: <name>   |   <date>".
    new Paragraph({
      spacing: { after: 60 },
      children: [
        runBold("Patient: "),
        runPlain(h.patientName),
        runPlain("   |   "),
        runPlain(h.collected),
        ...(h.dobAge !== "—"
          ? [runPlain("   |   "), runBold("DOB / Age: "), runPlain(h.dobAge)]
          : []),
        ...(h.sex !== "—"
          ? [runPlain("   |   "), runBold("Sex: "), runPlain(h.sex)]
          : []),
        ...(h.hormoneStatus !== "n/a"
          ? [runPlain("   |   "), runBold("Hormonal Status: "), runPlain(h.hormoneStatus)]
          : []),
      ],
    }),
    new Paragraph({
      spacing: { after: 120 },
      children: [
        runItalic(
          priorReportIngested
            ? "Prior report received and de-identified; prior values are merged in the comparative pass."
            : "No prior report was supplied.",
          GREY,
          18,
        ),
      ],
    }),
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: DISCLAIMER,
          italics: true,
          color: GREY,
          size: 20,
          font: "Arial",
        }),
      ],
    }),
  );

  // Which two draws this report compares. Dates only: the panel's composition
  // cannot be derived here without the full parsed marker list (this generator
  // only receives the flagged rows plus the in-range names), and a partial
  // composition would read as complete, so it is omitted rather than guessed.
  children.push(buildDrawTable(analysis, priorPanelDate));
  children.push(blank());

  // Part I — Overview (LLM, 2b)
  children.push(sectionHeading("Part I: Overview"));
  children.push(
    ...(narrative
      ? renderBlocks(narrative.overview)
      : [
          llmPlaceholder(
            "Comparative Overview",
            "What the patient originally presented with, what this panel compares against, and the headline direction of travel. Sourced from the de-identified prior report plus the current flags.",
          ),
        ]),
  );

  // Part II — comparison chart (deterministic current side), landscape
  children = chart;
  children.push(sectionHeading("Part II: Lab Findings by Severity — Marker Comparison"));
  children.push(buildColorKey(true));
  const notes = narrative ? narrative.markerNotes : EMPTY_NOTES;

  // Same three severity tiers as the initial chart, worst first, with the
  // body-system taxonomy as the order inside each so both modes read the same
  // way. Comparison rows themselves are unchanged; alphabetical order inside a
  // sub-label keeps two runs over one panel byte-identical. The green tier
  // carries the back-in-range comparison rows (with their prior value and
  // trend) and then, condensed, every other marker that is optimal now.
  const comparisonRows = analysis.comparisonGroups.flatMap((g) => g.rows);
  const byName = <T extends { marker: string }>(rows: T[]): T[] =>
    rows.slice().sort((a, b) => a.marker.localeCompare(b.marker));
  const inComparison = new Set(comparisonRows.map((r) => r.marker));
  const notRetested = comparisonRows.filter((r) => tierForComparisonRow(r) === null);
  for (const { tier, items } of groupByTier(comparisonRows, tierForComparisonRow)) {
    children.push(tierHeading(tier));
    const condensed =
      tier === "optimal"
        ? analysis.optimalRows.filter((r) => !inComparison.has(r.marker))
        : [];
    if (items.length === 0 && condensed.length === 0) {
      children.push(tierEmptyNote(tier));
      continue;
    }
    for (const group of groupBySystem(items, (r) => r.marker)) {
      children.push(groupHeading(group.system));
      children.push(buildComparisonTable(byName(group.items), notes));
      children.push(blank());
    }
    if (condensed.length) {
      if (items.length) {
        children.push(groupHeading("Also within both ranges on this panel"));
      }
      children.push(buildOptimalTable(groupBySystem(condensed, (r) => r.marker)));
      children.push(blank());
    }
  }
  // Flagged on the prior report, absent from this draw: no tier applies.
  if (notRetested.length) {
    children.push(groupHeading("Not Retested on This Panel"));
    children.push(buildComparisonTable(byName(notRetested), notes));
    children.push(blank());
  }

  if (comparisonRows.length > 0) {
    children.push(...buildHormoneNotes(analysis));
    children.push(
      new Paragraph({
        spacing: { after: 240 },
        children: [
          runItalic(
            narrative
              ? `Prior-panel values are read from the prior report and are the only figures in this table not computed by the tool — please spot-check them against that report. ${PRIOR_NOT_FOUND} means the prior report printed no usable value for that marker. The improved / held / worsened trend is computed by the tool from the two values, not written by the model.`
              : `Prior-panel values and the improved/worsened trend are read from the prior report in the comparative pass; they render as ${PRIOR_PENDING} here. Markers that were out of range previously but are within range now are added in that same pass — they cannot be identified from the current panel alone.`,
            GREY,
            18,
          ),
        ],
      }),
    );
  }

  // Back to portrait for the cortisol table (its own portrait grid) onwards.
  children = after;
  // Salivary cortisol (when uploaded) closes the comparison section, with the
  // endocrine findings, whether or not any marker was out of range.
  children.push(...buildSalivaCortisolSection(analysis, narrative ? narrative.cortisol : null));

  // Part III — comparative root causes (LLM, 2b)
  children.push(sectionHeading("Part III: Root Cause Analysis"));
  children.push(
    ...(narrative
      ? renderBlocks(narrative.rootCause)
      : [
          llmPlaceholder(
            "Comparative Root-Cause Analysis",
            "Per-pattern reasoning across the two panels: what moved, what held, and why. The chart's numbers are supplied as ground truth and are never re-derived.",
          ),
        ]),
  );

  // What's already improving — reinforced, not changed. Heading omitted when
  // the model returned nothing, rather than printing an empty section.
  if (narrative && narrative.alreadyImproving.length > 0) {
    children.push(
      sectionHeading("What's Already Improving (worth reinforcing, not changing)"),
    );
    children.push(...renderBlocks(narrative.alreadyImproving));
  }

  // Markers the prior report flagged that this draw did not re-test.
  if (narrative && narrative.backgroundFindings.length > 0) {
    children.push(sectionHeading("Background Findings Not Re-Tested This Draw"));
    children.push(...renderBlocks(narrative.backgroundFindings));
  }

  // Part IV — updated protocol (LLM, 2b)
  children.push(sectionHeading("Part IV: Phased Protocol (Updated from Prior Plan)"));
  children.push(
    ...(narrative
      ? renderBlocks(narrative.protocol)
      : [
          llmPlaceholder(
            "Updated Phased Protocol",
            "Builds on the prior plan rather than replacing it: taper what improved, intensify or re-target what held or worsened. Category depth, practitioner discretion.",
          ),
        ]),
  );

  // Part V — plain-language summary (LLM, 2b)
  children.push(sectionHeading("Part V: Summary — In Plain Language"));
  children.push(
    ...(narrative
      ? renderBlocks(narrative.patientSummary)
      : [
          llmPlaceholder(
            "Patient Summary",
            "Plain-language comparative recap for the patient.",
          ),
        ]),
  );

  children.push(blank());
  children.push(
    new Paragraph({
      spacing: { before: 240 },
      children: [
        new TextRun({
          text: FOOTER_NOTE,
          italics: true,
          color: GREY,
          size: 18,
          font: "Arial",
        }),
      ],
    }),
  );

  return new Document({
    creator: "Carbone Chiropractic Center, LLC",
    title: "Functional Medicine Follow-Up Report",
    description: "Comparative analysis of current and prior blood work",
    sections: [
      docSection(before, "portrait"),
      docSection(chart, "landscape"),
      docSection(after, "portrait"),
    ],
  });
}

/**
 * Colour key above the chart: RED = outside the lab reference range, AMBER =
 * inside the lab range but outside the functional optimal target, GREEN =
 * optimal. The re-eval chart adds the New Finding chip its trend line uses.
 */
function buildColorKey(includeNewFinding: boolean): Paragraph {
  const swatch = (text: string, fill: string) =>
    new TextRun({
      text: `  ${text}  `,
      bold: true,
      color: "FFFFFF",
      size: 18,
      font: "Arial",
      shading: { fill, type: ShadingType.CLEAR, color: "auto" },
    });
  const meaning = (text: string) =>
    new TextRun({ text, color: "000000", size: 18, font: "Arial" });
  return new Paragraph({
    spacing: { after: 160 },
    keepNext: true,
    children: [
      runBold("Color key:  "),
      swatch("RED", CHIP_LAB),
      meaning(" = outside lab reference range     "),
      swatch("AMBER", CHIP_OPTIMAL),
      meaning(" = inside lab range but outside functional optimal     "),
      swatch("GREEN", CHIP_IN_RANGE),
      meaning(" = optimal"),
      ...(includeNewFinding
        ? [
            meaning("     "),
            swatch("New Finding", CHIP_NEW),
            meaning(" = no prior value to compare against"),
          ]
        : []),
      runItalic("     (High) / (Low) on a chip gives the direction.", GREY, 18),
    ],
  });
}

// ----- Severity tiers -----

/** The chart's primary grouping: where the value sits, worst first. Body
 *  system is the secondary order inside each tier. */
export type ChartTier = "outside-lab" | "outside-optimal" | "optimal";

export const CHART_TIERS: readonly ChartTier[] = ["outside-lab", "outside-optimal", "optimal"];

export const TIER_LABELS: Readonly<Record<ChartTier, string>> = {
  "outside-lab": "Outside Lab Reference Range",
  "outside-optimal": "Inside Lab Range, Outside Functional Optimal",
  optimal: "Optimal — What's Working",
};

const TIER_FILLS: Readonly<Record<ChartTier, string>> = {
  "outside-lab": CHIP_LAB,
  "outside-optimal": CHIP_OPTIMAL,
  optimal: CHIP_IN_RANGE,
};

const TIER_EMPTY_NOTES: Readonly<Record<ChartTier, string>> = {
  "outside-lab": "No markers fell outside the lab reference range on this panel.",
  "outside-optimal":
    "No markers sat inside the lab range but outside the functional optimal target on this panel.",
  optimal:
    "No markers fell within both the lab reference range and the functional optimal target on this panel.",
};

/**
 * Tier of an initial-mode chart row. The same rule as the chip's colour:
 * provably inside the lab range -> amber tier; outside it, or no usable lab
 * range to compare against -> red tier. A row whose deterministic status is
 * OPTIMAL (from `optimalRows`) is the green tier.
 */
export function tierForChartRow(row: Pick<ChartRow, "status" | "withinLabRange">): ChartTier {
  const key = (row.status ?? "").replace(/\*+$/, "").trim().toUpperCase();
  if (key === "OPTIMAL") return "optimal";
  return row.withinLabRange === true ? "outside-optimal" : "outside-lab";
}

/**
 * Tier of a re-eval comparison row, read off its deterministic status wording
 * (comparisonStatus / the merge's "In Range"). A "Not retested" row — flagged
 * on the prior report, absent from this draw — belongs to no tier: null.
 */
export function tierForComparisonRow(
  row: Pick<ComparisonRow, "status" | "withinLabRange">,
): ChartTier | null {
  const key = (row.status ?? "").trim().toUpperCase();
  if (key === "OUT OF LAB RANGE") return "outside-lab";
  if (key === "OUT OF OPTIMAL") return "outside-optimal";
  if (key === "IN RANGE") return "optimal";
  if (key === "NOT RETESTED") return null;
  return row.withinLabRange === true ? "outside-optimal" : "outside-lab";
}

export interface TierGroup<T> {
  tier: ChartTier;
  items: T[];
}

/**
 * Split rows into the three tiers, in tier order, keeping each row's relative
 * order inside its tier. Every tier is returned even when empty, so the
 * document always prints all three headings; rows with no tier are dropped
 * (the caller renders them separately).
 */
export function groupByTier<T>(
  items: readonly T[],
  tierOf: (item: T) => ChartTier | null,
): Array<TierGroup<T>> {
  const buckets = new Map<ChartTier, T[]>(CHART_TIERS.map((t) => [t, []]));
  for (const item of items) {
    const tier = tierOf(item);
    if (tier) buckets.get(tier)!.push(item);
  }
  return CHART_TIERS.map((tier) => ({ tier, items: buckets.get(tier)! }));
}

/** Tier heading: a swatch in the tier's colour, then the label. keepNext
 *  binds it to whatever follows so it never strands at the foot of a page. */
function tierHeading(tier: ChartTier): Paragraph {
  return new Paragraph({
    spacing: { before: 320, after: 80 },
    keepNext: true,
    children: [
      new TextRun({
        text: "     ",
        size: 24,
        font: "Arial",
        shading: { fill: TIER_FILLS[tier], type: ShadingType.CLEAR, color: "auto" },
      }),
      new TextRun({
        text: `  ${TIER_LABELS[tier]}`,
        bold: true,
        color: NAVY,
        size: 24,
        font: "Arial",
      }),
    ],
  });
}

function tierEmptyNote(tier: ChartTier): Paragraph {
  return new Paragraph({
    spacing: { after: 160 },
    children: [runItalic(TIER_EMPTY_NOTES[tier], GREY, 18)],
  });
}

/** Body-system sub-label inside a tier: lighter than the tier heading so the
 *  tier reads as the primary grouping. keepNext binds it to the table that
 *  follows so a label can never strand alone at the foot of a page. */
function groupHeading(label: string): Paragraph {
  return new Paragraph({
    spacing: { before: 160, after: 80 },
    keepNext: true,
    children: [
      new TextRun({ text: label, bold: true, color: TEAL, size: 20, font: "Arial" }),
    ],
  });
}

// Comparison columns sum to LANDSCAPE_CONTENT_WIDTH (12960). Same rule as the
// chart grid: whatever is here must also be emitted as the table's
// columnWidths. The Interpretation column is the widest.
const RC_MARKER = 1400;
const RC_PRIOR = 1100;
const RC_CURRENT = 1200;
const RC_LAB = 1500;
const RC_OPTIMAL = 1500;
// Fits the longest re-eval chip ("Out of Lab Range") on one line.
const RC_STATUS = 2000;
const RC_NOTE = 4260;
const RC_GRID = [RC_MARKER, RC_PRIOR, RC_CURRENT, RC_LAB, RC_OPTIMAL, RC_STATUS, RC_NOTE];

function buildComparisonTable(rows: ComparisonRow[], notes: ReadonlyMap<string, string>): Table {
  const shading = { fill: LIGHT_TEAL, type: ShadingType.CLEAR, color: "auto" };
  const head = new TableRow({
    tableHeader: true,
    children: [
      chartHeaderCell("Marker", RC_MARKER, shading),
      chartHeaderCell("Prior Panel (from prior report)", RC_PRIOR, shading),
      chartHeaderCell("Current", RC_CURRENT, shading),
      chartHeaderCell("Lab Reference Range", RC_LAB, shading),
      chartHeaderCell("Functional/Optimal Target", RC_OPTIMAL, shading),
      chartHeaderCell("Status", RC_STATUS, shading),
      chartHeaderCell("Interpretation", RC_NOTE, shading),
    ],
  });

  const body = rows.map(
    (r) =>
      new TableRow({
        cantSplit: true,
        children: [
          chartCell(shortMarkerName(r.marker), RC_MARKER, { bold: true }),
          priorCell(r.prior, RC_PRIOR),
          chartCell(r.current, RC_CURRENT, { bold: true }),
          chartCell(r.labRange, RC_LAB),
          chartCell(displayOptimalRange(r.labRange, r.optimalRange), RC_OPTIMAL),
          statusCell(
            r.status,
            r.trend,
            RC_STATUS,
            r.withinLabRange,
            r.prior === PRIOR_NOT_FOUND || r.prior === PRIOR_PENDING,
            r.direction,
          ),
          noteCell(noteFor(notes, r.marker), RC_NOTE),
        ],
      }),
  );

  return new Table({
    width: { size: LANDSCAPE_CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: RC_GRID,
    rows: [head, ...body],
  });
}

/** Trend is computed in code, so its colour is a faithful signal, not a guess. */
function trendColor(trend: string): string {
  switch (trend) {
    case "Improved":
      return TREND_GREEN;
    case "Worsened":
      return TREND_RED;
    case "Held":
      return NAVY;
    case "Stable/In Range":
      return TEAL;
    default:
      return GREY;
  }
}

/** The Prior column is the one LLM-sourced figure; render a missing one in
 *  grey italic so it cannot read as data. */
function priorCell(text: string, width: number): TableCell {
  const missing = text === PRIOR_NOT_FOUND || text === PRIOR_PENDING;
  return new TableCell({
    borders: bordersAll(),
    width: { size: width, type: WidthType.DXA },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [
      new Paragraph({
        children: [
          missing
            ? runItalic(text, GREY, 18)
            : new TextRun({ text, color: "000000", size: 20, font: "Arial" }),
        ],
      }),
    ],
  });
}

/** Deterministic lab/optimal verdict on line 1; the comparative half, which
 *  needs the prior panel, as a clearly-marked placeholder on line 2. */
function statusCell(
  status: string,
  trend: string,
  width: number,
  withinLabRange: boolean | null,
  isNew: boolean,
  direction: "high" | "low" | null,
): TableCell {
  // The re-eval status cell carries two independent signals: where the value
  // sits (the chip) and which way it moved (the trend). Shading the PARAGRAPH
  // rather than the cell keeps the chip's colour without swallowing the
  // trend's own green/red, which is the column's most-read line.
  const chip = statusChip(status, withinLabRange, direction);

  // A row whose trend only restates its chip printed the same words twice — a
  // grey "Not retested" chip with "Not retested" in italics under it. The chip
  // is the signal; the echo is noise, so the second line is dropped.
  const trendEchoesChip = !isNew && trend.trim() === chip.label;

  // With no prior value there is nothing to trend, and the computed label
  // degrades to "Unknown", which reads as a failure rather than as what it is.
  // Such a marker is new information on this draw, so it says so.
  const trendLine = isNew
    ? new Paragraph({
        alignment: AlignmentType.CENTER,
        shading: { fill: CHIP_NEW, type: ShadingType.CLEAR, color: "auto" },
        children: [
          new TextRun({
            text: "New Finding",
            bold: true,
            color: "FFFFFF",
            size: 16,
            font: "Arial",
          }),
        ],
      })
    : new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: trend,
            italics: true,
            bold: trend === "Improved" || trend === "Worsened",
            color: trendColor(trend),
            size: 16,
            font: "Arial",
          }),
        ],
      });

  return new TableCell({
    borders: bordersAll(),
    width: { size: width, type: WidthType.DXA },
    margins: { top: 80, bottom: 80, left: 80, right: 80 },
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        shading: { fill: chip.fill, type: ShadingType.CLEAR, color: "auto" },
        spacing: { after: 40 },
        children: chipRuns(chip),
      }),
      ...(trendEchoesChip ? [] : [trendLine]),
    ],
  });
}

// ----- Header block -----

function buildHeaderTable(analysis: DeterministicAnalysis): Table {
  const h = analysis.header;
  const labelWidth = HDR_LABEL;
  const valueWidth = HDR_VALUE; // CONTENT_WIDTH / 2 - labelWidth

  const row = (
    l1: string,
    v1: string,
    l2: string,
    v2: string,
  ): TableRow =>
    new TableRow({
      children: [
        headerLabelCell(l1, labelWidth),
        headerValueCell(v1, valueWidth),
        headerLabelCell(l2, labelWidth),
        headerValueCell(v2, valueWidth),
      ],
    });

  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: HEADER_GRID,
    rows: [
      row("Patient:", h.patientName, "DOB / Age:", h.dobAge),
      // Sex and hormonal status document which hormone ranges were in force.
      row("Sex:", h.sex, "Hormonal Status:", h.hormoneStatus),
      row("Specimen Collected:", h.collected, "Reported:", h.reported),
      row("Ordering Practice:", h.orderingPractice, "Prepared For:", h.preparedFor),
    ],
  });
}

/**
 * Footnote under the chart explaining what the female-hormone overlay did on
 * this panel: which hormones were judged against the practitioner's functional
 * ranges and for which status, and which were left on the lab range and why.
 * Nothing when the panel carries none of the covered hormones.
 */
function buildHormoneNotes(analysis: DeterministicAnalysis): Paragraph[] {
  const notes = analysis.hormone?.notes ?? [];
  if (!notes.length) return [];
  return [
    new Paragraph({
      spacing: { after: 60 },
      children: [runBold("Hormone ranges: ", NAVY, 18)],
    }),
    ...notes.map(
      (n, i) =>
        new Paragraph({
          spacing: { after: i === notes.length - 1 ? 200 : 60 },
          children: [runItalic(n, GREY, 18)],
        }),
    ),
  ];
}

// Draw block: label/value across the full width.
// ----- Salivary cortisol sub-section (analysis path only) -----

const CX_TIME = 2700;
const CX_RESULT = 1700;
const CX_WINDOW = 2460;
const CX_STATUS = 2500;
const CX_GRID = [CX_TIME, CX_RESULT, CX_WINDOW, CX_STATUS]; // 9360

/**
 * One row per timed saliva sample (Time | Result | Reference Window | Status)
 * with the same status chips as the marker chart, the tool's computed curve
 * facts underneath, and then the model's diurnal interpretation (or its
 * placeholder). Sits with the hormone / endocrine findings at the end of the
 * marker section. Renders a one-line note instead when a saliva report was
 * uploaded but could not be read, and nothing at all when none was uploaded.
 */
function buildSalivaCortisolSection(
  analysis: DeterministicAnalysis,
  interpretation: NarrativeBlock[] | null,
): Array<Paragraph | Table> {
  const flags = analysis.salivaCortisol;
  const note = analysis.salivaCortisolNote;
  if (!flags && !note) return [];

  const out: Array<Paragraph | Table> = [];
  out.push(groupHeading("Salivary Cortisol — 4-Point Diurnal Curve"));

  if (!flags) {
    out.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [runItalic(note ?? "", GREY, 18)],
      }),
    );
    return out;
  }

  const shading = { fill: LIGHT_TEAL, type: ShadingType.CLEAR, color: "auto" };
  const head = new TableRow({
    tableHeader: true,
    children: [
      chartHeaderCell("Sample / Time", CX_TIME, shading),
      chartHeaderCell("Result", CX_RESULT, shading),
      chartHeaderCell("Reference Window", CX_WINDOW, shading),
      chartHeaderCell("Status", CX_STATUS, shading),
    ],
  });
  const body = flags.samples.map(
    (s) =>
      new TableRow({
        cantSplit: true,
        children: [
          chartCell(
            s.drawTime ? `${s.timeLabel} — drawn ${s.drawTime}` : s.timeLabel,
            CX_TIME,
            { bold: true },
          ),
          chartCell(formatCortisolResult(s), CX_RESULT, { bold: true }),
          chartCell(s.rangeText, CX_WINDOW),
          chipCell(
            // Saliva cortisol has a reference window but no functional tier, so
            // an in-window sample reads "In Range" (green), not the blood
            // chart's "Optimal".
            s.status === "in-range"
              ? statusChip("In Range", true)
              : statusChip(cortisolStatusWord(s.status), false),
            CX_STATUS,
          ),
        ],
      }),
  );
  out.push(
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: CX_GRID,
      rows: [head, ...body],
    }),
  );

  // The computed curve facts, so the practitioner can check the narrative
  // against them.
  out.push(
    new Paragraph({
      spacing: { before: 100, after: 60 },
      children: [runBold("Curve facts (computed): ", NAVY, 18)],
    }),
    ...flags.curve.notes.map(
      (n, i) =>
        new Paragraph({
          spacing: { after: i === flags.curve.notes.length - 1 ? 160 : 40 },
          children: [runItalic(n, GREY, 18)],
        }),
    ),
  );

  if (interpretation === null) {
    out.push(
      llmPlaceholder(
        "Diurnal Cortisol Interpretation",
        "Morning peak adequacy, decline across the day, flattening / blunting and overall output, with the standard single-day-snapshot caveats.",
      ),
    );
  } else if (interpretation.length) {
    out.push(
      new Paragraph({
        spacing: { before: 120, after: 60 },
        keepNext: true,
        children: [runBold("Diurnal interpretation", NAVY, 20)],
      }),
      ...renderBlocks(interpretation),
    );
  }
  return out;
}

const DRAW_LABEL = 2200;
const DRAW_VALUE = CONTENT_WIDTH - DRAW_LABEL; // 7160
const DRAW_GRID = [DRAW_LABEL, DRAW_VALUE];

/** "Previous Draw" / "Current Draw" dates. The previous row is omitted when no
 *  prior date was supplied rather than printing an em dash that looks like a
 *  missing value the tool should have had. */
function buildDrawTable(
  analysis: DeterministicAnalysis,
  priorPanelDate: string | null,
): Table {
  const row = (label: string, value: string): TableRow =>
    new TableRow({
      cantSplit: true,
      children: [
        headerLabelCell(label, DRAW_LABEL),
        headerValueCell(value, DRAW_VALUE),
      ],
    });

  const prior = formatDrawDate(priorPanelDate);
  const rows: TableRow[] = [];
  if (prior) rows.push(row("Previous Draw:", prior));
  rows.push(row("Current Draw:", analysis.header.collected || "—"));

  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: DRAW_GRID,
    rows,
  });
}

/** "YYYY-MM-DD" (what the form collects) -> "MM/DD/YYYY" (what the rest of the
 *  document prints). Anything else passes through unchanged. */
function formatDrawDate(raw: string | null): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return iso ? `${iso[2]}/${iso[3]}/${iso[1]}` : s;
}

function headerLabelCell(text: string, width: number): TableCell {
  return new TableCell({
    borders: bordersAll(),
    width: { size: width, type: WidthType.DXA },
    shading: { fill: LIGHT_TEAL, type: ShadingType.CLEAR, color: "auto" },
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
    children: [new Paragraph({ children: [runBold(text)] })],
  });
}

function headerValueCell(text: string, width: number): TableCell {
  return new TableCell({
    borders: bordersAll(),
    width: { size: width, type: WidthType.DXA },
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
    children: [new Paragraph({ children: [runPlain(text)] })],
  });
}

// ----- Marker / range / status presentation -----

/**
 * Short common name for the table's Marker column.
 *
 * The dictionary's canonicalName carries the doctor's full wording, including
 * the parenthetical expansion — "MCV (Mean Corpuscular Volume)". That is right
 * for prose and far too wide for a five-column table, so the table prints the
 * short form and drops a TRAILING expansion only.
 *
 * Guarded so the paren is not part of the name itself: "Lipoprotein (a)" keeps
 * its "(a)" (a one-character body is a qualifier, not an expansion), and
 * "Vitamin D 1,25 (OH)2 Total" is untouched because its paren is not trailing.
 */
export function shortMarkerName(canonicalName: string): string {
  const m = canonicalName.trim().match(/^(.*\S)\s*\(([^()]*)\)$/);
  if (!m) return canonicalName.trim();
  const [, prefix, inner] = m;
  if (prefix.length < 2 || inner.trim().length < 2) return canonicalName.trim();
  return prefix;
}

/**
 * Functional/Optimal cell. A `lab_range_only` marker has no target of its own,
 * so deterministic.ts echoes the lab range with a "(lab range)" suffix. Echoing
 * the neighbouring column adds nothing and reads as a second, conflicting
 * target, so the table prints an em dash instead.
 */
export function displayOptimalRange(labRange: string, optimalRange: string): string {
  const optimal = (optimalRange ?? "").trim();
  if (!optimal || optimal === "—") return "—";
  if (/\(lab range\)$/i.test(optimal)) return "—";

  const shown = compactBands(optimal) ?? optimal;
  // Compared AFTER compaction: a three-tier marker whose optimal band is just
  // the lab cutoff restated ("> 6729" vs "≥ 6729") only reads as a second,
  // conflicting target.
  if (sameThreshold(shown, labRange ?? "")) return "—";
  return shown;
}

/** Range equality for display purposes: ignores spacing and treats the strict
 *  and inclusive forms of a bound as the same threshold, which is all the
 *  distinction amounts to when one side is a lab cutoff and the other is the
 *  band edge derived from it. */
function sameThreshold(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/\s+/g, "")
      .replace(/[≥⩾]/g, ">")
      .replace(/[≤⩽]/g, "<")
      .replace(/[–—−]/g, "-");
  const na = norm(a);
  const nb = norm(b);
  return na !== "" && na === nb;
}

/**
 * Three-tier markers arrive as every band spelled out —
 * "Optimal: [-inf, 215)  |  Moderate: [215, 301)  |  High: [301, +inf)" — which
 * runs to four wrapped lines and drags the whole row's height with it.
 *
 * A column headed "Functional / Optimal Range" only needs the target band, and
 * which tier the value actually landed in is already the Status chip's job, so
 * the target is rendered in the same compact notation every other row uses.
 * Anything that does not parse falls back to the full string rather than
 * inventing a range. Returns null when there is nothing to compact.
 */
function compactBands(optimal: string): string | null {
  if (!optimal.includes(":") || !optimal.includes("[")) return null;
  const segments = optimal.split("|").map((s) => s.trim());
  // "Optimal" for the clinical tiers, "Negative" for the serology tiers.
  const target = segments.find((s) => /^(Optimal|Negative)\s*:/i.test(s));
  if (!target) return null;

  const m = target.match(/:\s*\[\s*([^,\]]+)\s*,\s*([^)\]]+)\s*[)\]]/);
  if (!m) return null;
  const isNegInf = (v: string) => /^[-−]\s*∞$/.test(v.trim());
  const isPosInf = (v: string) => /^\+?\s*∞$/.test(v.trim());
  const lo = m[1].trim();
  const hi = m[2].trim();

  if (isNegInf(lo) && isPosInf(hi)) return null;
  if (isNegInf(lo)) return `< ${hi}`;
  if (isPosInf(hi)) return `≥ ${lo}`;
  return `${lo}–${hi}`;
}

export interface StatusChip {
  /** First line: where the value sits. Never wraps at the sized column width. */
  label: string;
  /** Second line: "(High)" / "(Low)", or "" when the status carries no
   *  direction. Rendered as its own line so the chip never wraps mid-word. */
  direction: string;
  fill: string;
}

/** FlaggedMarker.flagDirection -> chip line. The re-eval vocabulary carries no
 *  direction in its wording, so the comparison row hands the engine's verdict
 *  through instead. */
function directionLabel(direction: "high" | "low" | null | undefined): string {
  if (direction === "high") return "(High)";
  if (direction === "low") return "(Low)";
  return "";
}

/** Direction is read off the deterministic status wording, never re-derived
 *  from the value. Returns "" when that wording carries none. */
function directionFrom(key: string): string {
  if (/\bHIGH\b/.test(key) || key === "ABOVE OPTIMAL") return "(High)";
  if (/\bLOW\b/.test(key) || key === "SUBOPTIMAL" || key === "BELOW OPTIMAL") {
    return "(Low)";
  }
  return "";
}

/**
 * Deterministic status string -> chip. The wording comes from
 * deterministic.ts's formatStatus / comparisonStatus and is never re-derived
 * here: this maps it to a short label that cannot wrap, plus the fill colour.
 *
 * Red  = outside the standard lab range.
 * Amber = inside the lab range but outside the functional optimal range; these
 *         keep the asterisk the legend and the footer disclaimer explain.
 */
export function statusChip(
  status: string,
  withinLabRange: boolean | null,
  /** The engine's flagDirection, supplied by the re-eval comparison rows whose
   *  status wording carries none. Ignored when the wording already says. */
  flagDirection?: "high" | "low" | null,
): StatusChip {
  const raw = (status ?? "").trim();
  const key = raw.replace(/\*+$/, "").trim().toUpperCase();
  const carried = directionLabel(flagDirection);

  // Re-eval vocabulary: the verdict is in the wording, the direction is not.
  if (key === "IN RANGE") {
    return { label: "In Range", direction: "", fill: CHIP_IN_RANGE };
  }
  if (key === "NOT RETESTED") {
    return { label: "Not retested", direction: "", fill: CHIP_NEUTRAL };
  }
  if (key === "NEW FINDING") {
    return { label: "New Finding", direction: "", fill: CHIP_NEW };
  }
  if (key === "OUT OF LAB RANGE") {
    return { label: "Out of Lab Range", direction: carried, fill: CHIP_LAB };
  }
  if (key === "OUT OF OPTIMAL") {
    return { label: "Out of Optimal", direction: carried, fill: CHIP_OPTIMAL };
  }

  // Initial-mode vocabulary. Inside the lab range => amber; the direction the
  // engine flagged becomes the chip's second line.
  const outsideLab = withinLabRange !== true;
  const fill = outsideLab ? CHIP_LAB : CHIP_OPTIMAL;
  const label = outsideLab ? "Out of Lab Range" : "Out of Optimal";
  const direction = directionFrom(key) || carried;

  switch (key) {
    case "HIGH":
    case "LOW":
    case "ABOVE OPTIMAL":
    case "SUBOPTIMAL":
    case "BELOW OPTIMAL":
    case "BORDERLINE HIGH":
    case "BORDERLINE LOW":
    case "BORDERLINE":
    case "MODERATE":
    case "OUT OF RANGE":
      return { label, direction, fill };
    case "OPTIMAL":
      // The green tier's own rows: inside both ranges.
      return { label: "Optimal", direction: "", fill: CHIP_IN_RANGE };
    default: {
      // Unknown vocabulary still prints, in Title Case, rather than vanishing.
      const fallback = raw
        ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
        : "—";
      return { label: fallback, direction: "", fill };
    }
  }
}

/** The chip itself: a filled cell with bold white centred text. */
function chipCell(chip: StatusChip, width: number): TableCell {
  return new TableCell({
    borders: bordersAll(),
    width: { size: width, type: WidthType.DXA },
    shading: { fill: chip.fill, type: ShadingType.CLEAR, color: "auto" },
    margins: { top: 80, bottom: 80, left: 80, right: 80 },
    children: [chipParagraph(chip)],
  });
}

function chipRuns(chip: StatusChip): TextRun[] {
  const runs = [
    new TextRun({
      text: chip.label,
      bold: true,
      color: "FFFFFF",
      size: 18,
      font: "Arial",
    }),
  ];
  // An explicit break, not a wrap: the direction always starts its own line and
  // the label above it never splits mid-word.
  if (chip.direction) {
    runs.push(
      new TextRun({
        text: chip.direction,
        bold: true,
        color: "FFFFFF",
        size: 16,
        font: "Arial",
        break: 1,
      }),
    );
  }
  return runs;
}

function chipParagraph(chip: StatusChip): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: chipRuns(chip),
  });
}

// ----- Section 2 chart -----

/**
 * The note for a chart row. Joined by the marker name the model copied from
 * the payload, which is the canonical name; a case-insensitive match and the
 * chart's short display name are accepted as fallbacks so a harmless
 * respelling does not blank the cell. "" when there is no note.
 */
export function noteFor(notes: ReadonlyMap<string, string>, marker: string): string {
  const exact = notes.get(marker);
  if (exact) return exact;
  const want = marker.trim().toLowerCase();
  const short = shortMarkerName(marker).toLowerCase();
  for (const [name, note] of notes) {
    const have = name.trim().toLowerCase();
    if (have === want || have === short) return note;
  }
  return "";
}

/** Interpretation cell: plain text, blank when there is no note. */
function noteCell(text: string, width: number): TableCell {
  return new TableCell({
    borders: bordersAll(),
    width: { size: width, type: WidthType.DXA },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [
      new Paragraph({
        children: text
          ? [new TextRun({ text, color: "000000", size: 18, font: "Arial" })]
          : [],
      }),
    ],
  });
}

function buildChartTable(rows: ChartRow[], notes: ReadonlyMap<string, string>): Table {
  const shading = { fill: LIGHT_TEAL, type: ShadingType.CLEAR, color: "auto" };
  const head = new TableRow({
    tableHeader: true,
    children: [
      chartHeaderCell("Marker", LC_MARKER, shading),
      chartHeaderCell("Result", LC_RESULT, shading),
      chartHeaderCell("Lab Reference Range", LC_LAB, shading),
      chartHeaderCell("Functional/Optimal Target", LC_OPTIMAL, shading),
      chartHeaderCell("Status", LC_STATUS, shading),
      chartHeaderCell("Interpretation", LC_NOTE, shading),
    ],
  });

  const body = rows.map(
    (r) =>
      new TableRow({
        // A row that splits across a page break leaves a headless remnant at
        // the top of the next page; keeping it whole is far more readable.
        cantSplit: true,
        children: [
          chartCell(shortMarkerName(r.marker), LC_MARKER, { bold: true }),
          chartCell(r.result, LC_RESULT, { bold: true }),
          chartCell(r.labRange, LC_LAB),
          chartCell(displayOptimalRange(r.labRange, r.optimalRange), LC_OPTIMAL),
          chipCell(statusChip(r.status, r.withinLabRange), LC_STATUS),
          noteCell(noteFor(notes, r.marker), LC_NOTE),
        ],
      }),
  );

  return new Table({
    width: { size: LANDSCAPE_CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: LANDSCAPE_CHART_GRID,
    rows: [head, ...body],
  });
}

/**
 * The green tier, condensed: one table for every in-range marker, with a
 * shaded body-system label row between groups instead of a table per system.
 * Smaller type and tighter rows than the flagged tables — these markers need
 * no interpretation yet, so they take less room. Same five columns and grid.
 */
function buildOptimalTable(groups: Array<BodySystemGroup<ChartRow>>): Table {
  const shading = { fill: LIGHT_TEAL, type: ShadingType.CLEAR, color: "auto" };
  const head = new TableRow({
    tableHeader: true,
    children: [
      chartHeaderCell("Marker", LO_MARKER, shading),
      chartHeaderCell("Result", LO_RESULT, shading),
      chartHeaderCell("Lab Reference Range", LO_LAB, shading),
      chartHeaderCell("Functional/Optimal Target", LO_OPTIMAL, shading),
      chartHeaderCell("Status", LO_STATUS, shading),
    ],
  });

  const rows: TableRow[] = [head];
  for (const group of groups) {
    rows.push(
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            columnSpan: LANDSCAPE_OPTIMAL_GRID.length,
            borders: bordersAll(),
            width: { size: LANDSCAPE_CONTENT_WIDTH, type: WidthType.DXA },
            shading: { fill: "F2F2F2", type: ShadingType.CLEAR, color: "auto" },
            margins: { top: 40, bottom: 40, left: 120, right: 120 },
            children: [
              new Paragraph({
                keepNext: true,
                children: [
                  new TextRun({ text: group.system, bold: true, color: TEAL, size: 18, font: "Arial" }),
                ],
              }),
            ],
          }),
        ],
      }),
    );
    for (const r of group.items) {
      rows.push(
        new TableRow({
          cantSplit: true,
          children: [
            condensedCell(shortMarkerName(r.marker), LO_MARKER, { bold: true }),
            condensedCell(r.result, LO_RESULT),
            condensedCell(r.labRange, LO_LAB),
            condensedCell(displayOptimalRange(r.labRange, r.optimalRange), LO_OPTIMAL),
            condensedChipCell(statusChip(r.status, r.withinLabRange), LO_STATUS),
          ],
        }),
      );
    }
  }

  return new Table({
    width: { size: LANDSCAPE_CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: LANDSCAPE_OPTIMAL_GRID,
    rows,
  });
}

function condensedCell(
  text: string,
  width: number,
  opts: { bold?: boolean } = {},
): TableCell {
  return new TableCell({
    borders: bordersAll(),
    width: { size: width, type: WidthType.DXA },
    margins: { top: 40, bottom: 40, left: 120, right: 120 },
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text,
            bold: opts.bold ?? false,
            color: "000000",
            size: 18,
            font: "Arial",
          }),
        ],
      }),
    ],
  });
}

/** Chip cell at the condensed row height. */
function condensedChipCell(chip: StatusChip, width: number): TableCell {
  return new TableCell({
    borders: bordersAll(),
    width: { size: width, type: WidthType.DXA },
    shading: { fill: chip.fill, type: ShadingType.CLEAR, color: "auto" },
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: chip.label, bold: true, color: "FFFFFF", size: 16, font: "Arial" }),
        ],
      }),
    ],
  });
}

function chartHeaderCell(
  text: string,
  width: number,
  shading: { fill: string; type: typeof ShadingType.CLEAR; color: string },
): TableCell {
  return new TableCell({
    borders: bordersAll(),
    width: { size: width, type: WidthType.DXA },
    shading,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({ children: [runBold(text)] })],
  });
}

function chartCell(
  text: string,
  width: number,
  opts: { bold?: boolean; color?: string } = {},
): TableCell {
  return new TableCell({
    borders: bordersAll(),
    width: { size: width, type: WidthType.DXA },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text,
            bold: opts.bold ?? false,
            color: opts.color ?? "000000",
            size: 20,
            font: "Arial",
          }),
        ],
      }),
    ],
  });
}

// ----- Narrative rendering -----

/** Model prose -> paragraphs. Headings become sub-headings, "Goal:" lines get
 *  their own italic label line, bullets get a bullet glyph and a hanging
 *  indent. Text is inserted verbatim: the model authors no numbers of its own,
 *  and nothing here reformats what it wrote. */
function renderBlocks(blocks: NarrativeBlock[]): Paragraph[] {
  return blocks.map((b) => {
    switch (b.type) {
      case "heading":
        return new Paragraph({
          spacing: { before: 200, after: 100 },
          children: [
            new TextRun({
              text: b.text,
              bold: true,
              color: TEAL,
              size: 22,
              font: "Arial",
            }),
          ],
        });
      case "goal":
        return new Paragraph({
          spacing: { after: 100 },
          indent: { left: 240 },
          children: [
            new TextRun({
              text: "Goal: ",
              bold: true,
              italics: true,
              color: NAVY,
              size: 20,
              font: "Arial",
            }),
            new TextRun({
              text: b.text,
              italics: true,
              color: NAVY,
              size: 20,
              font: "Arial",
            }),
          ],
        });
      case "bullet": {
        // Re-eval protocol bullets lead with an adjustment tag (CONTINUE:,
        // TAPER:, NEW:, ...). Bold it so the change against the prior plan is
        // scannable, exactly what the sample doc's "Adjustment Note" column does.
        const tag = b.text.match(
          /^(CONTINUE|TAPER|INTENSIFY|NEW|RE-START|RESTART|STOP|MONITOR|ADD):\s*/,
        );
        const children = tag
          ? [
              runPlain("•  ", "000000", 20),
              new TextRun({
                text: tag[0].trim() + " ",
                bold: true,
                color: NAVY,
                size: 20,
                font: "Arial",
              }),
              runPlain(b.text.slice(tag[0].length), "000000", 20),
            ]
          : [runPlain("•  ", "000000", 20), runPlain(b.text, "000000", 20)];
        return new Paragraph({
          spacing: { after: 60 },
          indent: { left: 460, hanging: 220 },
          children,
        });
      }
      case "subhead":
        return new Paragraph({
          spacing: { before: 180, after: 60 },
          keepNext: true,
          children: [
            new TextRun({
              text: b.text,
              bold: true,
              color: NAVY,
              size: 20,
              font: "Arial",
            }),
          ],
        });
      case "relevance":
        // "Relevance to <chief concern>: ..." — the label half is bolded so the
        // practitioner can scan straight to it under each pattern.
        {
          const split = b.text.indexOf(":");
          const label = split > 0 ? b.text.slice(0, split + 1) : b.text;
          const rest = split > 0 ? b.text.slice(split + 1) : "";
          return new Paragraph({
            spacing: { before: 60, after: 160 },
            indent: { left: 460 },
            children: [
              new TextRun({
                text: label,
                bold: true,
                italics: true,
                color: NAVY,
                size: 19,
                font: "Arial",
              }),
              new TextRun({
                text: rest,
                italics: true,
                color: "000000",
                size: 19,
                font: "Arial",
              }),
            ],
          });
        }
      case "leadBullet": {
        // Bold everything up to the first colon: the marker name leads, the
        // reasoning follows.
        const split = b.text.indexOf(":");
        const lead = split > 0 ? b.text.slice(0, split + 1) : "";
        const rest = split > 0 ? b.text.slice(split + 1) : b.text;
        return new Paragraph({
          spacing: { after: 60 },
          indent: { left: 460, hanging: 220 },
          children: [
            runPlain("\u2022  ", "000000", 20),
            ...(lead
              ? [
                  new TextRun({
                    text: lead,
                    bold: true,
                    color: NAVY,
                    size: 20,
                    font: "Arial",
                  }),
                ]
              : []),
            runPlain(rest, "000000", 20),
          ],
        });
      }
      case "symptomTags":
        // Patient-reported symptoms this pattern may explain. Reasoning, not
        // data — set apart from the bullets so it never reads as a lab finding.
        return new Paragraph({
          spacing: { before: 60, after: 160 },
          indent: { left: 460 },
          children: [
            new TextRun({
              text: SYMPTOM_TAG_LABEL,
              bold: true,
              italics: true,
              color: TEAL,
              size: 18,
              font: "Arial",
            }),
            new TextRun({
              text: b.text,
              italics: true,
              color: GREY,
              size: 18,
              font: "Arial",
            }),
          ],
        });
      default:
        return new Paragraph({
          spacing: { after: 140 },
          children: [runPlain(b.text, "000000", 20)],
        });
    }
  });
}

// ----- Placeholders for the LLM sections -----

function llmPlaceholder(sectionName: string, note: string): Paragraph {
  return new Paragraph({
    spacing: { after: 240 },
    border: {
      left: { style: BorderStyle.SINGLE, size: 12, color: TEAL, space: 8 },
    },
    children: [
      new TextRun({
        text: `[ ${sectionName} — generated narrative goes here. ]`,
        bold: true,
        italics: true,
        color: TEAL,
        size: 20,
        font: "Arial",
      }),
      new TextRun({ text: "  ", size: 20, font: "Arial" }),
      new TextRun({
        text: note,
        italics: true,
        color: GREY,
        size: 18,
        font: "Arial",
      }),
    ],
  });
}

// ----- Primitives -----

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 280, after: 140 },
    children: [
      new TextRun({ text, bold: true, color: NAVY, size: 26, font: "Arial" }),
    ],
  });
}

function bordersAll() {
  const b = { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GREY };
  return { top: b, bottom: b, left: b, right: b };
}

function runPlain(text: string, color = "000000", size = 22): TextRun {
  return new TextRun({ text, color, size, font: "Arial" });
}

function runBold(text: string, color = NAVY, size = 22): TextRun {
  return new TextRun({ text, bold: true, color, size, font: "Arial" });
}

function runItalic(text: string, color = GREY, size = 20): TextRun {
  return new TextRun({ text, italics: true, color, size, font: "Arial" });
}

function blank(): Paragraph {
  return new Paragraph({ children: [] });
}
