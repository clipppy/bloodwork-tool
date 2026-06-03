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
import { MARKER_NARRATIVES } from "../narratives/marker-narratives";
import type {
  MarkerNarrative,
  AdditionalProseBlock,
} from "../narratives/types";

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

// ----- Per-section header spacing (consistent across all marker headers) -----
const HEADER_SPACING_BEFORE = 240;
const HEADER_SPACING_AFTER = 120;

// ----- Panel grouping -----
// PART I groups markers under panel headings. Panels with zero markers
// from the current PDF are skipped (no empty headers).
interface Panel {
  name: string;
  /** Canonical names in display order. */
  members: string[];
}

const PANELS: Panel[] = [
  { name: "Complete Blood Count", members: [
    "RBC (Red Blood Cell)", "Hemoglobin", "Hematocrit",
    "MCV (Mean Corpuscular Volume)", "MCH (Mean Corpuscular Hemoglobin)",
    "MCHC (Mean Corpuscular Hemoglobin Concentration)",
    "RDW (Red Cell Distribution Width)", "Platelets", "MPV (Mean Platelet Volume)",
  ]},
  { name: "WBC Differential", members: [
    "WBC (White Blood Cell)", "Neutrophils", "Lymphocytes", "Monocytes",
    "Eosinophils", "Basophils",
  ]},
  { name: "Epstein-Barr", members: [
    "EBV Early Antigen IgG", "EBV Viral Capsid IgM", "EBV Viral Capsid IgG", "EBV Nuclear AG IgG",
  ]},
  { name: "Vitamin D", members: [
    "Vitamin D 25-OH", "Vitamin D 1,25 (OH)2 Total", "Vitamin D2", "Vitamin D3",
  ]},
  { name: "ANA", members: ["ANA (Anti-nuclear Antibodies)"] },
  { name: "Thyroid", members: [
    "sTSH (Serum Thyroid Stimulating Hormone)", "T4 Free", "T4 Total",
    "T3 Free", "T3 Total", "Thyroid Peroxidase", "Thyroglobulin Antibodies",
  ]},
  { name: "Kidney", members: [
    "BUN (Blood Urea Nitrogen)", "Creatinine", "BUN/Creatinine Ratio", "eGFR",
  ]},
  { name: "Liver", members: [
    "AST (Aspartate Aminotransferase)", "ALT (Alanine Aminotransferase)",
    "Alkaline Phosphatase", "Total Bilirubin", "Total Protein",
    "Albumin", "A/G Ratio", "Globulin",
    "GGT (Gamma-Glutamyl Transpeptidase)",
  ]},
  { name: "Lipid Panel", members: [
    "Cholesterol", "LDL (Low Density Lipoprotein Cholesterol)",
    "HDL (High Density Lipoprotein)", "Triglycerides",
  ]},
  { name: "Glucose Metabolism", members: [
    "Glucose", "Hemoglobin A1C", "Insulin",
  ]},
  { name: "Inflammation", members: ["Hs-CRP"] },
  { name: "Other Labs", members: ["LDH (Lactate-Dehydrogenase)"] },
  { name: "Electrolytes", members: [
    "Calcium", "Sodium", "Potassium", "Chloride", "CO2 (Carbon Dioxide)",
  ]},
  { name: "Minerals", members: ["Magnesium", "Magnesium RBC"] },
  { name: "B Vitamins & Homocysteine", members: [
    "Vitamin B12", "Vitamin B6", "Homocysteine", "Methylmalonic Acid",
  ]},
  { name: "Uric Acid", members: ["Uric Acid"] },
  { name: "MTHFR", members: ["MTHFR"] },
  { name: "Iron Panel", members: [
    "Iron", "Ferritin", "% Iron Saturation", "TIBC (Total Iron Binding Capacity)",
  ]},
  { name: "Food Sensitivities", members: [
    "Casein", "Cacao", "Corn", "Soy", "Eggwhite", "Wheat", "Yeast",
  ]},
  { name: "Candida", members: ["Candida Albicans"] },
  { name: "Cortisol", members: ["Cortisol"] },
  { name: "Hormones — Estrogens & Female", members: [
    "Estrogens", "Estradiol (E2)", "Estrone (E1)", "Estriol (E3)",
    "Progesterone", "Prolactin", "Pregnenolone",
    "FSH (Follicle Stimulating Hormone)", "LH (Luteinizing Hormone)",
    "AMH (Anti-Mullerian Hormone)",
  ]},
  { name: "Hormones — Androgens & PSA", members: [
    "Testosterone Total", "Testosterone Free", "Testosterone Bioavailable",
    "SHBG (Sex Hormone Binding Globulin)", "DHEA Sulfate",
    "PSA Total", "PSA Free", "PSA % Free",
  ]},
  { name: "Heavy Metals", members: ["Lead Venous", "Mercury Blood"] },
  { name: "Cardio IQ", members: [
    "LDL Particle", "LDL Small", "LDL Medium", "HDL Large",
    "LDL Pattern", "LDL Peak Size", "Apoliopoprotein B",
    "Lipoprotein (a)", "LP PLA2 Activity", "Omega Check",
  ]},
  { name: "Omega Panel", members: [
    "EPA", "DHA", "DPA", "Omega-3 Total", "Omega-6 Total", "Omega-6/Omega-3 Ratio",
    "Arachidonic Acid", "Arachidonic Acid/EPA Ratio", "Linoleic Acid",
  ]},
  { name: "Miscellaneous", members: [
    "Leptin", "Amylase", "Lipase", "Rheumatoid Factor", "ABO Group",
  ]},
  { name: "Urinalysis", members: [
    "Albumin Urine", "Specific Gravity", "Urine pH",
  ]},
];

