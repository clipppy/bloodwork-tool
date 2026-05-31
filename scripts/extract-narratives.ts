/**
 * One-shot narrative extractor: reads Melissa's eval-form template, splits
 * into per-marker sections by matching marker-name anchors, and writes
 * lib/narratives/marker-narratives.ts as a TypeScript object literal.
 *
 * Run via: npm run extract:narratives
 *
 * Re-runnable. Re-runs overwrite the generated file. The output is then
 * checked in so callers don't need to re-extract at runtime.
 *
 * Implementation: reads the .docx as raw XML (not flattened text) so we
 * preserve paragraph-level bullet metadata. That lets us distinguish
 * "this paragraph is a bullet item in the source" from "this paragraph is
 * a prose sentence in the source," which matters for cardio-IQ markers
 * where Melissa uses bullets to enumerate treatment-plan observations.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { OPTIMAL_RANGES } from "../lib/ranges/optimal-ranges";
import type {
  MarkerNarrative,
  GroupNarrative,
  AdditionalProseBlock,
} from "../lib/narratives/types";

const TEMPLATE_PATH = path.resolve(
  __dirname,
  "../samples/templates/Copy of BW Evaluation Form - USE THIS '26 - google doc.docx",
);
const OUTPUT_PATH = path.resolve(
  __dirname,
  "../lib/narratives/marker-narratives.ts",
);

// ----- Raw paragraph type carried by the extractor -----

interface RawPara {
  text: string;
  /** true when the source paragraph has `<w:numPr>` (i.e. it's a bullet or
   *  numbered-list item). */
  isBullet: boolean;
}

// ----- Marker anchor table -----
// Maps the exact text that appears as a marker header in the eval form to the
// canonicalName from OPTIMAL_RANGES. The extractor finds these as anchor
// lines, then captures content between them.

interface Anchor {
  matchText: string;
  canonicalName: string;
  groupName?: string;
}

