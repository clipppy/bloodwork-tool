/**
 * Line-level regression tests for the Quest parser, built from the verbatim
 * line sequences a real report printed (pdf-parse text, identifiers removed).
 * Same house pattern as the other tests: self-contained tsx script, local
 * ok(), non-zero exit on failure.
 *
 * Case 1 — Quest Lab Services Manager layout (LOINC code after the name, the
 * column label "Reference Range:" inline, a result-status token "FINAL" at the
 * end of every row). Before the fix: rows with no inline range (FSH, INSULIN,
 * LH) failed the structural check and were DROPPED, their "Reference Range"
 * blocks were appended to the last marker that did parse (DHEA SULFATE), and
 * the range parser recovered the one segment that parsed — Insulin's
 * "< or = 18.4" — as DHEA Sulfate's lab range. Rows that did parse kept the
 * "Reference Range:" label and "FINAL" inside the range text, so their own
 * printed range never parsed and the dictionary's hardcoded range stood in.
 *
 * Case 2 — Estrone with a stratified reference table under a multi-word
 * header ("Adult Female Reference Ranges for Estrone:"). The header was
 * skipped as furniture, so the marker printed no range at all.
 *
 * Run: npx tsx lib/parsers/quest.test.ts  (or: npm run test:quest-parser)
 */

