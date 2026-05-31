/**
 * One-shot narrative extractor: reads Melissa's eval-form template, splits
 * into per-marker sections by matching marker-name anchors, and writes
 * lib/narratives/marker-narratives.ts as a TypeScript object literal.
 *
 * Run via: npm run extract:narratives
 *
 * Re-runnable. Re-runs overwrite the generated file. The output is then
 * checked in so callers don't need to re-extract at runtime.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import mammoth from "mammoth";
import { OPTIMAL_RANGES } from "../lib/ranges/optimal-ranges";
import type { MarkerNarrative, GroupNarrative } from "../lib/narratives/types";

const TEMPLATE_PATH = path.resolve(
  __dirname,
  "../samples/templates/Copy of BW Evaluation Form - USE THIS '26 - google doc.docx",
);
const OUTPUT_PATH = path.resolve(
  __dirname,
  "../lib/narratives/marker-narratives.ts",
);

// ----- Marker anchor table -----
// Maps the exact text that appears as a marker header in the eval form to the
// canonicalName from OPTIMAL_RANGES. The extractor finds these as anchor
// lines, then captures content between them.
//
// Some markers have sub-rows under a parent name (T3 Free / Total, hormones,
// Cardio IQ). For those we anchor on the parent and let the per-marker
// renderer share the captured block.

interface Anchor {
  /** Exact line text (stripped) that triggers a new block. */
  matchText: string;
  /** OPTIMAL_RANGES canonicalName to attribute the block to. */
  canonicalName: string;
  /** Optional grouping — when set, the block is added under GroupNarrative
   *  with the given groupName instead of (or in addition to) a per-marker
   *  entry. */
  groupName?: string;
  /** Some anchors share a single block with siblings. The first sibling
   *  acts as the "owner" of the captured narrative; the rest just inherit
   *  the description via groupName cross-reference. */
  inheritFromGroup?: boolean;
}