const ANCHORS: Anchor[] = [
  // CBC
  { matchText: "RBC (Red Blood Cell)", canonicalName: "RBC (Red Blood Cell)" },
  { matchText: "Hemoglobin", canonicalName: "Hemoglobin" },
  { matchText: "Hematocrit", canonicalName: "Hematocrit" },
  { matchText: "MCV (Mean Corpuscular Volume)", canonicalName: "MCV (Mean Corpuscular Volume)" },
  { matchText: "MCH (Mean Corpuscular Hemoglobin)", canonicalName: "MCH (Mean Corpuscular Hemoglobin)" },
  { matchText: "MCHC (Mean Corpuscular Hemoglobin Concentration)", canonicalName: "MCHC (Mean Corpuscular Hemoglobin Concentration)" },
  { matchText: "RDW (Red Cell Distribution Width)", canonicalName: "RDW (Red Cell Distribution Width)" },
  { matchText: "Platelets", canonicalName: "Platelets" },
  { matchText: "MPV (Mean Platelet Volume)", canonicalName: "MPV (Mean Platelet Volume)" },
  // WBC differential
  { matchText: "WBC (White Blood Cell)", canonicalName: "WBC (White Blood Cell)" },
  { matchText: "Neutrophils", canonicalName: "Neutrophils" },
  { matchText: "Lymphocytes", canonicalName: "Lymphocytes" },
  { matchText: "Monocytes", canonicalName: "Monocytes" },
  { matchText: "Eosinophils", canonicalName: "Eosinophils" },
  { matchText: "Basophils", canonicalName: "Basophils" },
  // EBV — shared block
  { matchText: "Epstein-Barr", canonicalName: "EBV Early Antigen IgG", groupName: "Epstein-Barr" },
  // Vitamin D / ANA
  { matchText: "Vitamin D 25-OH", canonicalName: "Vitamin D 25-OH" },
  { matchText: "ANA (Anti-nuclear Antibodies)", canonicalName: "ANA (Anti-nuclear Antibodies)" },
  // Thyroid
  { matchText: "sTSH (Serum Thyroid Stimulating Hormone)", canonicalName: "sTSH (Serum Thyroid Stimulating Hormone)" },
  { matchText: "Serum Thyroxine (T4) Free and Total", canonicalName: "T4 Total", groupName: "T4" },
  { matchText: "Triiodothryonine (T3) Free and Total", canonicalName: "T3 Total", groupName: "T3" },
  { matchText: "Thyroid Peroxidase", canonicalName: "Thyroid Peroxidase" },
  { matchText: "Thyroglobulin Antibodies", canonicalName: "Thyroglobulin Antibodies" },
  // Kidney
  { matchText: "BUN (Blood Urea Nitrogen)", canonicalName: "BUN (Blood Urea Nitrogen)" },
  { matchText: "Creatinine", canonicalName: "Creatinine" },
  { matchText: "BUN/Creatinine Ratio", canonicalName: "BUN/Creatinine Ratio" },
  // Liver
  { matchText: "AST (Aspartate Aminotransferase)", canonicalName: "AST (Aspartate Aminotransferase)" },
  { matchText: "ALT (Alanine Aminotransferase)", canonicalName: "ALT (Alanine Aminotransferase)" },
  { matchText: "Alkaline Phosphatase", canonicalName: "Alkaline Phosphatase" },
  { matchText: "Total Bilirubin", canonicalName: "Total Bilirubin" },
  { matchText: "Total Protein", canonicalName: "Total Protein" },
  { matchText: "Albumin", canonicalName: "Albumin" },
  { matchText: "A/G Ratio", canonicalName: "A/G Ratio" },
  { matchText: "Globulin", canonicalName: "Globulin" },
  { matchText: "GGT (Gamma-Glutamyl Transpeptidase)", canonicalName: "GGT (Gamma-Glutamyl Transpeptidase)" },
  // Lipids
  { matchText: "Cholesterol", canonicalName: "Cholesterol" },
  { matchText: "LDL (Low Density Lipoprotein Cholesterol)", canonicalName: "LDL (Low Density Lipoprotein Cholesterol)" },
  { matchText: "Triglycerides", canonicalName: "Triglycerides" },
  { matchText: "HDL (High Density Lipoprotein)", canonicalName: "HDL (High Density Lipoprotein)" },
  // Blood sugar
  { matchText: "Hemoglobin A1C", canonicalName: "Hemoglobin A1C" },
  { matchText: "Glucose", canonicalName: "Glucose" },
  { matchText: "Insulin", canonicalName: "Insulin" },
  // Inflammation
  { matchText: "Hs-CRP", canonicalName: "Hs-CRP" },
  { matchText: "LDH (Lactate-Dehydrogenase)", canonicalName: "LDH (Lactate-Dehydrogenase)" },
  // Electrolytes / minerals
  { matchText: "Calcium", canonicalName: "Calcium" },
  { matchText: "Sodium", canonicalName: "Sodium" },
  { matchText: "Potassium", canonicalName: "Potassium" },
  { matchText: "Chloride", canonicalName: "Chloride" },
  { matchText: "CO2 (Carbon Dioxide)", canonicalName: "CO2 (Carbon Dioxide)" },
  { matchText: "RBC Magnesium", canonicalName: "Magnesium RBC" },
  { matchText: "Magnesium", canonicalName: "Magnesium" },
  { matchText: "Vitamin B12", canonicalName: "Vitamin B12" },
  { matchText: "Homocysteine", canonicalName: "Homocysteine" },
  { matchText: "Methylmalonic Acid (MMA)", canonicalName: "Methylmalonic Acid" },
  { matchText: "Uric Acid", canonicalName: "Uric Acid" },
  { matchText: "MTHFR Mutation", canonicalName: "MTHFR" },
  // Iron
  { matchText: "Iron", canonicalName: "Iron" },
  { matchText: "Ferritin", canonicalName: "Ferritin" },
  { matchText: "% Iron Saturation", canonicalName: "% Iron Saturation" },
  { matchText: "TIBC (Total Iron Binding Capacity)", canonicalName: "TIBC (Total Iron Binding Capacity)" },
  // Gut / digestion
  { matchText: "Vitamin B6", canonicalName: "Vitamin B6" },
  { matchText: "Candida Albicans", canonicalName: "Candida Albicans" },
  // Misc
  { matchText: "Rheumatoid Factor", canonicalName: "Rheumatoid Factor" },
  { matchText: "Lead", canonicalName: "Lead Venous" },
  { matchText: "Mercury", canonicalName: "Mercury Blood" },
  { matchText: "Leptin", canonicalName: "Leptin" },
  { matchText: "Amylase:", canonicalName: "Amylase" },
  { matchText: "Lipase:", canonicalName: "Lipase" },
  { matchText: "Cortisol", canonicalName: "Cortisol" },
  // Cardio IQ
  { matchText: "LDL Particle", canonicalName: "LDL Particle" },
  { matchText: "LDL Small", canonicalName: "LDL Small" },
  { matchText: "LDL Medium", canonicalName: "LDL Medium" },
  { matchText: "(N) HDL Large", canonicalName: "HDL Large" },
  { matchText: "LDL Pattern", canonicalName: "LDL Pattern" },
  { matchText: "LDL Peak Size", canonicalName: "LDL Peak Size" },
  { matchText: "Apoliopoprotein B", canonicalName: "Apoliopoprotein B" },
  { matchText: "Lipoprotein (a)", canonicalName: "Lipoprotein (a)" },
  { matchText: "(Moderate) Hs-CRP", canonicalName: "Hs-CRP", groupName: "Hs-CRP Cardio IQ" },
  { matchText: "(L) Omega Check", canonicalName: "Omega Check" },
];

