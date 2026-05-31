/**
 * Word document generator for the Functional Medicine Report.
 *
 * Input: FlaggedMarker[] from the flagging engine + patient metadata.
 * Output: .docx bytes matching the eval-form template structure (PART I
 * populated per-marker, PART II/III scaffolded as practitioner-completed
 * placeholders).
 *
 * The clinical narrative comes from lib/narratives/marker-narratives.ts —
 * extracted from Melissa's eval-form template. The generator only inserts
 * patient data; it does NOT author clinical interpretation.
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  Header,
  Footer,
  AlignmentType,
  LevelFormat,
  BorderStyle,
  WidthType,
  ShadingType,
  HeadingLevel,
  PageNumber,
} from "docx";
import type { FlaggedMarker } from "../flagging";
import { findMarker } from "../ranges/optimal-ranges";
import {
  MARKER_NARRATIVES,
} from "../narratives/marker-narratives";
import type { MarkerNarrative } from "../narratives/types";

// ----- Brand -----
const NAVY = "1B365D";
const TEAL = "4A90A4";
const LIGHT_TEAL = "DCE9EE"; // table header shading
const GREY = "666666";
const LIGHT_GREY = "CCCCCC";

// ----- Page geometry (US Letter, 1" margins) -----
const PAGE_WIDTH = 12240;
const PAGE_HEIGHT = 15840;
const PAGE_MARGIN = 1440;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2; // 9360

// ----- Panel ordering -----
// Drives PART I marker rendering. Markers in flaggedMarker[] that aren't in
// this list are appended at the end under "Additional Markers".
const PANEL_ORDER: string[] = [
  // CBC
  "RBC (Red Blood Cell)", "Hemoglobin", "Hematocrit",
  "MCV (Mean Corpuscular Volume)", "MCH (Mean Corpuscular Hemoglobin)",
  "MCHC (Mean Corpuscular Hemoglobin Concentration)",
  "RDW (Red Cell Distribution Width)", "Platelets", "MPV (Mean Platelet Volume)",
  // WBC differential
  "WBC (White Blood Cell)", "Neutrophils", "Lymphocytes", "Monocytes",
  "Eosinophils", "Basophils",
  // Epstein-Barr
  "EBV Early Antigen IgG", "EBV Viral Capsid IgM", "EBV Viral Capsid IgG", "EBV Nuclear AG IgG",
  // Vitamin D
  "Vitamin D 25-OH", "Vitamin D 1,25 (OH)2 Total", "Vitamin D2", "Vitamin D3",
  // ANA
  "ANA (Anti-nuclear Antibodies)",
  // Thyroid
  "sTSH (Serum Thyroid Stimulating Hormone)",
  "T4 Free", "T4 Total", "T3 Free", "T3 Total",
  "Thyroid Peroxidase", "Thyroglobulin Antibodies",
  // Kidney
  "BUN (Blood Urea Nitrogen)", "Creatinine", "BUN/Creatinine Ratio", "eGFR",
  // Liver
  "AST (Aspartate Aminotransferase)", "ALT (Alanine Aminotransferase)",
  "Alkaline Phosphatase", "Total Bilirubin", "Total Protein",
  "Albumin", "A/G Ratio", "Globulin",
  "GGT (Gamma-Glutamyl Transpeptidase)",
  // Cholesterol
  "Cholesterol", "LDL (Low Density Lipoprotein Cholesterol)", "Triglycerides",
  "HDL (High Density Lipoprotein)",
  // Blood sugar
  "Hemoglobin A1C", "Glucose", "Insulin",
  // Systemic inflammation
  "Hs-CRP", "LDH (Lactate-Dehydrogenase)",
  // Electrolytes
  "Calcium", "Sodium", "Potassium", "Chloride", "CO2 (Carbon Dioxide)",
  // Minerals / vitamins / methylation
  "Magnesium", "Magnesium RBC", "Vitamin B12", "Homocysteine",
  "Methylmalonic Acid", "Uric Acid", "MTHFR",
  // Iron
  "Iron", "Ferritin", "% Iron Saturation", "TIBC (Total Iron Binding Capacity)",
  // Food sensitivities
  "Casein", "Cacao", "Corn", "Soy", "Eggwhite", "Wheat", "Yeast",
  // Gut / vitamins
  "Vitamin B6", "Candida Albicans",
  // Cortisol
  "Cortisol",
  // Hormones
  "Estrogens", "Estradiol (E2)", "Estrone (E1)", "Estriol (E3)",
  "Testosterone Total", "Testosterone Free", "Testosterone Bioavailable",
  "SHBG (Sex Hormone Binding Globulin)", "DHEA Sulfate",
  "Progesterone", "Prolactin", "Pregnenolone",
  "FSH (Follicle Stimulating Hormone)", "LH (Luteinizing Hormone)",
  "AMH (Anti-Mullerian Hormone)",
  "PSA Total", "PSA Free", "PSA % Free",
  // Misc
  "Rheumatoid Factor", "Lead Venous", "Mercury Blood",
  "Leptin", "Amylase", "Lipase", "ABO Group",
  "Albumin Urine", "Specific Gravity", "Urine pH",
  // Omega panel
  "EPA", "DHA", "DPA", "Omega-3 Total", "Omega-6 Total", "Omega-6/Omega-3 Ratio",
  "Arachidonic Acid", "Arachidonic Acid/EPA Ratio", "Linoleic Acid",
  // Cardio IQ
  "LDL Particle", "LDL Small", "LDL Medium", "HDL Large",
  "LDL Pattern", "LDL Peak Size", "Apoliopoprotein B",
  "Lipoprotein (a)", "LP PLA2 Activity", "Omega Check",
];

// ----- Public API -----

export interface GeneratorOptions {
  patientName: string;
  patientDate: string; // ISO date string or any display-ready string
}

export async function generateWordReport(
  flagged: FlaggedMarker[],
  opts: GeneratorOptions,
): Promise<Buffer> {
  const doc = buildDocument(flagged, opts);
  return Packer.toBuffer(doc);
}

// ----- Document assembly -----

function buildDocument(flagged: FlaggedMarker[], opts: GeneratorOptions): Document {
  // Render groups:
  //   PART I = every matched marker EXCEPT not_flaggable-without-source.
  //     Matched + flaggable → standard render.
  //     Matched + not_flaggable + Melissa-confirmed source (or any populated
  //       confirmationSource) → render with "no range available" note so
  //       Melissa's hormone / vitamin D / sentinel panels are still visible
  //       in the report per spec.
  //   Appendix = unmatched + matched-but-not_flaggable-without-source.
  const matched = flagged.filter(
    (f) =>
      f.matchStatus === "matched" &&
      (f.flagStatus !== "not_flaggable" || !!f.confirmationSource),
  );
  const unmatched = flagged.filter(
    (f) =>
      f.matchStatus !== "matched" ||
      (f.flagStatus === "not_flaggable" && !f.confirmationSource),
  );

  // Sort matched into panel order; unknown markers append.
  const orderIndex = new Map<string, number>();
  PANEL_ORDER.forEach((name, i) => orderIndex.set(name, i));
  const sortedMatched = [...matched].sort((a, b) => {
    const ai = orderIndex.get(a.canonicalName) ?? Number.MAX_SAFE_INTEGER;
    const bi = orderIndex.get(b.canonicalName) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.canonicalName.localeCompare(b.canonicalName);
  });

  const children: Array<Paragraph | Table> = [];

  // Title
  children.push(centeredHeading("CARBONE CHIROPRACTIC CENTER, LLC", 32, true));
  children.push(centeredHeading("FUNCTIONAL MEDICINE REPORT", 28, true));
  children.push(blankParagraph());

  // Patient line
  children.push(
    new Paragraph({
      children: [
        runBold(`Patient: `, NAVY),
        runPlain(opts.patientName + "    "),
        runBold(`Date: `, NAVY),
        runPlain(opts.patientDate),
      ],
      spacing: { after: 240 },
    }),
  );

  // Table of Contents
  children.push(sectionHeading("TABLE OF CONTENTS"));
  for (const entry of [
    "Summary of Findings and Protocol",
    "PART I — Lab Values and Data Analysis",
    "PART II — Summary of Results",
    "PART III — Dietary and Supplement Recommendations",
  ]) {
    children.push(
      new Paragraph({
        children: [runPlain(entry)],
        spacing: { after: 100 },
      }),
    );
  }
  children.push(blankParagraph());

  // PART I
  children.push(partHeading("PART I — Lab Values and Data Analysis"));
  for (const m of sortedMatched) {
    children.push(...renderMarker(m));
  }

  // PART II
  children.push(blankParagraph());
  children.push(partHeading("PART II — Summary of Results"));
  children.push(subHeading("Results:"));
  children.push(placeholder("[Practitioner to summarize based on flagged markers above]"));
  children.push(subHeading("Treatment Plan:"));
  children.push(placeholder("[Practitioner to outline based on findings]"));

  // PART III
  children.push(blankParagraph());
  children.push(partHeading("PART III — Dietary and Supplement Recommendations"));
  children.push(placeholder("[Practitioner to complete]"));

  // Appendix
  if (unmatched.length > 0) {
    children.push(blankParagraph());
    children.push(sectionHeading("Unmatched markers from this report"));
    children.push(
      new Paragraph({
        children: [
          runPlain(
            "The following markers were present on the lab report but were not flagged by the tool — either because they are not in Melissa's confirmed marker list, were classified as not_flaggable (e.g. no lab range available, non-numeric value), or could not be matched to the optimal-ranges dictionary. Surface for manual review.",
          ),
        ],
        spacing: { after: 120 },
      }),
    );
    for (const u of unmatched) {
      const reason = u.flagNotes.join("; ") || "no reason recorded";
      children.push(
        new Paragraph({
          numbering: { reference: "bullets", level: 0 },
          children: [
            runBold(u.rawName || u.canonicalName || "(unknown)", NAVY),
            runPlain(`  —  status: ${u.matchStatus}/${u.flagStatus}; ${reason}`),
          ],
        }),
      );
    }
  }

  return new Document({
    creator: "Carbone Chiropractic Center, LLC",
    title: "Functional Medicine Report",
    styles: {
      default: { document: { run: { font: "Arial", size: 22 } } }, // 11pt
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 32, bold: true, font: "Arial", color: NAVY },
          paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0 } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
          run: { size: 26, bold: true, font: "Arial", color: NAVY },
          paragraph: { spacing: { before: 180, after: 100 }, outlineLevel: 1 } },
      ],
    },
    numbering: {
      config: [
        { reference: "bullets",
          levels: [{
            level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          }] },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
          margin: { top: PAGE_MARGIN, right: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN },
        },
      },
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [runSmall("Carbone Chiropractic Center, LLC  —  Functional Medicine Report", NAVY)],
            }),
          ],
        }),
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                runSmall("Page ", GREY),
                new TextRun({ children: [PageNumber.CURRENT], size: 18, color: GREY, font: "Arial" }),
              ],
            }),
          ],
        }),
      },
      children,
    }],
  });
}

// ----- Per-marker rendering -----

function renderMarker(m: FlaggedMarker): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [];

  // Section heading: marker name in Navy
  out.push(
    new Paragraph({
      children: [runBold(m.canonicalName, NAVY, 26)],
      spacing: { before: 200, after: 80 },
      keepNext: true,
    }),
  );

  // Result table (single row, three columns)
  out.push(buildResultTable(m));

  // Sentinel / Melissa-supplied source citation when applicable.
  if (m.confirmationSource && m.confirmationSource.startsWith("Melissa Carbone")) {
    out.push(
      new Paragraph({
        spacing: { before: 40, after: 80 },
        children: [
          runItalic(`Range source: ${m.confirmationSource}`, GREY, 18),
        ],
      }),
    );
  } else if (m.confirmationPending) {
    out.push(
      new Paragraph({
        spacing: { before: 40, after: 80 },
        children: [
          runItalic("Range pending confirmation from Melissa.", GREY, 18),
        ],
      }),
    );
  }

  // Narrative
  const narrative = MARKER_NARRATIVES[m.canonicalName];
  if (narrative) {
    out.push(...renderNarrative(narrative));
  } else {
    out.push(placeholder("[Clinical interpretation pending]"));
  }

  // flagNotes from the flagging engine (e.g. cycle-phase note, three-tier
  // band detail). Render as small italic prose below the narrative.
  const usefulNotes = m.flagNotes.filter(
    (n) =>
      !n.startsWith("normalized match") &&
      !n.startsWith("fuzzy match") &&
      !n.startsWith("rejected short-name") &&
      !n.startsWith("LDL Pattern range column artifact") &&
      !n.startsWith("appendix range preferred") &&
      !n.startsWith("divergent value/unit"),
  );
  if (usefulNotes.length > 0) {
    out.push(
      new Paragraph({
        spacing: { before: 40, after: 0 },
        children: [runItalic(usefulNotes.join("; "), GREY, 18)],
      }),
    );
  }

  out.push(blankParagraph());
  return out;
}

function renderNarrative(n: MarkerNarrative): Paragraph[] {
  const out: Paragraph[] = [];
  const hasAnything =
    n.description.length > 0 ||
    n.increaseCauses.length > 0 ||
    n.decreaseCauses.length > 0 ||
    (n.additionalProse !== null && n.additionalProse.length > 0);

  if (!hasAnything) {
    out.push(placeholder("[Clinical interpretation pending]"));
    return out;
  }

  if (n.description) {
    for (const para of n.description.split(/\n+/)) {
      if (!para.trim()) continue;
      out.push(
        new Paragraph({
          children: [runPlain(para.trim())],
          spacing: { after: 80 },
        }),
      );
    }
  }

  if (n.increaseCauses.length > 0) {
    out.push(
      new Paragraph({
        children: [runBold("Increase:", NAVY)],
        spacing: { before: 40, after: 40 },
        keepNext: true,
      }),
    );
    for (const c of n.increaseCauses) {
      out.push(
        new Paragraph({
          numbering: { reference: "bullets", level: 0 },
          children: [runPlain(c)],
        }),
      );
    }
  }

  if (n.decreaseCauses.length > 0) {
    out.push(
      new Paragraph({
        children: [runBold("Decrease:", NAVY)],
        spacing: { before: 40, after: 40 },
        keepNext: true,
      }),
    );
    for (const c of n.decreaseCauses) {
      out.push(
        new Paragraph({
          numbering: { reference: "bullets", level: 0 },
          children: [runPlain(c)],
        }),
      );
    }
  }

  if (n.additionalProse) {
    for (const para of n.additionalProse.split(/\n+/)) {
      if (!para.trim()) continue;
      out.push(
        new Paragraph({
          children: [runPlain(para.trim())],
          spacing: { before: 60, after: 60 },
        }),
      );
    }
  }

  return out;
}

// ----- Result table -----

function buildResultTable(m: FlaggedMarker): Table {
  const col1 = 3120; // Result
  const col2 = 3120; // Lab range
  const col3 = CONTENT_WIDTH - col1 - col2; // Optimal range / band thresholds

  const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GREY };
  const borders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

  const headerShading = { fill: LIGHT_TEAL, type: ShadingType.CLEAR, color: "auto" };

  const flagText = formatFlagIndicator(m);
  const resultLabel = formatResultValue(m);
  const labRangeLabel = formatRange(m, "lab");
  const optimalLabel = formatRange(m, "optimal");

  // Header row
  const headerRow = new TableRow({
    children: [
      headerCell("Result", col1, headerShading, borders),
      headerCell("Lab Range", col2, headerShading, borders),
      headerCell(optimalRangeColumnLabel(m), col3, headerShading, borders),
    ],
  });

  // Value row — Result cell carries the flag indicator inline.
  const valueRow = new TableRow({
    children: [
      new TableCell({
        borders,
        width: { size: col1, type: WidthType.DXA },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [
          new Paragraph({
            children: [
              ...(flagText
                ? [runBold(flagText + "  ", flagColor(m), 22), runPlain(resultLabel)]
                : [runPlain(resultLabel)]),
            ],
          }),
        ],
      }),
      bodyCell(labRangeLabel, col2, borders),
      bodyCell(optimalLabel, col3, borders),
    ],
  });

  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [col1, col2, col3],
    rows: [headerRow, valueRow],
  });
}

function headerCell(text: string, width: number, shading: { fill: string; type: typeof ShadingType.CLEAR; color: string }, borders: ReturnType<typeof bordersAll>): TableCell {
  return new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    shading,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [
      new Paragraph({ children: [runBold(text, NAVY)] }),
    ],
  });
}

function bordersAll() {
  const b = { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GREY };
  return { top: b, bottom: b, left: b, right: b };
}

function bodyCell(text: string, width: number, borders: ReturnType<typeof bordersAll>): TableCell {
  return new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({ children: [runPlain(text)] })],
  });
}

// ----- Formatting helpers -----

function formatResultValue(m: FlaggedMarker): string {
  const v = m.value === null || m.value === undefined ? "" : String(m.value);
  const unit = m.unit ? ` ${m.unit}` : "";
  return v ? `${v}${unit}` : "(no value)";
}

function optimalRangeColumnLabel(m: FlaggedMarker): string {
  if (m.flagType === "three_tier_band") return "Band Thresholds";
  if (m.flagType === "categorical") return "Expected";
  if (m.flagType === "lab_range_only") return "Optimal Range";
  return "Optimal Range";
}

function formatRange(m: FlaggedMarker, which: "lab" | "optimal"): string {
  const rec = findMarker(m.canonicalName);
  if (!rec) return which === "lab" ? m.referenceRangeRaw || "—" : "—";

  if (which === "lab") {
    const { min, max } = rec.labRange;
    if (min !== null && max !== null) return `${min}–${max}`;
    if (min !== null) return `≥ ${min}`;
    if (max !== null) return `< ${max}`;
    return m.referenceRangeRaw || "—";
  }

  // optimal column
  if (m.flagType === "three_tier_band") {
    const bands = rec.interpretationBands ?? [];
    return bands
      .map((b) => {
        const lo = b.min ?? "−∞";
        const hi = b.max ?? "+∞";
        return `${b.label}: [${lo}, ${hi})`;
      })
      .join("  |  ");
  }
  if (m.flagType === "categorical") {
    return rec.expectedValue ?? "—";
  }
  const { min, max } = rec.optimalRange;
  if (min !== null && max !== null) return `${min}–${max}`;
  if (min !== null) return `≥ ${min}`;
  if (max !== null) return `< ${max}`;
  return "—";
}

function formatFlagIndicator(m: FlaggedMarker): string | null {
  switch (m.flagStatus) {
    case "optimal": return "✓ OPTIMAL";
    case "high": return "↑ HIGH";
    case "low": return "↓ LOW";
    case "moderate": return "⚠ MODERATE";
    case "out_of_range": return "⚠ OUT OF RANGE";
    case "informational": return "ⓘ INFORMATIONAL";
    case "not_flaggable": return "— NO RANGE";
    default: return null;
  }
}

function flagColor(m: FlaggedMarker): string {
  // Optimal in muted navy; everything else in teal (the accent color).
  if (m.flagStatus === "optimal") return NAVY;
  if (m.flagStatus === "informational") return GREY;
  return TEAL;
}

// ----- Primitive run / paragraph builders -----

function runPlain(text: string, color = "000000", size = 22): TextRun {
  return new TextRun({ text, color, size, font: "Arial" });
}
function runBold(text: string, color = NAVY, size = 22): TextRun {
  return new TextRun({ text, bold: true, color, size, font: "Arial" });
}
function runItalic(text: string, color = GREY, size = 20): TextRun {
  return new TextRun({ text, italics: true, color, size, font: "Arial" });
}
function runSmall(text: string, color = GREY): TextRun {
  return new TextRun({ text, color, size: 18, font: "Arial" });
}

function centeredHeading(text: string, size: number, bold: boolean): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 60, after: 60 },
    children: [new TextRun({ text, size, bold, color: NAVY, font: "Arial" })],
  });
}

function partHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 300, after: 120 },
    children: [new TextRun({ text, size: 30, bold: true, color: NAVY, font: "Arial" })],
  });
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 220, after: 100 },
    children: [new TextRun({ text, size: 26, bold: true, color: NAVY, font: "Arial" })],
  });
}

function subHeading(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 120, after: 60 },
    children: [runBold(text, NAVY, 24)],
  });
}

function placeholder(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    children: [runItalic(text, GREY, 22)],
  });
}

function blankParagraph(): Paragraph {
  return new Paragraph({ children: [], spacing: { after: 80 } });
}