// ----- Public API -----

export interface GeneratorOptions {
  patientName: string;
  patientDate: string;
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
  // PART I = every matched marker EXCEPT not_flaggable-without-source.
  const matched = flagged.filter(
    (f) =>
      f.matchStatus === "matched" &&
      (f.flagStatus !== "not_flaggable" || !!f.confirmationSource),
  );
  const appendix = flagged.filter(
    (f) =>
      f.matchStatus !== "matched" ||
      (f.flagStatus === "not_flaggable" && !f.confirmationSource),
  );

  // Bucket matched markers by panel; preserve declared panel-member order.
  const panelBuckets = new Map<string, FlaggedMarker[]>();
  const additionalBucket: FlaggedMarker[] = [];
  const memberPanel = new Map<string, { name: string; rank: number }>();
  for (const panel of PANELS) {
    panel.members.forEach((name, i) => {
      memberPanel.set(name, { name: panel.name, rank: i });
    });
    panelBuckets.set(panel.name, []);
  }
  for (const m of matched) {
    const ref = memberPanel.get(m.canonicalName);
    if (ref) panelBuckets.get(ref.name)!.push(m);
    else additionalBucket.push(m);
  }
  // Sort within each panel by declared member rank.
  for (const panel of PANELS) {
    const bucket = panelBuckets.get(panel.name)!;
    bucket.sort((a, b) => {
      const ar = memberPanel.get(a.canonicalName)!.rank;
      const br = memberPanel.get(b.canonicalName)!.rank;
      return ar - br;
    });
  }

  const children: Array<Paragraph | Table> = [];

  // Title
  children.push(centeredHeading("CARBONE CHIROPRACTIC CENTER, LLC", 32, true));
  children.push(centeredHeading("FUNCTIONAL MEDICINE REPORT", 28, true));
  children.push(blankParagraph());

  // Patient line
  children.push(
    new Paragraph({
      children: [
        runBold("Patient: ", NAVY),
        runPlain(opts.patientName + "    "),
        runBold("Date: ", NAVY),
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

  // PART I — markers grouped by panel
  children.push(partHeading("PART I — Lab Values and Data Analysis"));
  for (const panel of PANELS) {
    const bucket = panelBuckets.get(panel.name)!;
    if (bucket.length === 0) continue;
    // ANA's panel name ("ANA") is just a prefix of its sole member's
    // canonical name ("ANA (Anti-nuclear Antibodies)"), so the divider and
    // the marker's section header would read as a visual double header.
    // Suppress the divider for ANA so it renders like every other marker:
    // a single Navy bold canonical-name section header.
    if (panel.name !== "ANA") children.push(...panelDivider(panel.name));
    for (const m of bucket) children.push(...renderMarker(m));
  }
  if (additionalBucket.length > 0) {
    children.push(...panelDivider("Additional Markers"));
    for (const m of additionalBucket) children.push(...renderMarker(m));
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

  // Pages compatibility note (after PART III, before appendix)
  children.push(blankParagraph());
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 100 },
      children: [
        new TextRun({
          text:
            "Note: open this document in Microsoft Word or Google Docs for correct formatting. Apple Pages may not render all table content correctly.",
          italics: true,
          size: 18, // 9pt
          color: NAVY,
          font: "Arial",
        }),
      ],
    }),
  );

  // Appendix
  if (appendix.length > 0) {
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
    for (const u of appendix) {
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
      default: { document: { run: { font: "Arial", size: 22 } } },
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

// ----- Panel divider -----

function panelDivider(name: string): Paragraph[] {
  // Tiny Teal caps label
  const label = new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { before: 320, after: 60 },
    children: [
      new TextRun({
        text: name.toUpperCase(),
        bold: true,
        size: 18, // 9pt
        color: TEAL,
        font: "Arial",
        // letter-spacing approximation via character spacing
        characterSpacing: 30,
      }),
    ],
  });
  // Thin Teal horizontal rule via bottom border on an empty paragraph
  // (per docx skill guidance — do NOT use a table for dividers).
  const rule = new Paragraph({
    spacing: { before: 0, after: 80 },
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 8, color: TEAL, space: 1 },
    },
    children: [],
  });
  return [label, rule];
}

