/**
 * One-off: convert scripts/output/markers.json into lib/ranges/optimal-ranges.ts.
 *
 * - canonicalName preserves the doctor's exact wording from her chart.
 * - aliases combine auto-generated variants (uppercase, parenthetical splits,
 *   etc.) with hand-curated clinical synonyms.
 * - unit and category are populated from override maps below using US lab
 *   conventions (mg/dL, K/uL, etc.) — review/adjust as needed.
 * - optimalRangeBySex is preserved when the chart specified separate M/F ranges.
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface Range {
  min: number | null;
  max: number | null;
}

interface RawMarker {
  canonicalName: string;
  category: string;
  rangeLine: string;
  labRange: Range;
  optimalRange: Range;
  optimalRangeBySex?: { male: Range; female: Range };
  increaseCauses: string[];
  decreaseCauses: string[];
  note?: string;
}

// canonical chart name → slugified category we want to expose
const CATEGORY_SLUG: Record<string, string> = {
  "Overall Blood Health": "hematology",
  "Immune Status": "immune_thyroid", // chart mixes EBV/vitD/thyroid under one heading
  Kidney: "kidney",
  "Liver & Gall Bladder": "liver",
  "Cholesterol, Heart & Vascular Health": "lipid",
  "Blood Sugar Metabolism": "metabolic",
  "Systemic Inflammatory Markers": "inflammation",
  "Vitamins, Minerals, & Electrolytes": "vitamins_minerals",
  "Iron Status": "iron",
  "Gut & Digestive Health": "gut",
  "Cardio IQ Tests": "cardio_iq",
};

// canonicalName → unit. US lab conventions. Empty string = unknown/categorical.
const UNITS: Record<string, string> = {
  "RBC (Red Blood Cell)": "x10E6/uL",
  Hemoglobin: "g/dL",
  Hematocrit: "%",
  "MCV (Mean Corpuscular Volume)": "fL",
  "MCH (Mean Corpuscular Hemoglobin)": "pg",
  "MCHC (Mean Corpuscular Hemoglobin Concentration)": "g/dL",
  "RDW (Red Cell Distribution Width)": "%",
  Platelets: "x10E3/uL",
  "MPV (Mean Platelet Volume)": "fL",
  "WBC (White Blood Cell)": "x10E3/uL",
  Neutrophils: "%",
  Lymphocytes: "%",
  Monocytes: "%",
  Eosinophils: "%",
  Basophils: "%",
  "EBV Early Antigen IgG": "U/mL",
  "EBV Viral Capsid IgM": "U/mL",
  "EBV Viral Capsid IgG": "U/mL",
  "EBV Nuclear AG IgG": "U/mL",
  "Vitamin D 25-OH": "ng/mL",
  "sTSH (Serum Thyroid Stimulating Hormone)": "uIU/mL",
  "T4 Free": "ng/dL",
  "T4 Total": "ug/dL",
  "T3 Free": "pg/mL",
  "T3 Total": "ng/dL",
  "Thyroid Peroxidase": "IU/mL",
  "Thyroglobulin Antibodies": "IU/mL",
  "BUN (Blood Urea Nitrogen)": "mg/dL",
  Creatinine: "mg/dL",
  "BUN/Creatinine Ratio": "",
  "AST (Aspartate Aminotransferase)": "U/L",
  "ALT (Alanine Aminotransferase)": "U/L",
  "Alkaline Phosphatase": "U/L",
  "Total Bilirubin": "mg/dL",
  "Total Protein": "g/dL",
  Albumin: "g/dL",
  "A/G Ratio": "",
  Globulin: "g/dL",
  "GGT (Gamma-Glutamyl Transpeptidase)": "U/L",
  Cholesterol: "mg/dL",
  "LDL (Low Density Lipoprotein Cholesterol)": "mg/dL",
  Triglycerides: "mg/dL",
  "HDL (High Density Lipoprotein)": "mg/dL",
  "Hemoglobin A1C": "%",
  Glucose: "mg/dL",
  Insulin: "uIU/mL",
  "Hs-CRP": "mg/L",
  "LDH (Lactate-Dehydrogenase)": "U/L",
  Calcium: "mg/dL",
  Sodium: "mmol/L",
  Potassium: "mmol/L",
  Chloride: "mmol/L",
  "CO2 (Carbon Dioxide)": "mmol/L",
  Magnesium: "mg/dL",
  "Vitamin B12": "pg/mL",
  Homocysteine: "umol/L",
  Iron: "ug/dL",
  Ferritin: "ng/mL",
  "% Iron Saturation": "%",
  "TIBC (Total Iron Binding Capacity)": "ug/dL",
  Casein: "U/mL",
  Cacao: "U/mL",
  Corn: "U/mL",
  Eggwhite: "U/mL",
  Wheat: "U/mL",
  Yeast: "U/mL",
  "Vitamin B6": "ng/mL",
  "Candida Albicans": "",
  "LDL Particle": "nmol/L",
  "LDL Small": "nmol/L",
  "LDL Medium": "nmol/L",
  "HDL Large": "umol/L",
  "LDL Pattern": "",
  "LDL Peak Size": "Å",
  "Apoliopoprotein B": "mg/dL", // chart's typo preserved as canonicalName
  "Lipoprotein (a)": "nmol/L",
  "LP PLA2 Activity": "nmol/min/mL",
};

// canonicalName → manual clinical synonyms (lab-reported names, common abbreviations,
// alternate spellings). Auto-generated aliases are added on top.
const MANUAL_ALIASES: Record<string, string[]> = {
  "RBC (Red Blood Cell)": ["RBC", "Red Blood Cell", "Red Blood Cell Count", "Erythrocytes"],
  Hemoglobin: ["HGB", "Hgb", "HEMOGLOBIN"],
  Hematocrit: ["HCT", "Hct", "HEMATOCRIT"],
  "MCV (Mean Corpuscular Volume)": ["MCV"],
  "MCH (Mean Corpuscular Hemoglobin)": ["MCH"],
  "MCHC (Mean Corpuscular Hemoglobin Concentration)": ["MCHC"],
  "RDW (Red Cell Distribution Width)": ["RDW", "RDW-CV", "RDW-SD"],
  Platelets: ["PLT", "Platelet Count", "PLATELETS"],
  "MPV (Mean Platelet Volume)": ["MPV"],
  "WBC (White Blood Cell)": ["WBC", "White Blood Cell", "White Blood Cell Count", "Leukocytes"],
  Neutrophils: ["NEUTROPHILS", "Neutrophil %", "Neut", "Neutrophils %", "Neutrophils, Percent"],
  Lymphocytes: ["LYMPHOCYTES", "Lymph", "Lymph %", "Lymphocytes %", "Lymphocytes, Percent"],
  Monocytes: ["MONOCYTES", "Mono", "Mono %", "Monocytes %", "Monocytes, Percent"],
  Eosinophils: ["EOSINOPHILS", "Eos", "Eos %", "Eosinophils %", "Eosinophils, Percent"],
  Basophils: ["BASOPHILS", "Baso", "Baso %", "Basophils %", "Basophils, Percent"],
  "EBV Early Antigen IgG": ["EBV Early Antigen Ab IgG", "Early Antigen IgG", "EA IgG"],
  "EBV Viral Capsid IgM": ["EBV VCA IgM", "Viral Capsid IgM", "VCA IgM"],
  "EBV Viral Capsid IgG": ["EBV VCA IgG", "Viral Capsid IgG", "VCA IgG"],
  "EBV Nuclear AG IgG": ["EBV Nuclear Antigen IgG", "EBNA IgG", "Nuclear AG IgG", "Nuclear Antigen IgG"],
  "Vitamin D 25-OH": [
    "Vitamin D, 25-Hydroxy",
    "25-Hydroxyvitamin D",
    "25-OH Vitamin D",
    "Vit D 25-OH",
    "VITAMIN D, 25-HYDROXY",
    "25(OH)D",
  ],
  "sTSH (Serum Thyroid Stimulating Hormone)": ["TSH", "Thyroid Stimulating Hormone", "TSH, 3rd Generation"],
  "T4 Free": ["Free T4", "FT4", "Free Thyroxine", "T4, Free", "Thyroxine (T4), Free"],
  "T4 Total": ["Total T4", "T4 Total", "Thyroxine", "T4, Total", "Thyroxine (T4)"],
  "T3 Free": ["Free T3", "FT3", "T3, Free", "Triiodothyronine, Free"],
  "T3 Total": ["Total T3", "T3, Total", "Triiodothyronine, Total", "Triiodothyronine"],
  "Thyroid Peroxidase": ["TPO", "TPO Ab", "Thyroid Peroxidase Antibodies", "Anti-TPO"],
  "Thyroglobulin Antibodies": ["TgAb", "Anti-Thyroglobulin", "Thyroglobulin Ab"],
  "BUN (Blood Urea Nitrogen)": ["BUN", "Urea Nitrogen", "Blood Urea Nitrogen"],
  Creatinine: ["CREATININE", "Creat", "Serum Creatinine"],
  "BUN/Creatinine Ratio": ["BUN/Creat Ratio", "BUN:Creatinine"],
  "AST (Aspartate Aminotransferase)": ["AST", "SGOT", "Aspartate Aminotransferase"],
  "ALT (Alanine Aminotransferase)": ["ALT", "SGPT", "Alanine Aminotransferase"],
  "Alkaline Phosphatase": ["ALP", "Alk Phos", "ALKALINE PHOSPHATASE"],
  "Total Bilirubin": ["BILIRUBIN, TOTAL", "Bilirubin, Total", "Tbili"],
  "Total Protein": ["PROTEIN, TOTAL", "Protein, Total", "TP"],
  Albumin: ["ALBUMIN", "Alb"],
  "A/G Ratio": ["Albumin/Globulin Ratio", "A:G Ratio"],
  Globulin: ["GLOBULIN", "Total Globulin"],
  "GGT (Gamma-Glutamyl Transpeptidase)": ["GGT", "Gamma GT", "Gamma-Glutamyltransferase"],
  Cholesterol: ["CHOLESTEROL, TOTAL", "Total Cholesterol", "Cholesterol, Total", "Chol"],
  "LDL (Low Density Lipoprotein Cholesterol)": ["LDL", "LDL-C", "LDL Cholesterol", "LDL Cholesterol Calc", "LDL, Calculated"],
  Triglycerides: ["TRIGLYCERIDES", "TG", "Trig"],
  "HDL (High Density Lipoprotein)": ["HDL", "HDL-C", "HDL Cholesterol"],
  "Hemoglobin A1C": ["HbA1c", "A1c", "Hgb A1c", "HEMOGLOBIN A1C", "Glycated Hemoglobin", "HGBA1C"],
  Glucose: ["GLUCOSE", "Glucose, Fasting", "Fasting Glucose", "Glucose (Fasting)", "FASTING GLUCOSE", "Blood Glucose"],
  Insulin: ["INSULIN", "Fasting Insulin"],
  "Hs-CRP": ["hs-CRP", "High Sensitivity CRP", "C-Reactive Protein, High Sensitivity", "CRP", "C-Reactive Protein"],
  "LDH (Lactate-Dehydrogenase)": ["LDH", "LD", "Lactate Dehydrogenase"],
  Calcium: ["CALCIUM", "Ca"],
  Sodium: ["SODIUM", "Na"],
  Potassium: ["POTASSIUM", "K"],
  Chloride: ["CHLORIDE", "Cl"],
  "CO2 (Carbon Dioxide)": ["CO2", "Carbon Dioxide", "Bicarbonate", "HCO3"],
  Magnesium: ["MAGNESIUM", "Mg", "Mg, Serum"],
  "Vitamin B12": ["VITAMIN B12", "B12", "Cobalamin", "Vit B12"],
  Homocysteine: ["HOMOCYSTEINE", "Homocyst(e)ine"],
  Iron: ["IRON", "Serum Iron", "Fe"],
  Ferritin: ["FERRITIN"],
  "% Iron Saturation": ["Iron Saturation", "Iron Sat", "% Saturation", "Transferrin Saturation", "Tsat"],
  "TIBC (Total Iron Binding Capacity)": ["TIBC", "Total Iron Binding Capacity"],
  Casein: ["Casein IgG"],
  Cacao: ["Cacao IgG", "Cocoa", "Cocoa IgG"],
  Corn: ["Corn IgG"],
  Eggwhite: ["Egg White", "Egg White IgG", "Eggwhite IgG"],
  Wheat: ["Wheat IgG"],
  Yeast: ["Yeast IgG", "Brewers Yeast"],
  "Vitamin B6": ["VITAMIN B6", "B6", "Pyridoxine", "Pyridoxal 5-Phosphate", "P5P"],
  "Candida Albicans": ["Candida Albicans Ab", "Candida IgG"],
  "LDL Particle": ["LDL-P", "LDL Particle Number", "LDL Particles"],
  "LDL Small": ["Small LDL", "Small LDL Particle", "sdLDL"],
  "LDL Medium": ["Medium LDL"],
  "HDL Large": ["Large HDL", "HDL Large Particle"],
  "LDL Pattern": ["LDL Pattern A/B", "Lipoprotein Pattern"],
  "LDL Peak Size": ["LDL Particle Size", "LDL Size"],
  "Apoliopoprotein B": ["Apolipoprotein B", "ApoB", "Apo B"], // chart misspelled — provide correct alias
  "Lipoprotein (a)": ["Lp(a)", "Lipoprotein a", "Lipoprotein(a)"],
  "LP PLA2 Activity": ["Lp-PLA2", "Lp-PLA2 Activity", "PLAC Test"],
};

function generateAutoAliases(name: string): string[] {
  const out = new Set<string>([name]);
  // Strip parenthetical: "RBC (Red Blood Cell)" → "RBC" and "Red Blood Cell"
  const m = name.match(/^(.+?)\s*\(([^)]+)\)\s*(.*)$/);
  if (m) {
    if (m[1].trim()) out.add(m[1].trim());
    if (m[2].trim()) out.add(m[2].trim());
    if (m[3].trim()) out.add((m[1] + " " + m[3]).trim());
  }
  // Case variants
  const variants = Array.from(out);
  for (const v of variants) {
    out.add(v.toUpperCase());
    out.add(v.toLowerCase());
  }
  return Array.from(out);
}

function slugifyKey(name: string): string {
  // RECORD KEY: stable, predictable, lowercase, alphanumeric+underscore.
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function rangeToTs(r: { min: number | null; max: number | null }): string {
  return `{ min: ${r.min === null ? "null" : r.min}, max: ${r.max === null ? "null" : r.max} }`;
}

function stringArrayToTs(arr: string[]): string {
  if (!arr.length) return "[]";
  return "[\n      " + arr.map((s) => JSON.stringify(s)).join(",\n      ") + ",\n    ]";
}

function main() {
  const markers: RawMarker[] = JSON.parse(
    fs.readFileSync(path.resolve("scripts/output/markers.json"), "utf8"),
  );

  const lines: string[] = [];
  lines.push(
    "// AUTO-GENERATED from samples/templates/Copy of BW Evaluation Form - google doc.docx",
    "// via scripts/parse-chart.ts → scripts/generate-ranges-ts.ts. Hand-edits are fine;",
    "// re-running the generator will overwrite this file.",
    "//",
    "// canonicalName preserves the doctor's exact wording from her master chart",
    "// (including the 'Apoliopoprotein B' typo). The Apolipoprotein B correct spelling",
    "// is included as an alias.",
    "",
    "export interface MarkerRange {",
    "  canonicalName: string;",
    "  aliases: string[];",
    "  unit: string;",
    "  labRange: { min: number | null; max: number | null };",
    "  optimalRange: { min: number | null; max: number | null };",
    "  optimalRangeBySex?: {",
    "    male: { min: number | null; max: number | null };",
    "    female: { min: number | null; max: number | null };",
    "  };",
    "  category: string;",
    "  increaseCauses: string[];",
    "  decreaseCauses: string[];",
    "  note?: string;",
    "}",
    "",
    "export const OPTIMAL_RANGES: Record<string, MarkerRange> = {",
  );

  const usedKeys = new Set<string>();

  for (const m of markers) {
    let key = slugifyKey(m.canonicalName);
    let i = 2;
    while (usedKeys.has(key)) key = `${slugifyKey(m.canonicalName)}_${i++}`;
    usedKeys.add(key);

    const auto = generateAutoAliases(m.canonicalName);
    const manual = MANUAL_ALIASES[m.canonicalName] ?? [];
    const aliases = Array.from(new Set([...auto, ...manual])).sort();

    const unit = UNITS[m.canonicalName] ?? "";
    const category = CATEGORY_SLUG[m.category] ?? "uncategorized";

    lines.push(`  ${key}: {`);
    lines.push(`    canonicalName: ${JSON.stringify(m.canonicalName)},`);
    lines.push(`    aliases: ${stringArrayToTs(aliases)},`);
    lines.push(`    unit: ${JSON.stringify(unit)},`);
    lines.push(`    labRange: ${rangeToTs(m.labRange)},`);
    lines.push(`    optimalRange: ${rangeToTs(m.optimalRange)},`);
    if (m.optimalRangeBySex) {
      lines.push(`    optimalRangeBySex: {`);
      lines.push(`      male: ${rangeToTs(m.optimalRangeBySex.male)},`);
      lines.push(`      female: ${rangeToTs(m.optimalRangeBySex.female)},`);
      lines.push(`    },`);
    }
    lines.push(`    category: ${JSON.stringify(category)},`);
    lines.push(`    increaseCauses: ${stringArrayToTs(m.increaseCauses)},`);
    lines.push(`    decreaseCauses: ${stringArrayToTs(m.decreaseCauses)},`);
    if (m.note) lines.push(`    note: ${JSON.stringify(m.note)},`);
    lines.push(`  },`);
  }

  lines.push("};", "");
  lines.push("// Reverse lookup: given any alias (case-insensitive), find the canonical record.");
  lines.push("const ALIAS_INDEX = (() => {");
  lines.push("  const idx = new Map<string, MarkerRange>();");
  lines.push("  for (const rec of Object.values(OPTIMAL_RANGES)) {");
  lines.push("    idx.set(rec.canonicalName.toLowerCase(), rec);");
  lines.push("    for (const a of rec.aliases) idx.set(a.toLowerCase(), rec);");
  lines.push("  }");
  lines.push("  return idx;");
  lines.push("})();");
  lines.push("");
  lines.push("export function findMarker(name: string): MarkerRange | undefined {");
  lines.push("  return ALIAS_INDEX.get(name.toLowerCase().trim());");
  lines.push("}");
  lines.push("");

  const out = path.resolve("lib/ranges/optimal-ranges.ts");
  fs.writeFileSync(out, lines.join("\n"));
  console.log(`Wrote ${markers.length} markers → ${path.relative(process.cwd(), out)}`);
}

main();