const ANCHORS: Anchor[] = [
  // ----- Overall Blood Health -----
  { matchText: "RBC (Red Blood Cell)", canonicalName: "RBC (Red Blood Cell)" },
  { matchText: "Hemoglobin", canonicalName: "Hemoglobin" },
  { matchText: "Hematocrit", canonicalName: "Hematocrit" },
  { matchText: "MCV (Mean Corpuscular Volume)", canonicalName: "MCV (Mean Corpuscular Volume)" },
  { matchText: "MCH (Mean Corpuscular Hemoglobin)", canonicalName: "MCH (Mean Corpuscular Hemoglobin)" },
  { matchText: "MCHC (Mean Corpuscular Hemoglobin Concentration)", canonicalName: "MCHC (Mean Corpuscular Hemoglobin Concentration)" },
  { matchText: "RDW (Red Cell Distribution Width)", canonicalName: "RDW (Red Cell Distribution Width)" },
  { matchText: "Platelets", canonicalName: "Platelets" },
  { matchText: "MPV (Mean Platelet Volume)", canonicalName: "MPV (Mean Platelet Volume)" },

  // ----- Immune Status -----
  { matchText: "WBC (White Blood Cell)", canonicalName: "WBC (White Blood Cell)" },
  { matchText: "Neutrophils", canonicalName: "Neutrophils" },
  { matchText: "Lymphocytes", canonicalName: "Lymphocytes" },
  { matchText: "Monocytes", canonicalName: "Monocytes" },
  { matchText: "Eosinophils", canonicalName: "Eosinophils" },
  { matchText: "Basophils", canonicalName: "Basophils" },

  // ----- EBV panel — shared narrative; we treat the group header as the
  //       anchor and assign the captured description to all 4 markers. -----
  { matchText: "Epstein-Barr", canonicalName: "EBV Early Antigen IgG", groupName: "Epstein-Barr" },

  // ----- Vitamin D -----
  { matchText: "Vitamin D 25-OH", canonicalName: "Vitamin D 25-OH" },

  // ----- ANA — Result-only template row, no narrative -----
  { matchText: "ANA (Anti-nuclear Antibodies)", canonicalName: "ANA (Anti-nuclear Antibodies)" },

  // ----- Thyroid -----
  { matchText: "sTSH (Serum Thyroid Stimulating Hormone)", canonicalName: "sTSH (Serum Thyroid Stimulating Hormone)" },
  // T4 and T3 share a block in the eval form ("Serum Thyroxine (T4) Free and Total" has
  // a paragraph + combined Increase/Decrease). We anchor on the parent for T4 Total
  // (the primary), and copy to T4 Free post-extraction.
  { matchText: "Serum Thyroxine (T4) Free and Total", canonicalName: "T4 Total", groupName: "T4" },
  { matchText: "Triiodothryonine (T3) Free and Total", canonicalName: "T3 Total", groupName: "T3" },
  { matchText: "Thyroid Peroxidase", canonicalName: "Thyroid Peroxidase" },
  { matchText: "Thyroglobulin Antibodies", canonicalName: "Thyroglobulin Antibodies" },

  // ----- Kidney -----
  { matchText: "BUN (Blood Urea Nitrogen)", canonicalName: "BUN (Blood Urea Nitrogen)" },
  { matchText: "Creatinine", canonicalName: "Creatinine" },
  { matchText: "BUN/Creatinine Ratio", canonicalName: "BUN/Creatinine Ratio" },

  // ----- Liver -----
  { matchText: "AST (Aspartate Aminotransferase)", canonicalName: "AST (Aspartate Aminotransferase)" },
  { matchText: "ALT (Alanine Aminotransferase)", canonicalName: "ALT (Alanine Aminotransferase)" },
  { matchText: "Alkaline Phosphatase", canonicalName: "Alkaline Phosphatase" },
  { matchText: "Total Bilirubin", canonicalName: "Total Bilirubin" },
  { matchText: "Total Protein", canonicalName: "Total Protein" },
  { matchText: "Albumin", canonicalName: "Albumin" },
  { matchText: "A/G Ratio", canonicalName: "A/G Ratio" },
  { matchText: "Globulin", canonicalName: "Globulin" },
  { matchText: "GGT (Gamma-Glutamyl Transpeptidase)", canonicalName: "GGT (Gamma-Glutamyl Transpeptidase)" },

  // ----- Cholesterol -----
  { matchText: "Cholesterol", canonicalName: "Cholesterol" },
  { matchText: "LDL (Low Density Lipoprotein Cholesterol)", canonicalName: "LDL (Low Density Lipoprotein Cholesterol)" },
  { matchText: "Triglycerides", canonicalName: "Triglycerides" },
  { matchText: "HDL (High Density Lipoprotein)", canonicalName: "HDL (High Density Lipoprotein)" },

  // ----- Blood sugar -----
  { matchText: "Hemoglobin A1C", canonicalName: "Hemoglobin A1C" },
  { matchText: "Glucose", canonicalName: "Glucose" },
  { matchText: "Insulin", canonicalName: "Insulin" },

  // ----- Inflammation -----
  { matchText: "Hs-CRP", canonicalName: "Hs-CRP" },
  { matchText: "LDH (Lactate-Dehydrogenase)", canonicalName: "LDH (Lactate-Dehydrogenase)" },

  // ----- Electrolytes / minerals -----
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

  // ----- Iron -----
  { matchText: "Iron", canonicalName: "Iron" },
  { matchText: "Ferritin", canonicalName: "Ferritin" },
  { matchText: "% Iron Saturation", canonicalName: "% Iron Saturation" },
  { matchText: "TIBC (Total Iron Binding Capacity)", canonicalName: "TIBC (Total Iron Binding Capacity)" },

  // ----- Gut / digestion (Food Sensitivities is a group, no per-marker prose) -----
  { matchText: "Vitamin B6", canonicalName: "Vitamin B6" },
  { matchText: "Candida Albicans", canonicalName: "Candida Albicans" },

  // ----- Misc tests -----
  { matchText: "Rheumatoid Factor", canonicalName: "Rheumatoid Factor" },
  { matchText: "Lead", canonicalName: "Lead Venous" },
  { matchText: "Mercury", canonicalName: "Mercury Blood" },
  { matchText: "Leptin", canonicalName: "Leptin" },
  { matchText: "Amylase:", canonicalName: "Amylase" },
  { matchText: "Lipase:", canonicalName: "Lipase" },
  // Cortisol: appears twice in eval form (Blood+Saliva block and a later
  // standalone). We anchor the FIRST occurrence; the second is identical
  // template data with no new prose, so we skip it.
  { matchText: "Cortisol", canonicalName: "Cortisol" },

  // ----- Cardio IQ Tests (rich per-marker prose) -----
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

// Lines we treat as stop markers — end of PART I.
const STOP_TEXT = "PART II: Summary of Results";

// Result-line pattern: skip these when capturing description / bullets.
const RESULT_LINE_RE = /^\s*(?:[A-Za-z()%/ -]+?:\s*)?\(?(?:[HLN])?\)?\s*Result\b/i;

// Group-section headings we ignore as anchors but recognize as boundaries.
const GROUP_HEADINGS = new Set<string>([
  "Overall Blood Health",
  "Immune Status",
  " Thyroid", // leading space in source
  "Thyroid",
  "Kidney",
  "Liver & Gall Bladder",
  "Cholesterol, Heart & Vascular Health",
  "Blood Sugar Metabolism",
  "Systemic Inflammatory Markers",
  "Vitamins, Minerals, & Electrolytes",
  "Iron Status",
  "Gut & Digestive Health",
  "Food Sensitivities",
  "Miscellaneous Tests",
  "Hormones",
  "Estrogens & Female:",
  "Testosterones and PSA:",
  "Cardio IQ Tests",
  "Cardio IQ Tests ",
  "PART 1: Lab Values and Data Analysis",
]);

// Cycle-phase hormone sub-rows that have unambiguous label tokens. We
// recognize these as boundary markers so the previous block ends cleanly,
// but they don't get their own narrative (the group header carries it).
// "Total:" and "Free:" are deliberately EXCLUDED — they also appear inside
// T4/T3 blocks ("Free:  Result: ..." / "Total: Result: ...") and would
// otherwise kill the description capture. Hormone Total/Free sub-rows are
// already kept out by the group-heading boundary that precedes them.
const HORMONE_SUBROW_RE = /^(Estrone|Estradiol|Estriol|Progesterone|FSH|LH|Prolactin|Pregnenolone|Bioavailable|SHBG|DHEAs|PSA%|PSA Total|PSA Free):\s*Result/;

function isAnchorLine(line: string): Anchor | null {
  const trimmed = line.trim();
  for (const a of ANCHORS) {
    if (trimmed === a.matchText) return a;
  }
  return null;
}

function isBoundaryLine(line: string): boolean {
  const trimmed = line.trim();
  if (GROUP_HEADINGS.has(line) || GROUP_HEADINGS.has(trimmed)) return true;
  if (HORMONE_SUBROW_RE.test(trimmed)) return true;
  return false;
}

interface RawBlock {
  anchor: Anchor;
  lines: string[];
}

function splitBlocks(text: string): RawBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: RawBlock[] = [];
  let current: RawBlock | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (trimmed === STOP_TEXT) break;

    const anchor = isAnchorLine(rawLine);
    if (anchor) {
      // Skip the second Cortisol occurrence — same canonicalName already
      // captured. The check is "is there already a block for this canonical
      // name AND this anchor.matchText is the same as the previous match".
      const dup = blocks.find((b) => b.anchor.canonicalName === anchor.canonicalName);
      if (dup) {
        current = null; // skip this block
        continue;
      }
      current = { anchor, lines: [] };
      blocks.push(current);
      continue;
    }

    if (isBoundaryLine(rawLine)) {
      current = null;
      continue;
    }

    if (current) current.lines.push(trimmed);
  }

  return blocks;
}