const STOP_TEXT = "PART II: Summary of Results";

// Group-section headings we treat as boundaries (end the current block).
const GROUP_HEADINGS = new Set<string>([
  "Overall Blood Health", "Immune Status",
  "Thyroid", " Thyroid",
  "Kidney", "Liver & Gall Bladder",
  "Cholesterol, Heart & Vascular Health", "Blood Sugar Metabolism",
  "Systemic Inflammatory Markers", "Vitamins, Minerals, & Electrolytes",
  "Iron Status", "Gut & Digestive Health", "Food Sensitivities",
  "Miscellaneous Tests", "Hormones", "Estrogens & Female:",
  "Testosterones and PSA:", "Cardio IQ Tests", "Cardio IQ Tests ",
  "PART 1: Lab Values and Data Analysis",
]);

// Hormone sub-row labels — unambiguous tokens only (Total/Free excluded
// because they also appear inside T4/T3 blocks).
const HORMONE_SUBROW_RE = /^(Estrone|Estradiol|Estriol|Progesterone|FSH|LH|Prolactin|Pregnenolone|Bioavailable|SHBG|DHEAs|PSA%|PSA Total|PSA Free):\s*Result/;

// Result-line patterns — any of these mark a template row that should NOT
// land in the description / bullets. Includes the time-band saliva rows
// from the Cortisol section, where the XML extractor drops the inter-tab
// whitespace so we end up with strings like "8-10AMResult:Lab Range ...".
const RESULT_LINE_PATTERNS: RegExp[] = [
  /^\s*(?:[A-Za-z()%/ -]+?:\s*)?\(?(?:[HLN])?\)?\s*Result\b/i,
  // Time-band Result rows: "8-10AMResult", "12-2PMResult", "10PM-1AMResult"
  /^\s*\d+\s*(?:AM|PM)?\s*[-–]\s*\d+\s*(?:AM|PM)\s*Result/i,
];

// Inline headings within a marker section that should also be skipped
// (they're labels for sub-rows, not narrative content). Cortisol's
// "Blood 8-10AM:" / "Saliva:" sub-section labels are the only current case.
const SKIP_INLINE = new Set<string>([
  "Blood 8-10AM:",
  "Saliva:",
]);

const INCREASE_HEADINGS = new Set<string>([
  "Increase:", "Increased:", "Increase", "Increased",
  "Increased Direct:", "Increased Indirect:",
]);
const DECREASE_HEADINGS = new Set<string>([
  "Decrease:", "Decreased:", "Decrease", "Decreased",
]);
// Special markers within a block that switch us into additionalProse mode.
const ADDITIONAL_INTROS = new Set<string>([
  "Educational Information only:",
  "Recommended Treatment for MTHFR Mutation:",
  "High ApoB means:",
]);

// ----- XML reader -----

function readDocxParagraphs(filePath: string): RawPara[] {
  // .docx is a ZIP archive; we only need word/document.xml.
  const buf = fs.readFileSync(filePath);
  const xml = extractDocumentXml(buf);
  return parseParagraphs(xml);
}

