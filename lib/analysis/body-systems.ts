/**
 * Body-system taxonomy for the Clinical Analysis report.
 *
 * Melissa reads a panel by system, not by the dictionary's internal `category`
 * slugs, so the analysis chart groups markers under the headings below in
 * clinical reading order. This module is presentation-only: it decides which
 * heading a marker prints under and nothing else. It never reads a value, a
 * range, or a flag, and it is never consulted by the flagging engine.
 *
 * Identity is the marker's `canonicalName` — the same string
 * lib/ranges/optimal-ranges.ts stores on each record and lib/matcher stamps
 * onto every MatchedMarker — NOT the raw label printed on the PDF. Lookup is
 * case- and whitespace-insensitive as a safety net; anything unrecognised
 * (an unmatched marker, a prior-report-only name) falls through to
 * "Additional Markers" so a marker can never be silently dropped.
 *
 * TO EDIT: move a canonical name between the lists in SYSTEM_MARKERS below.
 * That constant is the single source of truth; the reverse index is derived
 * from it at module load. lib/analysis/body-systems.test.ts fails if a name
 * here is unknown to the dictionary, is listed twice, or if a dictionary
 * marker is left unmapped.
 */

import type { FlaggedMarker } from "../flagging";

/** Print order for the report. "Additional Markers" is the catch-all and is
 *  always last. */
export const BODY_SYSTEMS = [
  "Iron Status",
  "Immune Status / CBC",
  "Blood Sugar & Insulin Metabolism",
  "Cholesterol, Heart & Vascular Health",
  "Thyroid",
  "Hormones & Adrenal",
  "Liver & Gall Bladder",
  "Kidney",
  "Vitamins, Minerals & Electrolytes",
  "Food Sensitivity Panel",
  "Additional Markers",
] as const;

export type BodySystem = (typeof BODY_SYSTEMS)[number];

/** The catch-all bucket. Kept as a named constant so callers never hardcode it. */
export const CATCH_ALL_SYSTEM: BodySystem = "Additional Markers";

/**
 * Canonical marker name -> body system, grouped by system for editing.
 *
 * Every marker in OPTIMAL_RANGES appears exactly once. Several placements
 * follow the doctor's reading order rather than the dictionary's `category`
 * slug — the CBC differential rides with the CBC, serum electrolytes ride with
 * the metabolic panel under Liver & Kidney, and uric acid and homocysteine sit
 * where they are clinically read rather than where the chart filed them.
 */