// ----- Per-marker rendering -----

function renderMarker(m: FlaggedMarker): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [];
  const narrative = MARKER_NARRATIVES[m.canonicalName];

  // Section heading: marker name in Navy, consistent spacing.
  out.push(
    new Paragraph({
      children: [runBold(m.canonicalName, NAVY, 26)],
      spacing: { before: HEADER_SPACING_BEFORE, after: HEADER_SPACING_AFTER },
      keepNext: true,
    }),
  );

  // Result table
  out.push(buildResultTable(m));

  // ANA: render titer/pattern sub-line below the result table when
  // either is populated (synthesized record from the parser).
  const anaSubLine = buildAnaSubLine(m);
  if (anaSubLine) out.push(anaSubLine);

  const hasNarrative = narrativeHasContent(narrative);

  if (hasNarrative) {
    // Standard rendering: source citation (if any) then narrative.
    if (m.confirmationSource && m.confirmationSource.startsWith("Melissa Carbone")) {
      out.push(
        new Paragraph({
          spacing: { before: 60, after: 80 },
          children: [runItalic(`Range source: ${m.confirmationSource}`, GREY, 18)],
        }),
      );
    } else if (m.confirmationPending) {
      out.push(
        new Paragraph({
          spacing: { before: 60, after: 80 },
          children: [runItalic("Range pending confirmation from Melissa.", GREY, 18)],
        }),
      );
    }
    out.push(...renderNarrative(narrative!));
  } else {
    // Condensed empty-marker footnote: one italic line combining source +
    // "interpretation pending" + lab-report note.
    out.push(buildEmptyFootnote(m));
  }

  // flagNotes from the flagging engine (e.g. cycle-phase, three-tier
  // band detail). Render as small italic prose below the narrative.
  const usefulNotes = m.flagNotes.filter(
    (n) =>
      !n.startsWith("normalized match") &&
      !n.startsWith("fuzzy match") &&
      !n.startsWith("rejected short-name") &&
      !n.startsWith("LDL Pattern range column artifact") &&
      !n.startsWith("appendix range preferred") &&
      !n.startsWith("divergent value/unit") &&
      // Redundant with the result table, which already shows the
      // out-of-range result, lab value, and expected value side by side.
      !n.startsWith('expected "') &&
      // Already implicit in the empty-marker footnote
      !(n === "no range available, refer to lab report" && !hasNarrative),
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

/** Render the ANA titer/pattern sub-line that sits between the result
 *  table and the narrative. Returns null when the marker is not ANA, or
 *  when both fields are missing (e.g. negative ANA where Quest didn't
 *  emit titer/pattern rows). */
function buildAnaSubLine(m: FlaggedMarker): Paragraph | null {
  if (!m.titer && !m.pattern) return null;
  const parts: string[] = [];
  if (m.titer) parts.push(`Titer: ${m.titer}`);
  if (m.pattern) parts.push(`Pattern: ${m.pattern}`);
  const text = parts.join("   ·   ");
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    indent: { left: 120 },
    children: [runItalic(text, GREY, 20)], // 20 half-points = 10pt
  });
}

function narrativeHasContent(n: MarkerNarrative | undefined): boolean {
  if (!n) return false;
  if (n.description.length > 0) return true;
  if (n.increaseCauses.length > 0) return true;
  if (n.decreaseCauses.length > 0) return true;
  if (n.additionalProse !== null) return true;
  return false;
}