// Lightweight ZIP central-directory walker. We only support uncompressed
// (stored) and DEFLATE entries — both standard in .docx files.
function extractDocumentXml(zipBuf: Buffer): string {
  const eocdSig = 0x06054b50;
  // Find EOCD
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (zipBuf.readUInt32LE(i) === eocdSig) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Could not find ZIP EOCD record");
  const cdSize = zipBuf.readUInt32LE(eocdOffset + 12);
  const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);

  let p = cdOffset;
  while (p < cdOffset + cdSize) {
    if (zipBuf.readUInt32LE(p) !== 0x02014b50) throw new Error("Bad CD entry");
    const compressionMethod = zipBuf.readUInt16LE(p + 10);
    const compSize = zipBuf.readUInt32LE(p + 20);
    const uncompSize = zipBuf.readUInt32LE(p + 24);
    const nameLen = zipBuf.readUInt16LE(p + 28);
    const extraLen = zipBuf.readUInt16LE(p + 30);
    const commentLen = zipBuf.readUInt16LE(p + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(p + 42);
    const name = zipBuf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (name === "word/document.xml") {
      // Skip the local file header
      const lhNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
      const lhExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
      const data = zipBuf.slice(dataStart, dataStart + compSize);
      if (compressionMethod === 0) return data.toString("utf8");
      if (compressionMethod === 8) {
        const inflated = zlib.inflateRawSync(data, { maxOutputLength: uncompSize * 4 });
        return inflated.toString("utf8");
      }
      throw new Error(`Unsupported compression method ${compressionMethod}`);
    }
  }
  throw new Error("word/document.xml not found in archive");
}

