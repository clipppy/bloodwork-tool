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
  type ChartRow,
  type DeterministicAnalysis,
} from "../analysis/deterministic";
import type { AnalysisNarrative, NarrativeBlock } from "../analysis/prompt";

// ----- Brand (matches generator/word.ts; duplicated because those constants
// are module-private there and that file is intentionally not modified) -----
const NAVY = "1B365D";
const TEAL = "4A90A4";
const LIGHT_TEAL = "DCE9EE";
const GREY = "666666";
const LIGHT_GREY = "CCCCCC";

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
      case "bullet":
        return new Paragraph({
          spacing: { after: 60 },
          indent: { left: 460, hanging: 220 },
          children: [runPlain("•  ", "000000", 20), runPlain(b.text, "000000", 20)],
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