export const SYSTEM_MARKERS: Record<BodySystem, readonly string[]> = {
  "Iron Status": [
    "Iron",
    "Ferritin",
    "% Iron Saturation",
    "TIBC (Total Iron Binding Capacity)",
  ],

  "Immune Status / CBC": [
    // Red cell line and indices
    "RBC (Red Blood Cell)",
    "Hemoglobin",
    "Hematocrit",
    "MCV (Mean Corpuscular Volume)",
    "MCH (Mean Corpuscular Hemoglobin)",
    "MCHC (Mean Corpuscular Hemoglobin Concentration)",
    "RDW (Red Cell Distribution Width)",
    // Platelets
    "Platelets",
    "MPV (Mean Platelet Volume)",
    // White cell count and differential — the CBC is read as one panel, so the
    // percentage and absolute differentials stay with WBC.
    "WBC (White Blood Cell)",
    "Neutrophils",
    "Lymphocytes",
    "Monocytes",
    "Eosinophils",
    "Basophils",
    "Absolute Neutrophils",
    "Absolute Lymphocytes",
    "Absolute Monocytes",
    "Absolute Eosinophils",
    "Absolute Basophils",
    // Blood typing
    "ABO Group",
    // Cell-turnover / hemolysis
    "LDH (Lactate-Dehydrogenase)",
    // Autoimmune
    "ANA (Anti-nuclear Antibodies)",
    "Rheumatoid Factor",
    // Viral / infectious burden
    "EBV Early Antigen IgG",
    "EBV Viral Capsid IgM",
    "EBV Viral Capsid IgG",
    "EBV Nuclear AG IgG",
    "Candida Albicans",
  ],

  "Blood Sugar & Insulin Metabolism": [
    "Glucose",
    "Insulin",
    "Hemoglobin A1C",
    "Leptin",
  ],

  "Cholesterol, Heart & Vascular Health": [
    // Standard lipid panel
    "Cholesterol",
    "LDL (Low Density Lipoprotein Cholesterol)",
    "HDL (High Density Lipoprotein)",
    "Non-HDL Cholesterol",
    "Triglycerides",
    "Cholesterol/HDL Ratio",
    // Advanced lipid / Cardio IQ
    "LDL Particle",
    "LDL Small",
    "LDL Medium",
    "HDL Large",
    "LDL Pattern",
    "LDL Peak Size",
    "Apoliopoprotein B",
    "Lipoprotein (a)",
    "LP PLA2 Activity",
    // Fatty acids
    "EPA",
    "DHA",
    "DPA",
    "Omega-3 Total",
    "Omega-6 Total",
    "Omega-3 Index (EPA+DPA+DHA)",
    "Omega-6/Omega-3 Ratio",
    "Arachidonic Acid",
    "Arachidonic Acid/EPA Ratio",
    "Linoleic Acid",
    "Omega Check",
    // Vascular inflammation and risk
    "Hs-CRP",
    "Homocysteine",
  ],

  Thyroid: [
    "sTSH (Serum Thyroid Stimulating Hormone)",
    "T4 Free",
    "T4 Total",
    "T3 Free",
    "T3 Total",
    "Thyroid Peroxidase",
    "Thyroglobulin Antibodies",
  ],

  "Hormones & Adrenal": [
    // Adrenal / precursors
    "Cortisol",
    "Pregnenolone",
    "DHEA Sulfate",
    "Progesterone",
    // Androgens and their carrier
    "Testosterone Total",
    "Testosterone Free",
    "Testosterone Bioavailable",
    "SHBG (Sex Hormone Binding Globulin)",
    // Estrogens
    "Estrogens",
    "Estradiol (E2)",
    "Estrone (E1)",
    "Estriol (E3)",
    // Pituitary drivers and ovarian reserve
    "LH (Luteinizing Hormone)",
    "FSH (Follicle Stimulating Hormone)",
    "Prolactin",
    "AMH (Anti-Mullerian Hormone)",
    // Prostate — androgen-dependent, read alongside the male hormone panel
    "PSA Total",
    "PSA Free",
    "PSA % Free",
  ],

  "Liver & Gall Bladder": [
    "AST (Aspartate Aminotransferase)",
    "ALT (Alanine Aminotransferase)",
    "Alkaline Phosphatase",
    "GGT (Gamma-Glutamyl Transpeptidase)",
    "Total Bilirubin",
    "Total Protein",
    "Albumin",
    "Globulin",
    "A/G Ratio",
    // Pancreatic enzymes — reported on the same hepatic/abdominal panel
    "Amylase",
    "Lipase",
  ],

  Kidney: [
    "BUN (Blood Urea Nitrogen)",
    "Creatinine",
    "BUN/Creatinine Ratio",
    "eGFR",
    "Albumin Urine",
    "Specific Gravity",
    "Urine pH",
    // Serum electrolytes — read with renal function on the metabolic panel
    "Sodium",
    "Potassium",
    "Chloride",
    "CO2 (Carbon Dioxide)",
    // Purine handling — renal clearance driven
    "Uric Acid",
  ],

  "Vitamins, Minerals & Electrolytes": [
    // Vitamin D
    "Vitamin D 25-OH",
    "Vitamin D 1,25 (OH)2 Total",
    "Vitamin D2",
    "Vitamin D3",
    // B vitamins and methylation
    "Vitamin B12",
    "Methylmalonic Acid",
    "Vitamin B6",
    "MTHFR",
    // Minerals
    "Calcium",
    "Magnesium",
    "Magnesium RBC",
    "Zinc",
    // Toxic elements — elemental analysis, reported with the mineral panel
    "Lead Venous",
    "Mercury Blood",
  ],

  "Food Sensitivity Panel": [
    "Casein",
    "Cacao",
    "Corn",
    "Eggwhite",
    "Wheat",
    "Yeast",
  ],

  // Catch-all. Nothing in the dictionary is filed here on purpose; it exists so
  // an unmatched marker, or a name carried in from a prior report, still prints.
  "Additional Markers": [],
};

/** Lookup key: case-folded, whitespace-collapsed canonical name. */
function lookupKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Reverse index, derived from SYSTEM_MARKERS at module load. */
const SYSTEM_BY_MARKER: ReadonlyMap<string, BodySystem> = (() => {
  const index = new Map<string, BodySystem>();
  for (const system of BODY_SYSTEMS) {
    for (const name of SYSTEM_MARKERS[system]) {
      index.set(lookupKey(name), system);
    }
  }
  return index;
})();

/**
 * Body system for a canonical marker name. Anything unmapped — an unmatched
 * marker, a name carried in from a prior report — lands in the catch-all.
 */
export function systemForMarker(canonicalName: string): BodySystem {
  return SYSTEM_BY_MARKER.get(lookupKey(canonicalName)) ?? CATCH_ALL_SYSTEM;
}

export interface BodySystemGroup<T> {
  system: BodySystem;
  items: T[];
}

/**
 * Generic bucketer: groups anything into the taxonomy given a way to read its
 * canonical name. Systems come back in BODY_SYSTEMS order, empty ones omitted,
 * and input order is preserved inside each system so the caller's own
 * deterministic sort survives the grouping.
 */
export function groupBySystem<T>(
  items: readonly T[],
  canonicalNameOf: (item: T) => string,
): Array<BodySystemGroup<T>> {
  const buckets = new Map<BodySystem, T[]>();
  for (const item of items) {
    const system = systemForMarker(canonicalNameOf(item));
    const bucket = buckets.get(system);
    if (bucket) bucket.push(item);
    else buckets.set(system, [item]);
  }
  return BODY_SYSTEMS.filter((s) => buckets.has(s)).map((system) => ({
    system,
    items: buckets.get(system)!,
  }));
}

/**
 * Group flagged markers by body system, in taxonomy order, omitting systems
 * with no markers. No marker is ever dropped: an unmapped canonical name goes
 * to "Additional Markers".
 */
export function groupMarkersBySystem(
  markers: readonly FlaggedMarker[],
): Array<BodySystemGroup<FlaggedMarker>> {
  return groupBySystem(markers, (m) => m.canonicalName);
}