function parseParagraphs(xml: string): RawPara[] {
  const out: RawPara[] = [];
  // Capture each <w:p ...>...</w:p>
  const re = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const inner = m[1];
    // Concatenate all <w:t...>...</w:t>
    // CRITICAL: `<w:t[^>]*>` would also match `<w:tab/>` and `<w:tr>` since
    // there's no word boundary after `<w:t`. Require either `>` immediately
    // or `>` after a whitespace-delimited attribute list.
    const textRe = /<w:t(?:>|\s[^>]*>)([\s\S]*?)<\/w:t>/g;
    let textM: RegExpExecArray | null;
    const parts: string[] = [];
    while ((textM = textRe.exec(inner)) !== null) {
      parts.push(decodeXmlEntities(textM[1]));
    }
    const text = parts.join("").trim();
    const isBullet = /<w:numPr\b/.test(inner);
    out.push({ text, isBullet });
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

// ----- Block segmentation -----

function isAnchorPara(p: RawPara): Anchor | null {
  for (const a of ANCHORS) {
    if (p.text === a.matchText) return a;
  }
  return null;
}

function isBoundary(p: RawPara): boolean {
  if (GROUP_HEADINGS.has(p.text)) return true;
  if (HORMONE_SUBROW_RE.test(p.text)) return true;
  return false;
}

function isResultLine(text: string): boolean {
  return RESULT_LINE_PATTERNS.some((re) => re.test(text));
}

interface RawBlock {
  anchor: Anchor;
  paras: RawPara[];
}

function splitBlocks(paras: RawPara[]): RawBlock[] {
  const blocks: RawBlock[] = [];
  let current: RawBlock | null = null;
  for (const para of paras) {
    if (!para.text) continue;
    if (para.text === STOP_TEXT) break;
    const anchor = isAnchorPara(para);
    if (anchor) {
      // De-dup: second Cortisol entry collapses into the first.
      const dup = blocks.find((b) => b.anchor.canonicalName === anchor.canonicalName);
      if (dup) { current = null; continue; }
      current = { anchor, paras: [] };
      blocks.push(current);
      continue;
    }
    if (isBoundary(para)) { current = null; continue; }
    if (current) current.paras.push(para);
  }
  return blocks;
}

// ----- Classification -----

type Mode = "desc" | "inc" | "dec" | "additional";

function classifyBlock(block: RawBlock): MarkerNarrative {
  const descParas: RawPara[] = [];
  const incParas: RawPara[] = [];
  const decParas: RawPara[] = [];
  // We collect additional sections as a sequence of (intro?, bullets[]) groups
  // built up as we walk the trailing portion of the block. A new group starts
  // every time we hit a non-bullet paragraph (which becomes its intro) or
  // when we transition from bullets back to prose (the prose becomes the
  // current group's outro and seals it).
  const additionalGroups: AdditionalProseBlock[] = [];
  let curGroup: AdditionalProseBlock | null = null;

  let mode: Mode = "desc";

  for (const para of block.paras) {
    if (isResultLine(para.text)) continue;
    if (SKIP_INLINE.has(para.text)) continue;
    if (INCREASE_HEADINGS.has(para.text)) { mode = "inc"; continue; }
    if (DECREASE_HEADINGS.has(para.text)) { mode = "dec"; continue; }
    if (ADDITIONAL_INTROS.has(para.text)) {
      // Force a new additional-prose group with this line as intro.
      if (curGroup) additionalGroups.push(curGroup);
      curGroup = { intro: para.text };
      mode = "additional";
      continue;
    }
    if (mode === "desc") {
      // If the source paragraph is a bullet AND it sits inside the
      // description region (no Increase/Decrease seen yet), it's likely a
      // post-description observation list — graduate to additional-prose
      // mode so the bullets are preserved as structure.
      if (para.isBullet) {
        if (descParas.length > 0) {
          // Description ended; bullets begin → start an additional group
          // with the prior description as intro... no wait, description
          // already lives in descParas. We just start a new group with no
          // intro and start collecting bullets.
        }
        if (!curGroup) curGroup = {};
        if (!curGroup.bullets) curGroup.bullets = [];
        curGroup.bullets.push(para.text);
        mode = "additional";
      } else {
        descParas.push(para);
      }
      continue;
    }
    if (mode === "inc") {
      incParas.push(para);
      continue;
    }
    if (mode === "dec") {
      decParas.push(para);
      continue;
    }
    // mode === "additional"
    if (!curGroup) curGroup = {};
    if (para.isBullet) {
      if (!curGroup.bullets) curGroup.bullets = [];
      curGroup.bullets.push(para.text);
    } else if (!curGroup.bullets) {
      // Still in the intro phase (no bullets yet)
      curGroup.intro = curGroup.intro ? `${curGroup.intro}\n${para.text}` : para.text;
    } else {
      // Bullets already exist; subsequent prose closes this group as outro,
      // then we open a fresh group for whatever follows.
      curGroup.outro = curGroup.outro ? `${curGroup.outro}\n${para.text}` : para.text;
    }
  }
  if (curGroup) additionalGroups.push(curGroup);

  const description = descParas.map((p) => p.text).join("\n").trim();
  const increaseCauses = incParas.map((p) => p.text);
  const decreaseCauses = decParas.map((p) => p.text);
  const additionalProse = collapseAdditional(additionalGroups);

  return {
    canonicalName: block.anchor.canonicalName,
    description,
    increaseCauses,
    decreaseCauses,
    additionalProse,
  };
}

function collapseAdditional(
  groups: AdditionalProseBlock[],
): MarkerNarrative["additionalProse"] {
  // Drop completely empty groups.
  const cleaned = groups.filter(
    (g) =>
      (g.intro && g.intro.trim()) ||
      (g.bullets && g.bullets.length > 0) ||
      (g.outro && g.outro.trim()),
  );
  if (cleaned.length === 0) return null;
  if (cleaned.length === 1) return cleaned[0];
  return cleaned;
}

// ----- Serialization -----

function escTpl(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function emitAdditional(prose: MarkerNarrative["additionalProse"]): string {
  if (prose === null) return "null";
  if (typeof prose === "string") return `\`${escTpl(prose)}\``;
  const fmtBlock = (b: AdditionalProseBlock): string => {
    const parts: string[] = ["{"];
    if (b.intro) parts.push(`        intro: \`${escTpl(b.intro)}\`,`);
    if (b.bullets && b.bullets.length > 0) {
      parts.push("        bullets: [");
      for (const it of b.bullets) parts.push(`          \`${escTpl(it)}\`,`);
      parts.push("        ],");
    }
    if (b.outro) parts.push(`        outro: \`${escTpl(b.outro)}\`,`);
    parts.push("      }");
    return parts.join("\n");
  };
  if (Array.isArray(prose)) {
    const blocks = prose.map(fmtBlock).join(",\n      ");
    return `[\n      ${blocks},\n    ]`;
  }
  return fmtBlock(prose);
}

function serialize(
  narratives: Record<string, MarkerNarrative>,
  groups: GroupNarrative[],
): string {
  const lines: string[] = [];
  lines.push("// AUTO-GENERATED by scripts/extract-narratives.ts from the eval-form template.");
  lines.push("// Run `npm run extract:narratives` to regenerate. Hand-edits will be overwritten.");
  lines.push("");
  lines.push('import type { MarkerNarrative, GroupNarrative } from "./types";');
  lines.push("");
  lines.push("export const MARKER_NARRATIVES: Record<string, MarkerNarrative> = {");
  for (const key of Object.keys(narratives).sort()) {
    const n = narratives[key];
    lines.push(`  ${JSON.stringify(key)}: {`);
    lines.push(`    canonicalName: ${JSON.stringify(n.canonicalName)},`);
    lines.push(`    description: \`${escTpl(n.description)}\`,`);
    const inc = JSON.stringify(n.increaseCauses, null, 6).replace(/\n/g, "\n    ");
    const dec = JSON.stringify(n.decreaseCauses, null, 6).replace(/\n/g, "\n    ");
    lines.push(`    increaseCauses: ${inc},`);
    lines.push(`    decreaseCauses: ${dec},`);
    lines.push(`    additionalProse: ${emitAdditional(n.additionalProse)},`);
    lines.push("  },");
  }
  lines.push("};");
  lines.push("");
  lines.push("export const GROUP_NARRATIVES: GroupNarrative[] = [");
  for (const g of groups) {
    lines.push("  {");
    lines.push(`    groupName: ${JSON.stringify(g.groupName)},`);
    lines.push(`    members: ${JSON.stringify(g.members)},`);
    lines.push(`    description: \`${escTpl(g.description)}\`,`);
    lines.push(`    additionalProse: ${g.additionalProse ? "`" + escTpl(g.additionalProse) + "`" : "null"},`);
    lines.push("  },");
  }
  lines.push("];");
  lines.push("");
  return lines.join("\n");
}

// ----- Main -----

async function main() {
  const paras = readDocxParagraphs(TEMPLATE_PATH);
  const blocks = splitBlocks(paras);

  const narratives: Record<string, MarkerNarrative> = {};
  const groups: GroupNarrative[] = [];

  for (const b of blocks) {
    const n = classifyBlock(b);
    narratives[n.canonicalName] = n;

    if (b.anchor.groupName) {
      const members: string[] = [];
      switch (b.anchor.groupName) {
        case "T4": members.push("T4 Total", "T4 Free"); break;
        case "T3": members.push("T3 Total", "T3 Free"); break;
        case "Epstein-Barr":
          members.push("EBV Early Antigen IgG", "EBV Viral Capsid IgM", "EBV Viral Capsid IgG", "EBV Nuclear AG IgG");
          break;
        case "Hs-CRP Cardio IQ": members.push("Hs-CRP"); break;
        default: members.push(b.anchor.canonicalName);
      }
      groups.push({
        groupName: b.anchor.groupName,
        members,
        description: n.description,
        additionalProse:
          typeof n.additionalProse === "string"
            ? n.additionalProse
            : null,
      });
      for (const sibling of members) {
        if (sibling === n.canonicalName) continue;
        if (!narratives[sibling]) {
          narratives[sibling] = {
            canonicalName: sibling,
            description: n.description,
            increaseCauses: [...n.increaseCauses],
            decreaseCauses: [...n.decreaseCauses],
            additionalProse: n.additionalProse,
          };
        }
      }
    }
  }

  // Backfill empty narrative for OPTIMAL_RANGES markers the eval form didn't cover.
  const allCanonical = Object.values(OPTIMAL_RANGES).map((r) => r.canonicalName);
  let backfilled = 0;
  for (const c of allCanonical) {
    if (!narratives[c]) {
      narratives[c] = {
        canonicalName: c,
        description: "",
        increaseCauses: [],
        decreaseCauses: [],
        additionalProse: null,
      };
      backfilled++;
    }
  }

  const out = serialize(narratives, groups);
  fs.writeFileSync(OUTPUT_PATH, out, "utf8");

  // Coverage report.
  const total = allCanonical.length;
  const withDesc = allCanonical.filter((c) => (narratives[c]?.description ?? "").length > 0).length;
  const withCauses = allCanonical.filter(
    (c) => (narratives[c]?.increaseCauses?.length ?? 0) + (narratives[c]?.decreaseCauses?.length ?? 0) > 0,
  ).length;
  const withAdditional = allCanonical.filter((c) => narratives[c]?.additionalProse !== null).length;
  const withStructuredBullets = allCanonical.filter((c) => {
    const ap = narratives[c]?.additionalProse;
    if (!ap || typeof ap === "string") return false;
    const blocks = Array.isArray(ap) ? ap : [ap];
    return blocks.some((b) => b.bullets && b.bullets.length > 0);
  }).length;

  console.log("=== Narrative coverage ===");
  console.log(`Total markers in OPTIMAL_RANGES:           ${total}`);
  console.log(`With description:                          ${withDesc}`);
  console.log(`With increase/decrease bullets:            ${withCauses}`);
  console.log(`With additionalProse (any form):           ${withAdditional}`);
  console.log(`With structured additionalProse bullets:   ${withStructuredBullets}`);
  console.log(`Empty (no eval-form content, backfilled):  ${backfilled}`);
  console.log(`Group narratives written:                  ${groups.length}`);
  console.log("");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
