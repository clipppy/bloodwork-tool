/**
 * Table-formatting helpers for the analysis chart. Same house pattern as the
 * other tests here: a self-contained tsx script with a local ok(), non-zero
 * exit on failure.
 *
 * These functions decide what the Marker, Functional/Optimal, and Status
 * columns actually print, and which severity tier a row is charted under. They are pure string transforms over what
 * deterministic.ts computed — they never touch a value or re-derive a flag —
 * so they are cheap to pin down and expensive to get wrong silently.
 *
 * Run: npx tsx lib/generator/analysis-format.test.ts  (or: npm run test:analysis-format)
 */

import mammoth from "mammoth";
import {
  CHART_TIERS,
  TIER_LABELS,
  shortMarkerName,
  displayOptimalRange,
  generateAnalysisReport,
  generateReevalReport,
  groupByTier,
  noteFor,
  statusChip,
  tierForChartRow,
  tierForComparisonRow,
} from "./analysis-word";
import { OPTIMAL_RANGES } from "../ranges/optimal-ranges";
import type { MatchedMarker } from "../matcher";
import { flagMarkers } from "../flagging";
import {
  buildChartRows,
  buildDeterministicAnalysis,
  buildOptimalRows,
} from "../analysis/deterministic";
import { groupBySystem, systemForMarker } from "../analysis/body-systems";
import { toAnalysisNarrative, toReevalNarrative } from "../analysis/prompt";
import { buildPayload, serializePayload, assertNoIdentifiers } from "../analysis/deidentify";
import type { InitialNarrativeJson, ReevalNarrativeJson } from "../analysis/schemas";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else failures.push(`  x ${msg}`);
}
const eq = (actual: string, expected: string, label: string) =>
  ok(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

function main() {
  // ----- shortMarkerName: strip a TRAILING expansion only -----
  eq(shortMarkerName("MCV (Mean Corpuscular Volume)"), "MCV", "MCV expansion stripped");
  eq(shortMarkerName("RBC (Red Blood Cell)"), "RBC", "RBC expansion stripped");
  eq(shortMarkerName("TIBC (Total Iron Binding Capacity)"), "TIBC", "TIBC expansion stripped");
  eq(shortMarkerName("sTSH (Serum Thyroid Stimulating Hormone)"), "sTSH", "sTSH expansion stripped");
  eq(shortMarkerName("Estradiol (E2)"), "Estradiol", "two-char qualifier stripped");
  eq(shortMarkerName("Omega-3 Index (EPA+DPA+DHA)"), "Omega-3 Index", "composition note stripped");
  // Guards — the paren is part of the name, or not trailing.
  eq(shortMarkerName("Lipoprotein (a)"), "Lipoprotein (a)", "one-char qualifier KEPT");
  eq(shortMarkerName("Vitamin D 1,25 (OH)2 Total"), "Vitamin D 1,25 (OH)2 Total", "non-trailing paren KEPT");
  eq(shortMarkerName("Alkaline Phosphatase"), "Alkaline Phosphatase", "no paren, unchanged");
  eq(shortMarkerName("eGFR"), "eGFR", "bare name unchanged");
  eq(shortMarkerName("  Hemoglobin  "), "Hemoglobin", "trimmed");

  // Never empties a name, and never collides two dictionary markers onto one label.
  const shorts = new Map<string, string[]>();
  for (const rec of Object.values(OPTIMAL_RANGES)) {
    const s = shortMarkerName(rec.canonicalName);
    ok(s.trim().length > 0, `shortMarkerName never empty (${rec.canonicalName})`);
    const list = shorts.get(s) ?? [];
    list.push(rec.canonicalName);
    shorts.set(s, list);
  }
  const collisions = [...shorts.entries()].filter(([, names]) => names.length > 1);
  ok(
    collisions.length === 0,
    `no two markers share a short name (${collisions
      .map(([s, names]) => `${s} <- ${names.join(" / ")}`)
      .join("; ")})`,
  );

  // ----- displayOptimalRange -----
  eq(displayOptimalRange("65–99", "80–95"), "80–95", "distinct optimal kept");
  eq(displayOptimalRange("< 130", "< 130 (lab range)"), "—", "lab-range echo collapsed");
  eq(displayOptimalRange("0.2–1.2", "0.2–1.2"), "—", "identical range collapsed");
  eq(displayOptimalRange("> 6729", "≥ 6729"), "—", "strict vs inclusive same threshold collapsed");
  eq(displayOptimalRange("< 5.7", "< 5"), "< 5", "different cutoff kept");
  eq(displayOptimalRange("30–100", ""), "—", "empty optimal renders em dash");
  // Three-tier bands compact to their target band.
  eq(
    displayOptimalRange("< 1138", "Optimal: [−∞, 1138)  |  Moderate: [1138, 1409)  |  High: [1409, +∞)"),
    "—",
    "band target equal to lab cutoff collapsed",
  );
  eq(
    displayOptimalRange("— ", "Optimal: [−∞, 215)  |  Moderate: [215, 301)  |  High: [301, +∞)"),
    "< 215",
    "upper-bounded band compacted",
  );
  eq(
    displayOptimalRange("—", "High: [−∞, 5353)  |  Moderate: [5353, 6729)  |  Optimal: [6729, +∞)"),
    "≥ 6729",
    "lower-bounded band compacted",
  );
  eq(
    displayOptimalRange("—", "Negative: [−∞, 18)  |  Equivocal: [18, 22)  |  Positive: [22, +∞)"),
    "< 18",
    "serology band uses the Negative tier",
  );
  eq(
    displayOptimalRange("—", "Moderate: [1, 3)  |  High: [3, +∞)"),
    "Moderate: [1, 3)  |  High: [3, +∞)",
    "no target tier: full string kept rather than inventing one",
  );

  // ----- statusChip: two short lines, colour follows the lab range -----
  const RED = "C00000";
  const AMBER = "B26A00";
  const GREEN = "2E7D32";
  const NEW = "4A5B6E";

  // Outside the lab range -> red, "Out of Lab Range" + direction.
  const high = statusChip("HIGH", false);
  eq(high.label, "Out of Lab Range", "HIGH label");
  eq(high.direction, "(High)", "HIGH direction");
  eq(high.fill, RED, "HIGH is red");
  const low = statusChip("LOW", false);
  eq(low.label, "Out of Lab Range", "LOW label");
  eq(low.direction, "(Low)", "LOW direction");
  eq(low.fill, RED, "LOW is red");

  // Inside the lab range -> amber, "Out of Optimal" + direction.
  const above = statusChip("ABOVE OPTIMAL*", true);
  eq(above.label, "Out of Optimal", "ABOVE OPTIMAL label");
  eq(above.direction, "(High)", "ABOVE OPTIMAL direction");
  eq(above.fill, AMBER, "above-optimal is amber");
  const sub = statusChip("SUBOPTIMAL*", true);
  eq(sub.label, "Out of Optimal", "SUBOPTIMAL label");
  eq(sub.direction, "(Low)", "SUBOPTIMAL direction is Low");
  eq(sub.fill, AMBER, "below-optimal is amber");
  eq(statusChip("BORDERLINE HIGH*", true).direction, "(High)", "borderline high keeps direction");
  eq(statusChip("BORDERLINE LOW*", true).direction, "(Low)", "borderline low keeps direction");
  eq(statusChip("BORDERLINE LOW*", true).label, "Out of Optimal", "borderline low label");

  // Statuses that genuinely carry no direction must not invent one.
  eq(statusChip("MODERATE", false).direction, "", "MODERATE has no direction");
  eq(statusChip("MODERATE", false).fill, RED, "moderate outside lab range is red");
  eq(statusChip("MODERATE*", true).fill, AMBER, "asterisked moderate is amber");
  eq(statusChip("OUT OF RANGE", false).direction, "", "OUT OF RANGE has no direction");
  eq(statusChip("OUT OF RANGE", false).label, "Out of Lab Range", "OUT OF RANGE label");

  // A value with no usable lab range is treated as outside it, as before.
  eq(statusChip("HIGH", null).fill, RED, "null withinLabRange is red");

  // Re-eval vocabulary.
  eq(statusChip("In Range", true).label, "In Range", "re-eval In Range label");
  eq(statusChip("In Range", true).fill, GREEN, "re-eval In Range is green");
  eq(statusChip("Out of Lab Range", false).label, "Out of Lab Range", "re-eval lab-range label");
  eq(statusChip("Out of Lab Range", false).fill, RED, "re-eval lab-range is red");
  eq(statusChip("Out of Optimal", true).label, "Out of Optimal", "re-eval optimal label");
  eq(statusChip("Out of Optimal", true).fill, AMBER, "re-eval optimal is amber");

  // Re-eval carries the engine's flagDirection through, since its status
  // wording has none. Same chip vocabulary as initial mode.
  eq(statusChip("Out of Optimal", true, "high").direction, "(High)", "re-eval carries High");
  eq(statusChip("Out of Optimal", true, "low").direction, "(Low)", "re-eval carries Low");
  eq(statusChip("Out of Optimal", true, null).direction, "", "re-eval null direction stays blank");
  eq(statusChip("Out of Optimal", true).direction, "", "re-eval omitted direction stays blank");
  eq(statusChip("Out of Lab Range", false, "low").direction, "(Low)", "re-eval lab-range carries Low");
  eq(statusChip("Out of Lab Range", false, "high").label, "Out of Lab Range", "carrying a direction does not change the label");
  // A carried direction must never contradict the wording when the wording says.
  eq(statusChip("HIGH", false, "low").direction, "(High)", "status wording wins over a carried direction");
  eq(statusChip("SUBOPTIMAL*", true, "high").direction, "(Low)", "SUBOPTIMAL wording wins");
  // Non-directional verdicts stay non-directional whatever is carried.
  eq(statusChip("In Range", true, "high").direction, "", "In Range never takes a direction");
  eq(statusChip("Not retested", null, "low").direction, "", "Not retested never takes a direction");
  eq(statusChip("New Finding", null, "high").direction, "", "New Finding never takes a direction");
  eq(statusChip("Not retested", null).label, "Not retested", "not-retested label");
  eq(statusChip("New Finding", null).label, "New Finding", "new-finding label");
  eq(statusChip("New Finding", null).fill, NEW, "new-finding is the neutral blue-gray");
  // The green tier's own rows (deterministic status "OPTIMAL").
  eq(statusChip("OPTIMAL", true).label, "Optimal", "OPTIMAL label");
  eq(statusChip("OPTIMAL", true).fill, GREEN, "OPTIMAL is green");
  eq(statusChip("OPTIMAL", true).direction, "", "OPTIMAL has no direction");

  // ----- Severity tiers: the chart's primary grouping -----
  ok(CHART_TIERS.join(",") === "outside-lab,outside-optimal,optimal", "tier order is red, amber, green");
  eq(TIER_LABELS["outside-lab"], "Outside Lab Reference Range", "tier A label");
  eq(TIER_LABELS["outside-optimal"], "Inside Lab Range, Outside Functional Optimal", "tier B label");
  eq(TIER_LABELS.optimal, "Optimal — What's Working", "tier C label");

  // Initial-mode rows: the tier follows the same rule as the chip colour.
  eq(tierForChartRow({ status: "HIGH", withinLabRange: false }), "outside-lab", "HIGH outside lab -> red tier");
  eq(tierForChartRow({ status: "LOW", withinLabRange: false }), "outside-lab", "LOW outside lab -> red tier");
  eq(tierForChartRow({ status: "MODERATE", withinLabRange: null }), "outside-lab", "no usable lab range -> red tier");
  eq(tierForChartRow({ status: "ABOVE OPTIMAL*", withinLabRange: true }), "outside-optimal", "ABOVE OPTIMAL* -> amber tier");
  eq(tierForChartRow({ status: "BORDERLINE LOW*", withinLabRange: true }), "outside-optimal", "BORDERLINE LOW* -> amber tier");
  eq(tierForChartRow({ status: "MODERATE*", withinLabRange: true }), "outside-optimal", "MODERATE* -> amber tier");
  eq(tierForChartRow({ status: "OPTIMAL", withinLabRange: true }), "optimal", "OPTIMAL -> green tier");
  // Tier and chip colour can never disagree, across the whole vocabulary.
  const fillOf = { "outside-lab": RED, "outside-optimal": AMBER, optimal: GREEN } as const;
  for (const v of ["HIGH", "LOW", "MODERATE", "MODERATE*", "OUT OF RANGE", "OUT OF RANGE*", "ABOVE OPTIMAL*", "SUBOPTIMAL*", "BORDERLINE HIGH*", "BORDERLINE LOW*", "OPTIMAL"]) {
    for (const within of [true, false, null] as const) {
      const tier = tierForChartRow({ status: v, withinLabRange: within });
      ok(statusChip(v, within).fill === fillOf[tier], `tier ${tier} matches chip colour for "${v}" / ${within}`);
    }
  }

  // Re-eval rows: the tier is read off the comparison vocabulary.
  eq(String(tierForComparisonRow({ status: "Out of Lab Range", withinLabRange: false })), "outside-lab", "re-eval lab-range -> red tier");
  eq(String(tierForComparisonRow({ status: "Out of Optimal", withinLabRange: true })), "outside-optimal", "re-eval optimal -> amber tier");
  eq(String(tierForComparisonRow({ status: "In Range", withinLabRange: true })), "optimal", "re-eval In Range -> green tier");
  ok(tierForComparisonRow({ status: "Not retested", withinLabRange: null }) === null, "Not retested belongs to no tier");

  // groupByTier: every tier present (even empty), tier order, row order kept.
  const grouped = groupByTier(
    [
      { marker: "b", status: "OPTIMAL", withinLabRange: true },
      { marker: "a", status: "HIGH", withinLabRange: false },
      { marker: "c", status: "SUBOPTIMAL*", withinLabRange: true },
      { marker: "d", status: "LOW", withinLabRange: false },
    ],
    tierForChartRow,
  );
  eq(grouped.map((g) => g.tier).join(","), "outside-lab,outside-optimal,optimal", "groupByTier returns the tiers in order");
  eq(grouped[0].items.map((r) => r.marker).join(","), "a,d", "red tier keeps input order");
  eq(grouped[1].items.map((r) => r.marker).join(","), "c", "amber tier");
  eq(grouped[2].items.map((r) => r.marker).join(","), "b", "green tier");
  const empties = groupByTier([{ marker: "x", status: "HIGH", withinLabRange: false }], tierForChartRow);
  ok(empties.length === 3 && empties[1].items.length === 0 && empties[2].items.length === 0, "empty tiers are still returned");
  ok(groupByTier([{ s: "Not retested" }], (r) => tierForComparisonRow({ status: r.s, withinLabRange: null })).every((g) => g.items.length === 0), "tierless rows are dropped from the tiers");

  // ----- End to end through the engine: flagged rows + optimal rows -> tiers,
  // with body-system order inside each tier -----
  const matched = (canonicalName: string, value: number, unit: string, referenceRangeRaw: string): MatchedMarker => ({
    rawName: canonicalName.toUpperCase(), canonicalName, value, unit, labFlagFromPdf: null, referenceRangeRaw,
    referenceNoteRaw: null, optimalRange: null, matchStatus: "matched", matchConfidence: "exact",
    confirmationPending: false, confirmationSource: null, source: "body", notes: [],
  });
  const flagged = flagMarkers(
    [
      matched("Glucose", 120, "mg/dL", "65-99"), // outside lab (high)
      matched("Hemoglobin", 13.8, "g/dL", "11.1-15.9"), // optimal
      matched("Vitamin D 25-OH", 31, "ng/mL", "30-100"), // in lab, below optimal
      matched("Ferritin", 5, "ng/mL", "16-232"), // outside lab (low)
      matched("Platelets", 250, "Thousand/uL", "140-400"), // optimal
    ],
    { sex: "female" },
  );
  const flaggedRows = buildChartRows(flagged);
  const optimalRows = buildOptimalRows(flagged);
  ok(flaggedRows.length === 3, `engine flags 3 of 5 (got ${flaggedRows.length}: ${flaggedRows.map((r) => r.marker).join(", ")})`);
  ok(optimalRows.length === 2, `2 optimal rows (got ${optimalRows.length}: ${optimalRows.map((r) => r.marker).join(", ")})`);
  ok(optimalRows.every((r) => r.status === "OPTIMAL" && r.withinLabRange === true), "optimal rows carry status OPTIMAL inside the lab range");
  ok(optimalRows.every((r) => /\d/.test(r.result) && r.labRange !== "—"), "optimal rows carry a result and the lab range");
  ok(!flaggedRows.some((r) => optimalRows.some((o) => o.marker === r.marker)), "no marker is both flagged and optimal");
  const e2e = groupByTier([...flaggedRows, ...optimalRows], tierForChartRow);
  eq(e2e[0].items.map((r) => r.marker).sort().join(","), "Ferritin,Glucose", "red tier: Ferritin + Glucose");
  eq(e2e[1].items.map((r) => r.marker).join(","), "Vitamin D 25-OH", "amber tier: Vitamin D");
  eq(e2e[2].items.map((r) => r.marker).sort().join(","), "Hemoglobin,Platelets", "green tier: Hemoglobin + Platelets");
  // Body-system order is preserved inside a tier: groups come out in taxonomy
  // order, and every row lands under its own system.
  for (const g of e2e) {
    const groups = groupBySystem(g.items, (r) => r.marker);
    ok(groups.every((sg) => sg.items.every((r) => systemForMarker(r.marker) === sg.system)), `tier ${g.tier}: rows sit under their body system`);
  }

  // Every chip line must fit the status column. The columns are sized for 16
  // characters at 9pt Arial bold; the direction is a separate line, never a wrap.
  const LABEL_MAX = 16;
  const vocabulary = [
    "HIGH", "LOW", "MODERATE", "MODERATE*", "OUT OF RANGE", "OUT OF RANGE*",
    "ABOVE OPTIMAL*", "SUBOPTIMAL*", "BORDERLINE HIGH*", "BORDERLINE LOW*",
    "OPTIMAL", "In Range", "Out of Lab Range", "Out of Optimal", "Not retested",
    "New Finding",
  ];
  for (const v of vocabulary) {
    for (const within of [true, false, null] as const) {
      for (const carried of [undefined, null, "high", "low"] as const) {
      const chip = statusChip(v, within, carried);
      ok(
        chip.label.length <= LABEL_MAX,
        `chip label "${chip.label}" (from "${v}") is ${chip.label.length} chars, over the ${LABEL_MAX}-char budget`,
      );
      ok(!chip.label.includes("\n"), `chip label "${chip.label}" is single-line`);
      ok(
        chip.direction === "" || chip.direction === "(High)" || chip.direction === "(Low)",
        `chip direction "${chip.direction}" (from "${v}") is one of "", "(High)", "(Low)"`,
      );
      // A direction only ever accompanies an out-of-range verdict.
      ok(
        chip.direction === "" ||
          chip.label === "Out of Lab Range" ||
          chip.label === "Out of Optimal",
        `direction "${chip.direction}" attached to unexpected label "${chip.label}"`,
      );
      }
    }
  }

  // ----- noteFor: join by canonical name, tolerant of harmless respellings -----
  const notes = new Map([
    ["Glucose", "Glucose note."],
    ["MCV (Mean Corpuscular Volume)", "MCV note."],
    ["ferritin", "Ferritin note."],
  ]);
  eq(noteFor(notes, "Glucose"), "Glucose note.", "exact canonical name joins");
  eq(noteFor(notes, "MCV (Mean Corpuscular Volume)"), "MCV note.", "exact long name joins");
  eq(noteFor(notes, "Ferritin"), "Ferritin note.", "case-insensitive name joins");
  eq(noteFor(new Map([["MCV", "short note."]]), "MCV (Mean Corpuscular Volume)"), "short note.", "short display name joins");
  eq(noteFor(notes, "Hemoglobin"), "", "no note -> blank, never an error");
  eq(noteFor(new Map(), "Glucose"), "", "empty map -> blank");

  // ----- End to end: the document joins each note to its own row -----
  return renderChecks().then(() => finish());
}

async function renderChecks() {
  const matched = (canonicalName: string, value: number, unit: string, referenceRangeRaw: string): MatchedMarker => ({
    rawName: canonicalName.toUpperCase(), canonicalName, value, unit, labFlagFromPdf: null, referenceRangeRaw,
    referenceNoteRaw: null, optimalRange: null, matchStatus: "matched", matchConfidence: "exact",
    confirmationPending: false, confirmationSource: null, source: "body", notes: [],
  });
  const flagged = flagMarkers(
    [
      matched("Glucose", 120, "mg/dL", "65-99"), // tier A
      matched("Ferritin", 5, "ng/mL", "16-232"), // tier A
      matched("Vitamin D 25-OH", 31, "ng/mL", "30-100"), // tier B
      matched("Hemoglobin", 13.8, "g/dL", "11.1-15.9"), // tier C
    ],
    { sex: "female" },
  );
  const analysis = buildDeterministicAnalysis(flagged, {
    patientName: "Jane Q Doe",
    patientDate: "2026-04-10",
    dob: "1980-01-02",
    sex: "female",
  });
  const GLUCOSE_NOTE = "Glucose is the sugar in your blood. Yours is running higher than we like to see.";
  const VITD_NOTE = "Vitamin D is the sunshine vitamin. Yours is in range but lower than ideal for energy and immune health.";
  const pattern = { pattern: "Blood sugar drifting up", bullets: ["Your fasting sugar is higher than we like to see."], symptomTags: [], relevanceToChiefConcern: "Fits the afternoon dip." };
  const phase = { phase: "Phase 1 - Foundation (Weeks 1-4)", goal: "Stabilize.", bullets: ["Protein-forward breakfast."] };
  const summary = { whatsGoingWell: "Much of this looks solid.", likelyDrivers: "Blood sugar swings.", planInPlainLanguage: "Breakfast first, then retest." };
  // Ferritin deliberately has NO note; the cell must simply be blank.
  const initialJson: InitialNarrativeJson = {
    chiefConcern: "persistent fatigue",
    clinicalPresentation: ["Reports afternoon fatigue."],
    reassuringNarrative: "Hemoglobin (13.8 g/dL) argues against anemia.",
    rootCauseAnalysis: [pattern],
    phasedProtocol: [phase],
    patientSummary: summary,
    markerInterpretations: [
      { marker: "Glucose", note: GLUCOSE_NOTE },
      { marker: "Vitamin D 25-OH", note: VITD_NOTE },
    ],
  };
  const text = async (buf: Buffer) => (await mammoth.extractRawText({ buffer: buf })).value;

  const doc = await text(await generateAnalysisReport(analysis, toAnalysisNarrative(initialJson)));
  ok(doc.includes("2. Lab Findings by Severity"), "docx: section 2 heading renamed");
  ok(!doc.includes("Markers Outside Standard Lab Range"), "docx: old section 2 heading gone");
  ok(doc.includes("Interpretation"), "docx: Interpretation column header present");
  ok(doc.includes(GLUCOSE_NOTE) && doc.includes(VITD_NOTE), "docx: both notes rendered");
  // Row order in the extracted text: a note sits after its own marker and
  // before the next marker's name, so it is in that marker's row.
  const chartText = doc.slice(doc.indexOf("2. Lab Findings by Severity"), doc.indexOf("3. Root Cause Analysis"));
  const at = (needle: string) => chartText.indexOf(needle);
  // A note is in its marker's row when it follows that marker's name with no
  // other marker's name in between.
  const inRowOf = (text: string, marker: string, note: string, others: string[]) => {
    const m = text.indexOf(marker);
    const n = text.indexOf(note);
    if (m < 0 || n < m) return false;
    const between = text.slice(m + marker.length, n);
    return others.every((o) => !between.includes(o));
  };
  ok(inRowOf(chartText, "Glucose", GLUCOSE_NOTE, ["Ferritin", "Vitamin D", "Hemoglobin"]), "docx: Glucose note sits in the Glucose row");
  ok(inRowOf(chartText, "Vitamin D", VITD_NOTE, ["Ferritin", "Glucose", "Hemoglobin"]), "docx: Vitamin D note sits in the Vitamin D row");
  ok(at("Ferritin") >= 0 && !chartText.slice(at("Ferritin"), at("Glucose")).includes("note"), "docx: Ferritin (no note) renders with a blank cell");
  ok(at(GLUCOSE_NOTE) < at(TIER_LABELS["outside-optimal"]) && at(VITD_NOTE) > at(TIER_LABELS["outside-optimal"]), "docx: notes stay inside their tiers");
  ok(at("Hemoglobin") > at(TIER_LABELS.optimal), "docx: in-range marker is in the green tier, with no note column");
  ok(!doc.includes("Reassuring markers within both standard and functional optimal ranges"), "docx: old reassuring paragraph block removed");
  ok(!doc.includes("All other markers within range"), "docx: old 'all other markers' line removed");
  ok(doc.includes("argues against anemia"), "docx: the model's reassuring narrative paragraph is kept");
  ok(doc.includes("3. Root Cause Analysis") && doc.includes("Blood sugar drifting up"), "docx: section 3 root cause is still rendered (notes are additive)");

  // Without a narrative every Interpretation cell is blank and nothing throws.
  const bare = await text(await generateAnalysisReport(analysis, null));
  ok(bare.includes("Interpretation") && !bare.includes(GLUCOSE_NOTE), "docx: placeholder document has the column, blank cells");

  // Re-eval: same join, on the comparison rows.
  const reevalJson: ReevalNarrativeJson = {
    chiefConcern: "persistent fatigue",
    priorMarkers: [{ name: "Glucose", priorValue: "112 mg/dL", comparable: true }],
    overview: ["The prior panel flagged glucose."],
    comparativeRootCause: [pattern],
    updatedProtocol: [{ ...phase, bullets: ["CONTINUE: protein-forward breakfast."] }],
    alreadyImproving: [],
    backgroundFindings: [],
    patientSummary: summary,
    markerInterpretations: [{ marker: "Glucose", note: GLUCOSE_NOTE }],
  };
  const reeval = await text(await generateReevalReport(analysis, true, toReevalNarrative(reevalJson), "2025-10-01"));
  ok(reeval.includes("Part II: Lab Findings by Severity"), "reeval docx: Part II heading renamed");
  ok(reeval.includes("Interpretation") && reeval.includes(GLUCOSE_NOTE), "reeval docx: note joined to the comparison row");
  const partII = reeval.slice(reeval.indexOf("Part II"), reeval.indexOf("Part III"));
  ok(inRowOf(partII, "Glucose", GLUCOSE_NOTE, ["Ferritin", "Vitamin D", "Hemoglobin"]), "reeval docx: Glucose note in the Glucose row");

  // The de-identified payload is built from the engine output only: the
  // notes never flow into it, and the identifier guard still passes.
  const payload = buildPayload(flagged, { age: 46, sex: "female", intake: "Jane Q Doe reports fatigue.", patientName: "Jane Q Doe", dob: "1980-01-02" });
  const serialized = serializePayload(payload);
  let threw = false;
  try {
    assertNoIdentifiers(serialized, { patientName: "Jane Q Doe", dob: "1980-01-02" });
  } catch {
    threw = true;
  }
  ok(!threw, "payload: identifier guard still passes");
  ok(!serialized.includes(GLUCOSE_NOTE) && !("markerInterpretations" in payload), "payload: notes are output, never input");
  ok(payload.flaggedMarkers.map((m) => m.name).sort().join(",") === "Ferritin,Glucose,Vitamin D 25-OH", "payload: flaggedMarkers = tiers A + B, the set the notes cover");
}

function finish() {
  if (failures.length > 0) {
    console.error(`\nanalysis-format: ${failures.length} FAILED, ${passed} passed\n`);
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(`analysis-format: all ${passed} assertions passed`);
}

main();
