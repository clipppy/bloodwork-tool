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
 *   2. Markers Outside Standard Lab Range... <- DETERMINISTIC (this file)
 *   3. Root Cause Analysis by Marker/Pattern <- LLM (Phase 1b)
 *   4. Phased Functional Medicine Protocol   <- LLM (Phase 1b)
 *   5. Summary of Findings - In Plain Language <- LLM (Phase 1b)
 *   Footer note
 *
 * The four LLM sections currently render labelled placeholders. Every number in
 * section 2 comes from lib/analysis/deterministic.ts, never from a model.
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
} from "docx";
import {
  DISCLAIMER,
  PRIOR_NOT_FOUND,
  PRIOR_PENDING,
  type ChartRow,
  type ComparisonRow,
  type DeterministicAnalysis,
} from "../analysis/deterministic";
import { groupBySystem } from "../analysis/body-systems";
import {
  SYMPTOM_TAG_LABEL,
  type AnalysisNarrative,
  type NarrativeBlock,
  type ReevalNarrative,
} from "../analysis/prompt";

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
const CHIP_IN_RANGE = "2E7D32"; // re-eval only: back inside both ranges
const CHIP_NEUTRAL = "6E6E6E"; // re-eval only: not retested / nothing to compare

const PAGE_WIDTH = 12240;
const PAGE_HEIGHT = 15840;
const PAGE_MARGIN = 1440;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2; // 9360

// Chart column widths, summing to CONTENT_WIDTH.
//
// These same numbers go into the table's `columnWidths` as well as each cell's
// `width`. Without columnWidths the docx writer emits a tblGrid of 100-twip
// columns; Word happens to re-fit from the cell widths, but every other
// renderer (Pages, LibreOffice, Google Docs, most PDF converters) honours the
// grid and squeezes the table into an unreadable mess. The grid is the fix.
const COL_MARKER = 2000;
const COL_RESULT = 2060;
const COL_LAB = 1700;
const COL_OPTIMAL = 1800;
// Wide enough for the longest chip label ("Above Optimal*") on one line.
const COL_STATUS = 1800;
const CHART_GRID = [COL_MARKER, COL_RESULT, COL_LAB, COL_OPTIMAL, COL_STATUS];

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
): Promise<Buffer> {
  return Packer.toBuffer(
    buildReevalDocument(analysis, priorReportIngested, narrative ?? null),
  );
}

// ----- Document assembly -----

function buildDocument(
  analysis: DeterministicAnalysis,
  narrative: AnalysisNarrative | null,
): Document {
  const children: Array<Paragraph | Table> = [];

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

  // 2. Markers chart — DETERMINISTIC
  children.push(
    sectionHeading(
      "2. Markers Outside Standard Lab Range and/or Functional Optimal Range",
    ),
  );
  if (analysis.rows.length === 0) {
    children.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [
          runPlain(
            "No markers fell outside the standard laboratory range or the functional optimal range on this panel.",
          ),
        ],
      }),
    );
  } else {
    children.push(buildChartLegend());
    // One table per body system, in taxonomy order. Row content is untouched —
    // only the headings and the split points are new.
    for (const group of groupBySystem(analysis.rows, (r) => r.marker)) {
      children.push(groupHeading(group.system));
      children.push(buildChartTable(group.items));
      children.push(blank());
    }
  }
  // Narrative reading of the in-range markers (LLM), after the code-built list.
  if (narrative) children.push(...renderBlocks(narrative.reassuring));
  children.push(...buildReassuringParagraphs(analysis));

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
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            margin: {
              top: PAGE_MARGIN,
              right: PAGE_MARGIN,
              bottom: PAGE_MARGIN,
              left: PAGE_MARGIN,
            },
          },
        },
        children,
      },
    ],
  });
}

// ----- Re-evaluation document -----

function buildReevalDocument(
  analysis: DeterministicAnalysis,
  priorReportIngested: boolean,
  narrative: ReevalNarrative | null,
): Document {
  const children: Array<Paragraph | Table> = [];
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
      ],
    }),
    new Paragraph({
      spacing: { after: 200 },
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

  // Part II — comparison chart (deterministic current side)
  children.push(sectionHeading("Part II: Marker Comparison — Out of Range Findings"));
  children.push(buildLegend());

  if (analysis.comparisonGroups.length === 0) {
    children.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [
          runPlain(
            "No markers on the current panel fell outside the standard laboratory range or the functional optimal range.",
          ),
        ],
      }),
    );
  } else {
    // Re-grouped from the deterministic category buckets into the body-system
    // taxonomy so both modes read the same way. Rows themselves are unchanged;
    // alphabetical order inside a heading matches the previous per-category
    // tables and keeps two runs over one panel byte-identical.
    const comparisonRows = analysis.comparisonGroups.flatMap((g) => g.rows);
    for (const group of groupBySystem(comparisonRows, (r) => r.marker)) {
      children.push(groupHeading(group.system));
      children.push(
        buildComparisonTable(
          group.items.slice().sort((a, b) => a.marker.localeCompare(b.marker)),
        ),
      );
      children.push(blank());
    }
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
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            margin: {
              top: PAGE_MARGIN,
              right: PAGE_MARGIN,
              bottom: PAGE_MARGIN,
              left: PAGE_MARGIN,
            },
          },
        },
        children,
      },
    ],
  });
}

