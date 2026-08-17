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
  type ComparisonGroup,
  type DeterministicAnalysis,
} from "../analysis/deterministic";
import type {
  AnalysisNarrative,
  NarrativeBlock,
  ReevalNarrative,
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

const PAGE_WIDTH = 12240;
const PAGE_HEIGHT = 15840;
const PAGE_MARGIN = 1440;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2; // 9360

// Chart column widths, summing to CONTENT_WIDTH.
const COL_MARKER = 2100;
const COL_RESULT = 1700;
const COL_LAB = 1800;
const COL_OPTIMAL = 2260;
const COL_STATUS = 1500;

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
    children.push(buildChartTable(analysis.rows));
    children.push(blank());
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
    for (const group of analysis.comparisonGroups) {
      children.push(groupHeading(group.label));
      children.push(buildComparisonTable(group));
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
    children: [
      runBold("Legend:  "),
      new TextRun({
        text: "  Out of Lab Range  ",
        bold: true,
        color: "FFFFFF",
        size: 18,
        font: "Arial",
        shading: { fill: NAVY, type: ShadingType.CLEAR, color: "auto" },
      }),
      runPlain("   "),
      new TextRun({
        text: "  Out of Functional Optimal Range  ",
        bold: true,
        color: "FFFFFF",
        size: 18,
        font: "Arial",
        shading: { fill: TEAL, type: ShadingType.CLEAR, color: "auto" },
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

function groupHeading(label: string): Paragraph {
  return new Paragraph({
    spacing: { before: 240, after: 100 },
    children: [
      new TextRun({ text: label, bold: true, color: NAVY, size: 22, font: "Arial" }),
    ],
  });
}

// Comparison columns sum to CONTENT_WIDTH (9360).
const RC_MARKER = 2000;
const RC_PRIOR = 1400;
const RC_CURRENT = 1600;
const RC_LAB = 1400;
const RC_OPTIMAL = 1600;
const RC_STATUS = 1360;

function buildComparisonTable(group: ComparisonGroup): Table {
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

  const body = group.rows.map(
    (r) =>
      new TableRow({
        children: [
          chartCell(r.marker, RC_MARKER, { bold: true }),
          priorCell(r.prior, RC_PRIOR),
          chartCell(r.current, RC_CURRENT),
          chartCell(r.labRange, RC_LAB),
          chartCell(r.optimalRange, RC_OPTIMAL),
          statusCell(r.status, r.trend, RC_STATUS, r.withinLabRange),
        ],
      }),
  );

  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
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
  return new TableCell({
    borders: bordersAll(),
    width: { size: width, type: WidthType.DXA },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: status,
            bold: true,
            color: withinLabRange === true ? TEAL : NAVY,
            size: 20,
            font: "Arial",
          }),
        ],
      }),
      new Paragraph({
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
  const labelWidth = 1900;
  const valueWidth = CONTENT_WIDTH / 2 - labelWidth; // 2780

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
        children: [
          chartCell(r.marker, COL_MARKER, { bold: true }),
          chartCell(r.result, COL_RESULT),
          chartCell(r.labRange, COL_LAB),
          chartCell(r.optimalRange, COL_OPTIMAL),
          chartCell(r.status, COL_STATUS, {
            bold: true,
            // Asterisked rows are inside the lab range: teal, not alarm red.
            color: r.withinLabRange === true ? TEAL : NAVY,
          }),
        ],
      }),
  );

  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
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