function buildEmptyFootnote(m: FlaggedMarker): Paragraph {
  const parts: string[] = [];
  if (m.confirmationSource && m.confirmationSource.startsWith("Melissa Carbone")) {
    parts.push(`Range source: ${m.confirmationSource}`);
  }
  parts.push("Clinical interpretation to be completed by practitioner");
  const rec = findMarker(m.canonicalName);
  const labRange = rec?.labRange;
  if (
    labRange &&
    labRange.min === null &&
    labRange.max === null &&
    rec?.flagType === "lab_range_only"
  ) {
    parts.push("refer to lab report for reference range");
  }
  return new Paragraph({
    spacing: { before: 80, after: 80 },
    children: [runItalic(parts.join(" — "), GREY, 20)],
  });
}

function renderNarrative(n: MarkerNarrative): Paragraph[] {
  const out: Paragraph[] = [];

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

  if (n.additionalProse !== null) {
    out.push(...renderAdditionalProse(n.additionalProse));
  }
  return out;
}

function renderAdditionalProse(
  prose: string | AdditionalProseBlock | AdditionalProseBlock[],
): Paragraph[] {
  const out: Paragraph[] = [];
  if (typeof prose === "string") {
    for (const para of prose.split(/\n+/)) {
      if (!para.trim()) continue;
      out.push(
        new Paragraph({
          children: [runPlain(para.trim())],
          spacing: { before: 60, after: 60 },
        }),
      );
    }
    return out;
  }
  const blocks: AdditionalProseBlock[] = Array.isArray(prose) ? prose : [prose];
  for (const block of blocks) {
    if (block.intro) {
      for (const para of block.intro.split(/\n+/)) {
        if (!para.trim()) continue;
        out.push(
          new Paragraph({
            children: [runBold(para.trim(), NAVY)],
            spacing: { before: 80, after: 40 },
            keepNext: true,
          }),
        );
      }
    }
    if (block.bullets && block.bullets.length > 0) {
      for (const b of block.bullets) {
        out.push(
          new Paragraph({
            numbering: { reference: "bullets", level: 0 },
            children: [runPlain(b)],
          }),
        );
      }
    }
    if (block.outro) {
      for (const para of block.outro.split(/\n+/)) {
        if (!para.trim()) continue;
        out.push(
          new Paragraph({
            children: [runPlain(para.trim())],
            spacing: { before: 60, after: 60 },
          }),
        );
      }
    }
  }
  return out;
}

// ----- Result table -----

function buildResultTable(m: FlaggedMarker): Table {
  const col1 = 3120;
  const col2 = 3120;
  const col3 = CONTENT_WIDTH - col1 - col2;

  const borders = bordersAll();
  const headerShading = { fill: LIGHT_TEAL, type: ShadingType.CLEAR, color: "auto" };

  const flagText = formatFlagIndicator(m);
  const resultLabel = formatResultValue(m);
  const labRangeLabel = formatRange(m, "lab");
  const optimalLabel = formatRange(m, "optimal");

  const headerRow = new TableRow({
    children: [
      headerCell("Result", col1, headerShading, borders),
      headerCell("Lab Range", col2, headerShading, borders),
      headerCell(optimalRangeColumnLabel(m), col3, headerShading, borders),
    ],
  });

  const indicator = formatFlagIndicatorStyling(m, flagText);

  const valueRow = new TableRow({
    children: [
      new TableCell({
        borders,
        width: { size: col1, type: WidthType.DXA },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [
          new Paragraph({
            children: [
              ...(indicator ? [indicator, runPlain("  " + resultLabel)] : [runPlain(resultLabel)]),
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

function headerCell(
  text: string,
  width: number,
  shading: { fill: string; type: typeof ShadingType.CLEAR; color: string },
  borders: ReturnType<typeof bordersAll>,
): TableCell {
  return new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    shading,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [new Paragraph({ children: [runBold(text, NAVY)] })],
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
  if (m.flagType === "categorical") return rec.expectedValue ?? "—";
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

/** Build the colored/styled TextRun for the flag indicator per item 8. */
function formatFlagIndicatorStyling(m: FlaggedMarker, text: string | null): TextRun | null {
  if (!text) return null;
  switch (m.flagStatus) {
    case "high":
    case "low":
    case "out_of_range":
      return new TextRun({ text, bold: true, color: NAVY, size: 22, font: "Arial" });
    case "moderate":
    case "optimal":
      return new TextRun({ text, bold: true, color: TEAL, size: 22, font: "Arial" });
    case "informational":
      return new TextRun({ text, color: GREY, size: 22, font: "Arial" });
    case "not_flaggable":
      return new TextRun({ text, color: GREY, size: 22, font: "Arial" });
    default:
      return new TextRun({ text, color: GREY, size: 22, font: "Arial" });
  }
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