/** The sample's colour key, above the comparison tables. */
function buildLegend(): Paragraph {
  return new Paragraph({
    spacing: { after: 160 },
    keepNext: true,
    children: [
      runBold("Legend:  "),
      new TextRun({
        text: "  Out of Lab Range  ",
        bold: true,
        color: "FFFFFF",
        size: 18,
        font: "Arial",
        shading: { fill: CHIP_LAB, type: ShadingType.CLEAR, color: "auto" },
      }),
      runPlain("   "),
      new TextRun({
        text: "  Out of Functional Optimal Range  ",
        bold: true,
        color: "FFFFFF",
        size: 18,
        font: "Arial",
        shading: { fill: CHIP_OPTIMAL, type: ShadingType.CLEAR, color: "auto" },
      }),
      runPlain("   "),
      new TextRun({
        text: "  Improved Since Last Panel  ",
        bold: true,
        color: GREY,
        size: 18,
        font: "Arial",
        shading: { fill: LIGHT_GREY, type: ShadingType.CLEAR, color: "auto" },
      }),
    ],
  });
}

/** Body-system heading. keepNext binds it to the table that follows so a
 *  heading can never strand alone at the foot of a page. */
function groupHeading(label: string): Paragraph {
  return new Paragraph({
    spacing: { before: 240, after: 100 },
    keepNext: true,
    children: [
      new TextRun({ text: label, bold: true, color: NAVY, size: 22, font: "Arial" }),
    ],
  });
}

// Comparison columns sum to CONTENT_WIDTH (9360). Same rule as CHART_GRID:
// whatever is here must also be emitted as the table's columnWidths.
const RC_MARKER = 1800;
const RC_PRIOR = 1420;
const RC_CURRENT = 1420;
const RC_LAB = 1410;
const RC_OPTIMAL = 1410;
// Fits the longest re-eval chip ("Out of Optimal*") on one line.
const RC_STATUS = 1900;
const RC_GRID = [RC_MARKER, RC_PRIOR, RC_CURRENT, RC_LAB, RC_OPTIMAL, RC_STATUS];

function buildComparisonTable(rows: ComparisonRow[]): Table {
  const shading = { fill: LIGHT_TEAL, type: ShadingType.CLEAR, color: "auto" };
  const head = new TableRow({
    tableHeader: true,
    children: [
      chartHeaderCell("Marker", RC_MARKER, shading),
      chartHeaderCell("Prior Panel (from prior report)", RC_PRIOR, shading),
      chartHeaderCell("Current", RC_CURRENT, shading),
      chartHeaderCell("Lab Range", RC_LAB, shading),
      chartHeaderCell("Functional Optimal", RC_OPTIMAL, shading),
      chartHeaderCell("Status", RC_STATUS, shading),
    ],
  });

  const body = rows.map(
    (r) =>
      new TableRow({
        cantSplit: true,
        children: [
          chartCell(shortMarkerName(r.marker), RC_MARKER, { bold: true }),
          priorCell(r.prior, RC_PRIOR),
          chartCell(r.current, RC_CURRENT),
          chartCell(r.labRange, RC_LAB),
          chartCell(displayOptimalRange(r.labRange, r.optimalRange), RC_OPTIMAL),
          statusCell(r.status, r.trend, RC_STATUS, r.withinLabRange),
        ],
      }),
  );

  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
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
): TableCell {
  // The re-eval status cell carries two independent signals: where the value
  // sits (the chip) and which way it moved (the trend). Shading the PARAGRAPH
  // rather than the cell keeps the chip's colour without swallowing the
  // trend's own green/red, which is the column's most-read line.
  const chip = statusChip(status, withinLabRange);
  return new TableCell({
    borders: bordersAll(),
    width: { size: width, type: WidthType.DXA },
    margins: { top: 80, bottom: 80, left: 80, right: 80 },
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        shading: { fill: chip.fill, type: ShadingType.CLEAR, color: "auto" },
        spacing: { after: 40 },
        children: [
          new TextRun({
            text: chip.label,
            bold: true,
            color: "FFFFFF",
            size: 18,
            font: "Arial",
          }),
        ],
      }),
      new Paragraph({
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
      }),
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
      row("Specimen Collected:", h.collected, "Reported:", h.reported),
      row("Ordering Practice:", h.orderingPractice, "Prepared For:", h.preparedFor),
    ],
  });
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
  label: string;
  fill: string;
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
export function statusChip(status: string, withinLabRange: boolean | null): StatusChip {
  const raw = (status ?? "").trim();
  const starred = raw.endsWith("*");
  const key = raw.replace(/\*+$/, "").trim().toUpperCase();

  // Re-eval vocabulary.
  if (key === "IN RANGE") return { label: "In Range", fill: CHIP_IN_RANGE };
  if (key === "NOT RETESTED") return { label: "Not retested", fill: CHIP_NEUTRAL };
  if (key === "OUT OF LAB RANGE") return { label: "Out of Range", fill: CHIP_LAB };
  if (key === "OUT OF OPTIMAL") return { label: "Out of Optimal*", fill: CHIP_OPTIMAL };

  // Inside the lab range => amber, and the asterisk stays on the label.
  const fill = withinLabRange === true ? CHIP_OPTIMAL : CHIP_LAB;
  const star = starred ? "*" : "";

  switch (key) {
    case "HIGH":
      return { label: `High${star}`, fill };
    case "LOW":
      return { label: `Low${star}`, fill };
    case "ABOVE OPTIMAL":
      return { label: `Above Optimal${star}`, fill };
    case "SUBOPTIMAL":
    case "BELOW OPTIMAL":
      return { label: `Below Optimal${star}`, fill };
    case "BORDERLINE HIGH":
    case "BORDERLINE LOW":
    case "BORDERLINE":
      return { label: `Borderline${star}`, fill };
    case "MODERATE":
      return { label: `Moderate${star}`, fill };
    case "OUT OF RANGE":
      return { label: `Out of Range${star}`, fill };
    case "OPTIMAL":
      return { label: "Optimal", fill: CHIP_IN_RANGE };
    default: {
      // Unknown vocabulary still prints, in Title Case, rather than vanishing.
      const label = raw
        ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
        : "—";
      return { label, fill };
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

function chipParagraph(chip: StatusChip): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({
        text: chip.label,
        bold: true,
        color: "FFFFFF",
        size: 18,
        font: "Arial",
      }),
    ],
  });
}