import { parseQuestText } from "./quest";
import { matchMarkers } from "../matcher";
import { flagMarkers } from "../flagging";
import { applyHormoneOverlay } from "../analysis/hormone-ranges";
import {
  formatLabRange,
  formatOptimalRange,
  formatStatus,
  labVerdict,
  markerTier,
} from "../analysis/deterministic";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else failures.push(`  x ${msg}`);
}
const eq = (actual: unknown, expected: unknown, label: string) =>
  ok(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

// Verbatim line sequence (tabs as printed) from the real report: the DHEA-S
// row, then FSH / INSULIN / LH whose rows carry no inline range and print
// their reference blocks underneath. The Cholesterol row is from the same
// layout, one page earlier.
const LSM_LAYOUT = [
  "Test\tIn Range\tOut Of Range\tReference Range\tLab",
  "CHOLESTEROL, TOTAL (2093-3) \t205 H \tReference Range: <200 mg/dL \tFINAL",
  "TRIGLYCERIDES (2571-8) \t80 \tReference Range: <150 mg/dL \tFINAL",
  "HDL (2085-9) \t95 \tmg/dL \tFINAL",
  "CHOL/HDLC RATIO (9830-1) \t2.2 \tReference Range: <5.0 (calc) \tFINAL",
  "Lab: NL1\tDHEA SULFATE \tFINAL",
  "Analyte \tValue",
  "DHEA SULFATE (2191-5) \t46 \tReference Range: 15-205 mcg/dL \tFINAL",
  "Lab: NL1\tFSH \tFINAL",
  "Analyte \tValue",
  "FSH (15067-2) \t21.1 \tmIU/mL \tFINAL",
  "Reference Range",
  "Follicular Phase \t2.5-10.2",
  "Mid-cycle Peak \t3.1-17.7",
  "Luteal Phase \t1.5- 9.1",
  "Postmenopausal \t23.0-116.3",
  "Lab: NL1\tINSULIN \tFINAL",
  "Analyte \tValue",
  "INSULIN (20448-7) \t5.2 \tuIU/mL \tFINAL",
  "Reference Range < or = 18.4",
  "Risk:",
  "Optimal \t< or = 18.4",
  "Moderate \tNA",
  "High \t>18.4",
  "Adult cardiovascular event risk category",
  "cut points (optimal, moderate, high)",
  "are based on Insulin Reference Interval",
  "studies performed at Quest Diagnostics",
  "in 2022.",
  "Lab: NL1\tLH \tFINAL",
  "Analyte \tValue",
  "LH (10501-5) \t10.0 \tmIU/mL \tFINAL",
  "Reference Range",
  "Follicular Phase 1.9-12.5",
  "Mid-Cycle Peak \t8.7-76.3",
  "Luteal Phase \t0.5-16.9",
  "Postmenopausal \t10.0-54.7",
].join("\n");

// Verbatim from the same report's first page (the classic Quest layout).
const ESTRONE_BLOCK = [
  "Test Name In Range Out Of Range Reference Range Lab",
  "ESTROGENS, FRACTIONATED, LC/MS",
  "ESTRONE 19 pg/mL EZ",
  "Adult Female Reference Ranges for Estrone:",
  "Follicular Phase: 10-138 pg/mL",
  "Luteal Phase: 16-173 pg/mL",
  "Postmenopausal Phase: < or = 65 pg/mL",
  "Pediatric Female Reference Ranges for Estrone:",
  "Pre-pubertal",
  "(1-9 years): < or = 34 pg/mL",
  "10-11 years: < or = 72 pg/mL",
  "12-14 years: < or = 75 pg/mL",
  "15-17 years: < or = 188 pg/mL",
  "This test was developed and its analytical performance",
  "characteristics have been determined by Quest Diagnostics.",
  "It has not been cleared or approved by the FDA. This assay",
  "has been validated pursuant to the CLIA regulations and is",
  "used for clinical purposes.",
].join("\n");

function one<T extends { rawName: string }>(markers: T[], rawName: string): T | undefined {
  const hits = markers.filter((m) => m.rawName === rawName);
  eq(hits.length, 1, `exactly one "${rawName}" row`);
  return hits[0];
}

function labServicesManagerLayout() {
  const parsed = parseQuestText(LSM_LAYOUT);
  const byRaw = parsed.markers;

  // ----- Every row parses, including the ones with no inline range -----
  const dhea = one(byRaw, "DHEA SULFATE (2191-5)");
  const fsh = one(byRaw, "FSH (15067-2)");
  const insulin = one(byRaw, "INSULIN (20448-7)");
  const lh = one(byRaw, "LH (10501-5)");
  const chol = one(byRaw, "CHOLESTEROL, TOTAL (2093-3)");
  const trig = one(byRaw, "TRIGLYCERIDES (2571-8)");
  const hdl = one(byRaw, "HDL (2085-9)");
  const ratio = one(byRaw, "CHOL/HDLC RATIO (9830-1)");
  if (!dhea || !fsh || !insulin || !lh || !chol || !trig || !hdl || !ratio) return;

  // Furniture never becomes a marker.
  ok(!byRaw.some((m) => /^Lab:/.test(m.rawName) || /^Analyte/.test(m.rawName)), "'Lab: NL1 ... FINAL' and 'Analyte Value' lines are not markers");
  ok(!byRaw.some((m) => /^(Optimal|Moderate|High)$/.test(m.rawName)), "Insulin's risk band rows are not markers");

  // ----- DHEA Sulfate carries ITS OWN printed range, and only that -----
  eq(dhea.value, 46, "DHEA-S value");
  eq(dhea.unit, "mcg/dL", "DHEA-S unit read from the inline range text");
  eq(dhea.referenceRangeRaw, "15-205", "DHEA-S range is the row's own figures, without the column label or FINAL");
  ok(!/18\.4/.test(dhea.referenceRangeRaw ?? ""), "Insulin's '< or = 18.4' is NOT on DHEA-S");
  ok(!/Follicular|Luteal|Postmenopausal/.test(dhea.referenceRangeRaw ?? ""), "FSH/LH phase rows are NOT on DHEA-S");
  ok(!dhea.referenceNoteRaw, `no phase table is attached to DHEA-S (got ${JSON.stringify(dhea.referenceNoteRaw)})`);

  // ----- The next rows own their reference blocks -----
  eq(fsh.value, 21.1, "FSH value");
  eq(fsh.unit, "mIU/mL", "FSH unit (FINAL no longer sits where the unit is read)");
  ok(/Follicular Phase\s+2\.5-10\.2/.test(fsh.referenceRangeRaw ?? ""), `FSH phase table is on FSH (got ${JSON.stringify(fsh.referenceRangeRaw)})`);
  ok(!/1\.9-12\.5/.test(fsh.referenceRangeRaw ?? ""), "LH's follicular row is not on FSH");

  eq(insulin.value, 5.2, "Insulin value");
  eq(insulin.unit, "uIU/mL", "Insulin unit");
  ok(/^< or = 18\.4/.test(insulin.referenceRangeRaw ?? ""), `Insulin keeps its own '< or = 18.4' (got ${JSON.stringify(insulin.referenceRangeRaw)})`);

  eq(lh.value, 10, "LH value");
  ok(/1\.9-12\.5/.test(lh.referenceRangeRaw ?? ""), `LH phase table is on LH (got ${JSON.stringify(lh.referenceRangeRaw)})`);

  // ----- Rows WITH an inline range: label and status token are stripped -----
  eq(chol.value, 205, "Cholesterol value");
  eq(chol.labFlagFromPdf, "H", "Cholesterol keeps the lab's H");
  eq(chol.unit, "mg/dL", "Cholesterol unit");
  eq(chol.referenceRangeRaw, "<200", "Cholesterol printed range");
  eq(trig.referenceRangeRaw, "<150", "Triglycerides printed range");
  eq(hdl.unit, "mg/dL", "HDL (no inline range) still parses with its unit");
  eq(ratio.referenceRangeRaw, "<5.0", "Chol/HDL ratio printed range");
  eq(ratio.unit, "(calc)", "Chol/HDL ratio keeps the (calc) qualifier");

  // ----- Through the engine: printed ranges drive the lab tier -----
  const flagged = flagMarkers(matchMarkers(parsed.markers), { sex: "female" });
  const f = (name: string) => flagged.find((m) => m.canonicalName === name);

  const fDhea = f("DHEA Sulfate");
  ok(!!fDhea, "DHEA-S matched");
  if (fDhea) {
    eq(fDhea.labRangeSource, "printed", "DHEA-S lab range came off the report");
    eq(JSON.stringify(fDhea.effectiveLabRange), JSON.stringify({ min: 15, max: 205 }), "DHEA-S effective lab range is 15-205");
    eq(formatLabRange(fDhea), "15–205", "DHEA-S Lab Range cell");
  }
  const fIns = f("Insulin");
  ok(!!fIns, "Insulin matched");
  if (fIns) {
    eq(JSON.stringify(fIns.effectiveLabRange), JSON.stringify({ min: null, max: 18.4 }), "Insulin effective lab range is <= 18.4");
    eq(formatLabRange(fIns), "≤ 18.4", "Insulin Lab Range cell");
    eq(markerTier(fIns), "outside-optimal", "Insulin 5.2 (optimal <5, lab <= 18.4) is the amber tier");
  }
  const fChol = f("Cholesterol");
  ok(!!fChol, "Cholesterol matched");
  if (fChol) {
    eq(JSON.stringify(fChol.effectiveLabRange), JSON.stringify({ min: null, max: 200 }), "Cholesterol lab range is the printed <200, not the hardcoded 125-200");
    eq(formatLabRange(fChol), "< 200", "Cholesterol Lab Range cell");
    eq(fChol.flagStatus, "optimal", "engine reads 205 as inside the 150-220 functional window (unchanged)");
    eq(labVerdict(fChol), false, "...but the lab range excludes it");
    eq(markerTier(fChol), "outside-lab", "Cholesterol 205 charts in the red tier (lab range first)");
    eq(formatStatus(fChol, labVerdict(fChol)), "HIGH", "Cholesterol status reads HIGH");
  }

  // ----- With the female overlay (the analysis path) -----
  const overlay = applyHormoneOverlay(flagged, {
    sex: "female",
    status: "early_follicular",
    cycleLength: null,
    cycleDay: null,
  });
  const oDhea = overlay.markers.find((m) => m.canonicalName === "DHEA Sulfate");
  if (oDhea) {
    eq(formatLabRange(oDhea), "15–205", "DHEA-S Lab Range cell after the overlay");
    eq(formatOptimalRange(oDhea), "150–300", "DHEA-S functional optimal (premenopausal)");
    eq(labVerdict(oDhea), true, "DHEA-S 46 sits inside 15-205");
    eq(markerTier(oDhea), "outside-optimal", "DHEA-S 46 is the amber tier (inside lab, below functional optimal)");
    eq(formatStatus(oDhea, labVerdict(oDhea)), "SUBOPTIMAL*", "DHEA-S status");
  }
  const oFsh = overlay.markers.find((m) => m.canonicalName.startsWith("FSH"));
  ok(!!oFsh, "FSH matched and present after the overlay");
  if (oFsh) {
    eq(formatLabRange(oFsh), "2.5–10.2", "FSH lab range is the follicular row of ITS OWN phase table");
    eq(markerTier(oFsh), "outside-lab", "FSH 21.1 is above the follicular lab row: red tier");
  }
}

function estroneTable() {
  const parsed = parseQuestText(ESTRONE_BLOCK);
  const estrone = one(parsed.markers, "ESTRONE");
  if (!estrone) return;
  eq(estrone.value, 19, "Estrone value");
  eq(estrone.unit, "pg/mL", "Estrone unit");
  ok(!estrone.referenceRangeRaw, `the row prints no inline range (got ${JSON.stringify(estrone.referenceRangeRaw)})`);
  const note = estrone.referenceNoteRaw ?? "";
  ok(!!note, "the adult phase table Quest printed is captured");
  ok(/Follicular Phase: 10-138 pg\/mL/.test(note), `follicular row captured (got ${JSON.stringify(note)})`);
  ok(/Luteal Phase: 16-173 pg\/mL/.test(note), "luteal row captured");
  ok(/Postmenopausal Phase: < or = 65 pg\/mL/.test(note), "postmenopausal row captured");
  ok(!/Pediatric|years/.test(note), `the pediatric table is not stored (got ${JSON.stringify(note)})`);
  ok(!/developed|analytical/.test(note), "capture stops before the assay prose");
  ok(!parsed.markers.some((m) => /years/.test(m.rawName)), "pediatric rows do not become markers");

  const flagged = flagMarkers(matchMarkers(parsed.markers), { sex: "female" });
  const overlay = applyHormoneOverlay(flagged, {
    sex: "female",
    status: "early_follicular",
    cycleLength: null,
    cycleDay: null,
  });
  const e1 = overlay.markers.find((m) => m.canonicalName === "Estrone (E1)");
  ok(!!e1, "Estrone matched");
  if (!e1) return;
  eq(JSON.stringify(e1.effectiveLabRange), JSON.stringify({ min: 10, max: 138 }), "Estrone lab range is the follicular row of the printed table");
  eq(formatLabRange(e1), "10–138", "Estrone Lab Range cell shows the printed range");
  eq(formatOptimalRange(e1), "40–120", "Estrone functional optimal (premenopausal)");
  eq(labVerdict(e1), true, "Estrone 19 sits inside 10-138");
  eq(markerTier(e1), "outside-optimal", "Estrone 19 is the amber tier");
  eq(formatStatus(e1, labVerdict(e1)), "SUBOPTIMAL*", "Estrone status");
}

function main() {
  labServicesManagerLayout();
  estroneTable();

  if (failures.length) {
    console.error(`\nquest-parser: ${failures.length} FAILED, ${passed} passed\n`);
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(`quest-parser: all ${passed} assertions passed`);
}

main();