// Bullet-style headings that switch the parser into bullet mode.
const INCREASE_HEADINGS = new Set<string>([
  "Increase:",
  "Increased:",
  "Increase",
  "Increased",
  "Increased Direct:",
  "Increased Indirect:",
]);
const DECREASE_HEADINGS = new Set<string>([
  "Decrease:",
  "Decreased:",
  "Decrease",
  "Decreased",
]);
const SKIP_INLINE_HEADINGS = new Set<string>([
  "T3 and T4:",
  "Educational Information only:",
  "Recommended Treatment for MTHFR Mutation:",
]);

function classifyBlock(block: RawBlock): MarkerNarrative {
  const descLines: string[] = [];
  const incLines: string[] = [];
  const decLines: string[] = [];
  const additionalLines: string[] = [];

  type Mode = "desc" | "inc" | "dec" | "additional";
  let mode: Mode = "desc";
  // Once we've left the increase/decrease block AND seen non-bullet prose,
  // anything further is additionalProse.
  let sawAdditionalTrigger = false;

  for (const line of block.lines) {
    if (RESULT_LINE_RE.test(line)) continue; // Result row — skip
    if (INCREASE_HEADINGS.has(line)) {
      mode = "inc";
      continue;
    }
    if (DECREASE_HEADINGS.has(line)) {
      mode = "dec";
      continue;
    }
    if (SKIP_INLINE_HEADINGS.has(line)) {
      // For MTHFR: the rest of the block is additional educational/treatment
      // prose, not bullets.
      mode = "additional";
      sawAdditionalTrigger = true;
      additionalLines.push(line);
      continue;
    }

    if (mode === "desc") {
      descLines.push(line);
      continue;
    }
    if (mode === "inc" || mode === "dec") {
      // Heuristic: lines that look like long prose paragraphs (long sentences,
      // colons, parenthesized sub-clauses) AFTER increase/decrease bullets
      // often signal additional commentary. We keep them as bullets unless
      // we've already moved into "additional" mode.
      const dest = mode === "inc" ? incLines : decLines;
      dest.push(line);
      continue;
    }
    additionalLines.push(line);
  }

  return {
    canonicalName: block.anchor.canonicalName,
    description: descLines.join("\n").trim(),
    increaseCauses: incLines,
    decreaseCauses: decLines,
    additionalProse: additionalLines.length > 0 ? additionalLines.join("\n").trim() : null,
  };
}

function escapeForLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
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
    lines.push(`    description: \`${escapeForLiteral(n.description)}\`,`);
    lines.push(`    increaseCauses: ${JSON.stringify(n.increaseCauses, null, 6).replace(/\n/g, "\n    ")},`);
    lines.push(`    decreaseCauses: ${JSON.stringify(n.decreaseCauses, null, 6).replace(/\n/g, "\n    ")},`);
    if (n.additionalProse) {
      lines.push(`    additionalProse: \`${escapeForLiteral(n.additionalProse)}\`,`);
    } else {
      lines.push(`    additionalProse: null,`);
    }
    lines.push("  },");
  }
  lines.push("};");
  lines.push("");
  lines.push("export const GROUP_NARRATIVES: GroupNarrative[] = [");
  for (const g of groups) {
    lines.push("  {");
    lines.push(`    groupName: ${JSON.stringify(g.groupName)},`);
    lines.push(`    members: ${JSON.stringify(g.members)},`);
    lines.push(`    description: \`${escapeForLiteral(g.description)}\`,`);
    if (g.additionalProse) {
      lines.push(`    additionalProse: \`${escapeForLiteral(g.additionalProse)}\`,`);
    } else {
      lines.push(`    additionalProse: null,`);
    }
    lines.push("  },");
  }
  lines.push("];");
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const buf = fs.readFileSync(TEMPLATE_PATH);
  const result = await mammoth.extractRawText({ buffer: buf });
  const text = result.value;

  const blocks = splitBlocks(text);

  // Classify each block. Some are group-owned (T4, T3, EBV, Cardio IQ Hs-CRP)
  // — those become both a per-marker entry on the owning canonicalName AND a
  // group entry (so renderer can use whichever is more appropriate).
  const narratives: Record<string, MarkerNarrative> = {};
  const groups: GroupNarrative[] = [];

  for (const b of blocks) {
    const n = classifyBlock(b);
    narratives[n.canonicalName] = n;

    if (b.anchor.groupName) {
      // Build a group entry. Group members = the anchor's owner + known
      // siblings. We populate siblings explicitly per group.
      const members: string[] = [];
      switch (b.anchor.groupName) {
        case "T4":
          members.push("T4 Total", "T4 Free");
          break;
        case "T3":
          members.push("T3 Total", "T3 Free");
          break;
        case "Epstein-Barr":
          members.push(
            "EBV Early Antigen IgG",
            "EBV Viral Capsid IgM",
            "EBV Viral Capsid IgG",
            "EBV Nuclear AG IgG",
          );
          break;
        case "Hs-CRP Cardio IQ":
          members.push("Hs-CRP");
          break;
        default:
          members.push(b.anchor.canonicalName);
      }
      groups.push({
        groupName: b.anchor.groupName,
        members,
        description: n.description,
        additionalProse: n.additionalProse,
      });

      // Copy the captured narrative onto sibling members (T4 Free, T3 Free,
      // and the 3 sibling EBV markers) so the renderer doesn't have to
      // cross-reference groups for the common case.
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

  // Backfill empty MarkerNarrative entries for every OPTIMAL_RANGES marker
  // that the eval form didn't cover. The Word generator renders these with
  // result + range only and a "[Clinical interpretation pending]" placeholder.
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
  const withAdditional = allCanonical.filter((c) => narratives[c]?.additionalProse).length;
  const fullyEmpty = backfilled;

  console.log("=== Narrative coverage ===");
  console.log(`Total markers in OPTIMAL_RANGES:       ${total}`);
  console.log(`With description:                      ${withDesc}`);
  console.log(`With increase/decrease bullets:        ${withCauses}`);
  console.log(`With additionalProse:                  ${withAdditional}`);
  console.log(`Empty (no eval-form content, backfill): ${fullyEmpty}`);
  console.log(`Group narratives written:              ${groups.length}`);
  console.log("");
  console.log("=== Markers WITHOUT eval-form narrative (backfilled empty) ===");
  for (const c of allCanonical) {
    if (
      (narratives[c]?.description ?? "").length === 0 &&
      (narratives[c]?.increaseCauses?.length ?? 0) === 0 &&
      (narratives[c]?.decreaseCauses?.length ?? 0) === 0 &&
      !narratives[c]?.additionalProse
    ) {
      console.log(`  • ${c}`);
    }
  }
  console.log("");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