/** Colour key for the status chips, printed under the section 2 heading. */
function buildChartLegend(): Paragraph {
  return new Paragraph({
    spacing: { after: 160 },
    keepNext: true,
    children: [
      runBold("Status key:  "),
      new TextRun({
        text: "  Outside standard lab range  ",
        bold: true,
        color: "FFFFFF",
        size: 18,
        font: "Arial",
        shading: { fill: CHIP_LAB, type: ShadingType.CLEAR, color: "auto" },
      }),
      runPlain("   "),
      new TextRun({
        text: "  Outside functional optimal range only  ",
        bold: true,
        color: "FFFFFF",
        size: 18,
        font: "Arial",
        shading: { fill: CHIP_OPTIMAL, type: ShadingType.CLEAR, color: "auto" },
      }),
      runItalic(
        "     * marks a value inside the standard lab range but outside the functional target.",
        GREY,
        18,
      ),
    ],
  });
}

// ----- Section 2 chart -----

function buildChartTable(rows: ChartRow[]): Table {
  const shading = { fill: LIGHT_TEAL, type: ShadingType.CLEAR, color: "auto" };
  const head = new TableRow({
    tableHeader: true,
    children: [
      chartHeaderCell("Marker", COL_MARKER, shading),
      chartHeaderCell("Result", COL_RESULT, shading),
      chartHeaderCell("Standard Lab Range", COL_LAB, shading),
      chartHeaderCell("Functional / Optimal Range", COL_OPTIMAL, shading),
      chartHeaderCell("Status", COL_STATUS, shading),
    ],
  });

  const body = rows.map(
    (r) =>
      new TableRow({
        // A row that splits across a page break leaves a headless remnant at
        // the top of the next page; keeping it whole is far more readable.
        cantSplit: true,
        children: [
          chartCell(shortMarkerName(r.marker), COL_MARKER, { bold: true }),
          chartCell(r.result, COL_RESULT),
          chartCell(r.labRange, COL_LAB),
          chartCell(displayOptimalRange(r.labRange, r.optimalRange), COL_OPTIMAL),
          chipCell(statusChip(r.status, r.withinLabRange), COL_STATUS),
        ],
      }),
  );

  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: CHART_GRID,
    rows: [head, ...body],
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

function buildReassuringParagraphs(analysis: DeterministicAnalysis): Paragraph[] {
  const { notable, other, totalCount } = analysis.reassuring;
  if (totalCount === 0) {
    return [
      new Paragraph({
        spacing: { after: 200 },
        children: [
          runItalic(
            "No markers on this panel fell within both the standard and functional optimal ranges.",
          ),
        ],
      }),
    ];
  }

  const out: Paragraph[] = [];
  if (notable.length) {
    out.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [
          runBold("Reassuring markers within both standard and functional optimal ranges: "),
          runPlain(`${notable.join("; ")}.`),
        ],
      }),
    );
  }
  if (other.length) {
    out.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [
          runItalic(`All other markers within range (${other.length}): `),
          new TextRun({
            text: `${other.join("; ")}.`,
            color: GREY,
            size: 18,
            font: "Arial",
          }),
        ],
      }),
    );
  }
  return out;
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
