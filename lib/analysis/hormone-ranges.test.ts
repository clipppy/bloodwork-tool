/**
 * Female hormone overlay test. House pattern (see body-systems.test.ts): a
 * self-contained tsx script with a local ok() helper, non-zero exit on failure.
 *
 * Covers: status parsing, phase resolution (pre/post-menopausal selection,
 * phase-dependent rows, "Not sure", birth-control/HRT exclusion), printed
 * phase-table row selection for the lab tier, the overlay's no-op guarantee
 * for non-female patients, the Sydney-like fixture, the lab-governs rule, unit
 * mismatch, re-eval trend against the overlay window, and the deterministic
 * renderers reading the overlay (optimal column, status wording, lab range).
 *
 * Markers are built by running real MatchedMarker objects through the real
 * flagging engine so the overlay is exercised against the engine's genuine
 * output, not a hand-built stand-in.
 *
 * Run: npx tsx lib/analysis/hormone-ranges.test.ts   (or: npm run test:hormone-ranges)
 */

import type { MatchedMarker } from "../matcher";
import { flagMarkers, isFlagged, type FlaggedMarker } from "../flagging";
import {
  HORMONE_OVERLAY_MARKERS,
  HORMONE_STATUS_OPTIONS,
  PHASE_DEPENDENT_RANGES,
  PHASE_INDEPENDENT_RANGES,
  applyHormoneOverlay,
  formatOptimalWindow,
  hormoneOverlayOf,
  hormoneStatusLabel,
  parseHormoneStatus,
  resolveHormoneOptimal,
  selectPrintedPhaseRow,
  type HormoneStatus,
} from "./hormone-ranges";
import {
  buildChartRows,
  buildDeterministicAnalysis,
  computeTrend,
  formatLabRange,
  formatOptimalRange,
  formatStatus,
  withinLabRange,
} from "./deterministic";
import { buildPayload } from "./deidentify";
import { buildInitialAnalysisPrompt } from "./prompt";
import { OPTIMAL_RANGES } from "../ranges/optimal-ranges";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else failures.push(`  x ${msg}`);
}
const same = (a: { min: number | null; max: number | null } | null, min: number | null, max: number | null) =>
  !!a && a.min === min && a.max === max;

// ----- Fixtures -----

function matched(
  canonicalName: string,
  value: number | string,
  unit: string,
  referenceRangeRaw = "",
  extra: Partial<MatchedMarker> = {},
): MatchedMarker {
  return {
    rawName: canonicalName.toUpperCase(),
    canonicalName,
    value,
    unit,
    labFlagFromPdf: null,
    referenceRangeRaw,
    referenceNoteRaw: null,
    optimalRange: null,
    matchStatus: "matched",
    matchConfidence: "exact",
    confirmationPending: false,
    confirmationSource: null,
    source: "body",
    notes: [],
    ...extra,
  };
}

const FSH_TABLE =
  "Follicular Phase 2.5-10.2 | Mid-cycle Peak 3.1-17.7 | Luteal Phase 1.5- 9.1 | Postmenopausal 23.0-116.3";
const LH_TABLE =
  "Follicular Phase 1.9-12.5 | Mid-Cycle Peak 8.7-76.3 | Luteal Phase 0.5-16.9 | Postmenopausal 10.0-54.7";
const E2_NOTE =
  "Female: Follicular Phase: 30-144 Mid-Cycle: 64-357 Luteal Phase: 56-214 Postmenopausal: < or = 31";

const ESTRADIOL = "Estradiol (E2)";
const PROGESTERONE = "Progesterone";
const FSH = "FSH (Follicle Stimulating Hormone)";
const LH = "LH (Luteinizing Hormone)";
const SHBG = "SHBG (Sex Hormone Binding Globulin)";
const DHEAS = "DHEA Sulfate";
const PREG = "Pregnenolone";
const T_TOTAL = "Testosterone Total";
const T_FREE = "Testosterone Free";
const T_BIO = "Testosterone Bioavailable";
const E1 = "Estrone (E1)";

function engine(ms: MatchedMarker[]): FlaggedMarker[] {
  return flagMarkers(ms, { sex: "female" });
}
const byName = (arr: FlaggedMarker[], name: string) => arr.find((m) => m.canonicalName === name)!;

// ----- 1. Table integrity -----

for (const name of HORMONE_OVERLAY_MARKERS) {
  const rec = Object.values(OPTIMAL_RANGES).find((r) => r.canonicalName === name);
  ok(!!rec, `overlay marker "${name}" exists in the dictionary`);
  if (rec) {
    ok(
      rec.optimalRange.min === null && rec.optimalRange.max === null,
      `dictionary still carries NO optimal for "${name}" (shared path untouched)`,
    );
  }
}
ok(Object.keys(PHASE_INDEPENDENT_RANGES).length === 7, "7 phase-independent markers");
ok(Object.keys(PHASE_DEPENDENT_RANGES).length === 4, "4 phase-dependent markers");
ok(HORMONE_STATUS_OPTIONS.length === 9, "9 status options");
ok(HORMONE_STATUS_OPTIONS[0].value === "not_sure", "Not sure is the first (default) option");

// ----- 2. Status parsing -----

ok(parseHormoneStatus("early_follicular") === "early_follicular", "parse: valid key");
ok(parseHormoneStatus("") === "not_sure", "parse: empty -> not_sure");
ok(parseHormoneStatus(null) === "not_sure", "parse: null -> not_sure");
ok(parseHormoneStatus("garbage") === "not_sure", "parse: unknown -> not_sure");
ok(parseHormoneStatus(" luteal ") === "luteal", "parse: trims whitespace");
ok(hormoneStatusLabel("mid_luteal") === "Mid-luteal (~7 days post-ovulation)", "label lookup");

// ----- 3. Resolution -----

const r = (name: string, s: HormoneStatus) => resolveHormoneOptimal(name, s);
const win = (name: string, s: HormoneStatus) => {
  const res = r(name, s);
  return res.kind === "range" ? res.window : null;
};

// Phase-independent: SHBG and Pregnenolone for every non-excluded status.
for (const s of ["not_sure", "early_follicular", "mid_follicular", "ovulatory", "luteal", "mid_luteal", "postmenopausal"] as HormoneStatus[]) {
  ok(same(win(SHBG, s), 50, 100), `SHBG 50-100 under ${s}`);
  ok(same(win(PREG, s), 100, 250), `Pregnenolone 100-250 under ${s}`);
}
// Pre vs post selection.
ok(same(win(DHEAS, "not_sure"), 150, 300), "DHEA-S: Not sure -> premenopausal 150-300");
ok(same(win(DHEAS, "luteal"), 150, 300), "DHEA-S: cycling -> premenopausal 150-300");
ok(same(win(DHEAS, "postmenopausal"), 75, 150), "DHEA-S: postmenopausal 75-150");
ok(same(win(T_TOTAL, "ovulatory"), 20, 40), "Testosterone Total pre 20-40");
ok(same(win(T_TOTAL, "postmenopausal"), 15, 35), "Testosterone Total post 15-35");
ok(same(win(T_FREE, "not_sure"), 1.0, 3.0), "Testosterone Free pre 1.0-3.0");
ok(same(win(T_FREE, "postmenopausal"), 0.8, 2.5), "Testosterone Free post 0.8-2.5");
ok(same(win(T_BIO, "early_follicular"), 2.0, 5.0), "Testosterone Bioavailable pre 2.0-5.0");
ok(same(win(T_BIO, "postmenopausal"), 1.5, 4.5), "Testosterone Bioavailable post 1.5-4.5");
ok(same(win(E1, "mid_follicular"), 40, 120), "Estrone pre 40-120");
ok(same(win(E1, "postmenopausal"), 20, 55), "Estrone post 20-55");

// Phase-dependent rows.
ok(same(win(ESTRADIOL, "early_follicular"), 40, 100), "E2 early follicular 40-100");
ok(same(win(ESTRADIOL, "mid_follicular"), 50, 150), "E2 mid-follicular 50-150");
ok(same(win(ESTRADIOL, "ovulatory"), 150, 400), "E2 ovulatory 150-400");
ok(same(win(ESTRADIOL, "luteal"), 75, 250), "E2 luteal 75-250");
ok(same(win(ESTRADIOL, "mid_luteal"), 100, 250), "E2 mid-luteal 100-250");
ok(same(win(ESTRADIOL, "postmenopausal"), 10, 30), "E2 postmenopausal 10-30");
ok(same(win(PROGESTERONE, "early_follicular"), 0.1, 0.5), "P4 early follicular 0.1-0.5");
ok(same(win(PROGESTERONE, "mid_follicular"), 0.1, 0.5), "P4 mid-follicular 0.1-0.5");
ok(same(win(PROGESTERONE, "ovulatory"), 0.5, 2.0), "P4 surge 0.5-2.0");
ok(same(win(PROGESTERONE, "luteal"), 5, 15), "P4 luteal 5-15");
ok(same(win(PROGESTERONE, "mid_luteal"), 12, 25), "P4 mid-luteal 12-25");
ok(same(win(PROGESTERONE, "postmenopausal"), null, 0.2), "P4 postmenopausal <= 0.2");
ok(same(win(FSH, "early_follicular"), 3, 8), "FSH follicular 3-8");
ok(same(win(FSH, "ovulatory"), 6, 25), "FSH surge 6-25");
ok(same(win(FSH, "luteal"), 1.5, 7), "FSH luteal 1.5-7");
ok(same(win(FSH, "mid_luteal"), 1.5, 7), "FSH mid-luteal -> luteal 1.5-7");
ok(same(win(FSH, "postmenopausal"), 30, null), "FSH postmenopausal >= 30");
ok(same(win(LH, "mid_follicular"), 2, 10), "LH follicular 2-10");
ok(same(win(LH, "ovulatory"), 20, 75), "LH surge 20-75");
ok(same(win(LH, "luteal"), 1, 10), "LH luteal 1-10");
ok(same(win(LH, "mid_luteal"), 1, 10), "LH mid-luteal -> luteal 1-10");
ok(same(win(LH, "postmenopausal"), 15, 55), "LH postmenopausal 15-55");

// Not sure: phase-dependent needs a phase.
for (const name of [ESTRADIOL, PROGESTERONE, FSH, LH]) {
  ok(r(name, "not_sure").kind === "phase_required", `${name}: Not sure -> phase_required`);
}
// Birth control / HRT: nothing applies, SHBG and Pregnenolone included.
for (const s of ["birth_control", "postmenopausal_hrt"] as HormoneStatus[]) {
  for (const name of HORMONE_OVERLAY_MARKERS) {
    ok(r(name, s).kind === "excluded", `${name}: ${s} -> excluded`);
  }
}
// Not covered.
for (const name of ["Prolactin", "Estriol (E3)", "AMH (Anti-Mullerian Hormone)", "Cortisol", "Estrogens", "Glucose"]) {
  ok(r(name, "luteal").kind === "not_covered", `${name}: not covered`);
}

// ----- 4. Printed phase-table row selection -----

ok(same(selectPrintedPhaseRow(FSH_TABLE, "early_follicular"), 2.5, 10.2), "FSH table: early follicular -> Follicular row");
ok(same(selectPrintedPhaseRow(FSH_TABLE, "mid_follicular"), 2.5, 10.2), "FSH table: mid-follicular -> Follicular row");
ok(same(selectPrintedPhaseRow(FSH_TABLE, "ovulatory"), 3.1, 17.7), "FSH table: ovulatory -> Mid-cycle Peak row");
ok(same(selectPrintedPhaseRow(FSH_TABLE, "luteal"), 1.5, 9.1), "FSH table: luteal -> Luteal row (tolerates '1.5- 9.1')");
ok(same(selectPrintedPhaseRow(FSH_TABLE, "mid_luteal"), 1.5, 9.1), "FSH table: mid-luteal -> Luteal row");
ok(same(selectPrintedPhaseRow(FSH_TABLE, "postmenopausal"), 23.0, 116.3), "FSH table: postmenopausal row");
ok(selectPrintedPhaseRow(FSH_TABLE, "not_sure") === null, "FSH table: Not sure -> no row");
ok(selectPrintedPhaseRow(FSH_TABLE, "birth_control") === null, "FSH table: birth control -> no row");
ok(same(selectPrintedPhaseRow(LH_TABLE, "ovulatory"), 8.7, 76.3), "LH table: Mid-Cycle Peak (capitalised) row");
ok(same(selectPrintedPhaseRow(E2_NOTE, "early_follicular"), 30, 144), "E2 note: Follicular row with colons");
ok(same(selectPrintedPhaseRow(E2_NOTE, "ovulatory"), 64, 357), "E2 note: Mid-Cycle row");
ok(same(selectPrintedPhaseRow(E2_NOTE, "postmenopausal"), null, 31), "E2 note: '< or = 31' -> max 31");
ok(selectPrintedPhaseRow("22-77", "luteal") === null, "plain range: no phase rows");
ok(selectPrintedPhaseRow("", "luteal") === null, "empty: null");
ok(selectPrintedPhaseRow(null, "luteal") === null, "null: null");

// ----- 5. No-op for non-female -----

const mixedPanel = engine([
  matched(ESTRADIOL, 15, "pg/mL", "< OR = 39"),
  matched(SHBG, 71, "nmol/L", "22-77"),
  matched("Glucose", 95, "mg/dL", "65-99"),
]);
for (const sex of ["male", null] as const) {
  const res = applyHormoneOverlay(mixedPanel, { sex, status: "early_follicular" });
  ok(res.markers === mixedPanel, `sex=${sex}: same array returned`);
  ok(res.summary.notes.length === 0 && res.summary.applied.length === 0, `sex=${sex}: no notes, nothing applied`);
  ok(res.summary.status === null && res.summary.statusLabel === null, `sex=${sex}: status null`);
}

// ----- 6. Sydney-like fixture: F, early follicular -----

const sydneyEngine = engine([
  matched(ESTRADIOL, 15, "pg/mL", "", { referenceNoteRaw: E2_NOTE }),
  matched(PREG, 77, "ng/dL", "22-237"),
  matched(DHEAS, 115, "mcg/dL", "19-237"),
  matched(SHBG, 71, "nmol/L", "17-124"),
  matched("Glucose", 95, "mg/dL", "65-99"),
]);
const sydney = applyHormoneOverlay(sydneyEngine, { sex: "female", status: "early_follicular" });
{
  const e2 = byName(sydney.markers, ESTRADIOL);
  ok(e2.flagStatus === "low" && e2.flagDirection === "low", "Sydney E2 15 -> below optimal (low)");
  ok(hormoneOverlayOf(e2) !== null && same(hormoneOverlayOf(e2)!.optimal, 40, 100), "Sydney E2 overlay window 40-100");
  ok(same(e2.effectiveLabRange, 30, 144), "Sydney E2 lab tier = Follicular row of the printed table (30-144)");
  ok(e2.labRangeSource === "printed", "Sydney E2 labRangeSource printed");
  ok(e2.flagSeverity === "severe", "Sydney E2 15 is below the lab row too -> severe");
  ok(formatLabRange(e2) === "30–144", `Sydney E2 lab range renders as selected row, got "${formatLabRange(e2)}"`);
  ok(formatOptimalRange(e2) === "40–100", `Sydney E2 optimal renders 40–100, got "${formatOptimalRange(e2)}"`);
  ok(formatStatus(e2, withinLabRange(e2)) === "LOW", "Sydney E2 status LOW (outside lab row)");

  const preg = byName(sydney.markers, PREG);
  ok(preg.flagStatus === "low", "Sydney Pregnenolone 77 -> below optimal (100-250)");
  ok(preg.flagSeverity === "moderate", "Pregnenolone 77: 23 below bound 100 (>20% tolerance of 20), inside lab -> moderate");
  ok(preg.comparedAgainst === "optimal" && preg.flagType === "optimal_two_tier", "Pregnenolone compared against optimal, two-tier");
  ok(same(preg.effectiveLabRange, 22, 237) && preg.labRangeSource === "printed", "Pregnenolone keeps the engine's printed lab range");
  ok(withinLabRange(preg) === true, "Pregnenolone 77 within lab range");
  ok(formatStatus(preg, true) === "SUBOPTIMAL*", `Pregnenolone status SUBOPTIMAL*, got "${formatStatus(preg, true)}"`);
  ok(formatOptimalRange(preg) === "100–250", "Pregnenolone optimal column 100–250");

  const dheas = byName(sydney.markers, DHEAS);
  ok(dheas.flagStatus === "low", "Sydney DHEA-S 115 -> below optimal (150-300)");
  ok(dheas.flagSeverity === "moderate", "DHEA-S 115: 35 below 150 (tolerance 30) -> moderate");
  ok(formatOptimalRange(dheas) === "150–300", "DHEA-S optimal column 150–300");

  const shbg = byName(sydney.markers, SHBG);
  ok(shbg.flagStatus === "optimal" && !isFlagged(shbg), "Sydney SHBG 71 within optimal (50-100), not flagged");
  ok(hormoneOverlayOf(shbg) !== null, "SHBG carries the overlay annotation even when optimal");
  ok(formatOptimalRange(shbg) === "50–100", "SHBG optimal column 50–100");

  const glucose = byName(sydney.markers, "Glucose");
  ok(glucose === byName(sydneyEngine, "Glucose"), "non-hormone marker passes through by identity");

  ok(
    sydney.summary.applied.length === 4 &&
      [ESTRADIOL, PREG, DHEAS, SHBG].every((n) => sydney.summary.applied.includes(n)),
    "Sydney: 4 markers applied",
  );
  ok(sydney.summary.statusLabel === "Early follicular (day 1-5)", "Sydney status label");
  ok(sydney.summary.notes.some((n) => n.includes("Early follicular (day 1-5)")), "Sydney notes name the status");
  ok(sydney.summary.notes.some((n) => n.includes("Estradiol 40–100 pg/mL (early follicular)")), "Sydney notes list E2 range + basis");
  ok(sydney.summary.notes.some((n) => /Estradiol.*phase table/.test(n)), "Sydney notes mention the phase-table lab row for E2");

  // Chart rows: hormones get real rows; SHBG does not.
  const rows = buildChartRows(sydney.markers);
  const rowNames = rows.map((r) => r.marker);
  ok(rowNames.includes(ESTRADIOL) && rowNames.includes(PREG) && rowNames.includes(DHEAS), "chart rows include the three flagged hormones");
  ok(!rowNames.includes(SHBG), "chart rows exclude SHBG");
  const pregRow = rows.find((r2) => r2.marker === PREG)!;
  ok(pregRow.optimalRange === "100–250" && pregRow.status === "SUBOPTIMAL*" && pregRow.withinLabRange === true, "Pregnenolone chart row: amber Out of Optimal (Low)");

  // Whole deterministic analysis + payload + prompt.
  const analysis = buildDeterministicAnalysis(sydney.markers, {
    patientName: "Test",
    patientDate: "2026-01-01",
    sex: "female",
    hormone: sydney.summary,
  });
  ok(analysis.header.sex === "Female", "header sex Female");
  ok(analysis.header.hormoneStatus === "Early follicular (day 1-5)", "header hormonal status label");
  ok(analysis.hormone === sydney.summary, "analysis carries the overlay summary");
  ok(analysis.reassuring.other.some((s) => s.startsWith("SHBG")), "SHBG listed among reassuring in-range markers");

  const payload = buildPayload(sydney.markers, {
    age: 40,
    sex: "female",
    intake: "",
    patientName: "Test",
    hormone: sydney.summary,
  });
  ok(payload.patient.hormoneStatus === "Early follicular (day 1-5)", "payload carries the status label");
  ok(payload.hormoneNotes.length === sydney.summary.notes.length, "payload carries the notes");
  const pm = payload.flaggedMarkers.find((m) => m.name === PREG)!;
  ok(pm.optimalRange === "100–250" && pm.status === "SUBOPTIMAL*", "payload Pregnenolone optimal + status");
  const prompt = buildInitialAnalysisPrompt(payload);
  ok(prompt.includes("Cycle phase / menopausal status (selected by the practitioner): Early follicular (day 1-5)."), "prompt states the status");
  ok(prompt.includes("functional\noptimal ranges supplied by the practitioner"), "prompt says hormone flags came from practitioner ranges");
}

// ----- 7. Not sure: phase-dependent untouched, phase-independent applied -----

const notSureEngine = engine([
  matched(ESTRADIOL, 15, "pg/mL", "< OR = 39"),
  matched(FSH, 6.4, "mIU/mL", FSH_TABLE),
  matched(DHEAS, 115, "mcg/dL", "19-237"),
  matched(SHBG, 71, "nmol/L", "17-124"),
]);
const notSure = applyHormoneOverlay(notSureEngine, { sex: "female", status: "not_sure" });
{
  ok(byName(notSure.markers, ESTRADIOL) === byName(notSureEngine, ESTRADIOL), "Not sure: Estradiol untouched (identity)");
  ok(byName(notSure.markers, FSH) === byName(notSureEngine, FSH), "Not sure: FSH untouched (identity)");
  ok(byName(notSure.markers, DHEAS).flagStatus === "low", "Not sure: DHEA-S applied as premenopausal -> low");
  ok(byName(notSure.markers, SHBG).flagStatus === "optimal" && hormoneOverlayOf(byName(notSure.markers, SHBG)) !== null, "Not sure: SHBG applied");
  ok(notSure.summary.notes.some((n) => n.includes("was not provided") && n.includes("Estradiol") && n.includes("FSH")), "Not sure: note says the phase was not provided and names the markers");
  ok(notSure.summary.applied.length === 2, "Not sure: 2 applied");
  const analysis = buildDeterministicAnalysis(notSure.markers, {
    patientName: "Test",
    patientDate: "2026-01-01",
    sex: "female",
    hormone: notSure.summary,
  });
  ok(analysis.header.hormoneStatus === "Not sure", "header reads Not sure");
}

// ----- 8. Birth control / HRT: nothing applied, note says why -----

for (const status of ["birth_control", "postmenopausal_hrt"] as HormoneStatus[]) {
  const res = applyHormoneOverlay(sydneyEngine, { sex: "female", status });
  ok(res.markers.every((m, i) => m === sydneyEngine[i]), `${status}: every marker untouched (identity)`);
  ok(res.summary.applied.length === 0, `${status}: nothing applied`);
  ok(res.summary.notes.length === 1, `${status}: exactly one note`);
  ok(
    res.summary.notes[0].includes(status === "birth_control" ? "hormonal birth control" : "postmenopausal on HRT") &&
      res.summary.notes[0].includes("do not fit"),
    `${status}: note explains the exclusion`,
  );
}

// ----- 9. Postmenopausal: post column, phase rows, phase-table row -----

{
  const post = applyHormoneOverlay(
    engine([
      matched(DHEAS, 115, "mcg/dL", "19-237"),
      matched(FSH, 45, "mIU/mL", FSH_TABLE),
      matched(PROGESTERONE, 0.3, "ng/mL", ""),
      matched(ESTRADIOL, 20, "pg/mL", "", { referenceNoteRaw: E2_NOTE }),
    ]),
    { sex: "female", status: "postmenopausal" },
  );
  ok(byName(post.markers, DHEAS).flagStatus === "optimal", "post: DHEA-S 115 within 75-150");
  const fsh = byName(post.markers, FSH);
  ok(fsh.flagStatus === "optimal" && same(fsh.effectiveLabRange, 23.0, 116.3), "post: FSH 45 >= 30 optimal, lab row Postmenopausal 23-116.3");
  ok(formatOptimalRange(fsh) === "≥ 30", `post: FSH optimal renders ≥ 30, got "${formatOptimalRange(fsh)}"`);
  const p4 = byName(post.markers, PROGESTERONE);
  ok(p4.flagStatus === "high" && formatOptimalRange(p4) === "≤ 0.2", "post: Progesterone 0.3 above <= 0.2 -> high");
  ok(p4.flagSeverity === "moderate", "post: Progesterone 0.3 is 0.1 above 0.2 (tolerance 0.04), no lab bound -> moderate");
  const e2 = byName(post.markers, ESTRADIOL);
  ok(e2.flagStatus === "optimal" && same(e2.effectiveLabRange, null, 31), "post: E2 20 within 10-30; lab row '< or = 31'");
}

// ----- 10. Lab governs when inside optimal but outside the printed lab range -----

{
  const res = applyHormoneOverlay(
    engine([matched(PREG, 245, "ng/dL", "22-237")]),
    { sex: "female", status: "luteal" },
  );
  const preg = byName(res.markers, PREG);
  ok(preg.flagStatus === "high" && preg.flagDirection === "high", "Pregnenolone 245: inside 100-250 but above lab 237 -> stays HIGH");
  ok(preg.comparedAgainst === "lab", "lab governs: comparedAgainst lab");
  ok(formatOptimalRange(preg) === "100–250", "optimal column still shows the functional window");
  ok(withinLabRange(preg) === false && formatStatus(preg, false) === "HIGH", "renders HIGH (red)");
  ok(res.summary.notes.some((n) => n.includes("lab range governs")), "note explains lab governs");
}

// ----- 11. Lab-flag safety net kept when inside optimal and lab printed H/L with no range -----

{
  const res = applyHormoneOverlay(
    engine([matched(T_TOTAL, 30, "ng/dL", "", { labFlagFromPdf: "H" })]),
    { sex: "female", status: "luteal" },
  );
  const t = byName(res.markers, T_TOTAL);
  ok(t.flagStatus === "high" && t.labFlagFallback === true, "lab H with no range, inside optimal: lab flag kept");
  ok(formatOptimalRange(t) === "20–40", "optimal column shows the functional window");
}

// ----- 12. Unit mismatch: not applied, note -----

{
  const res = applyHormoneOverlay(
    engine([matched(T_FREE, 0.9, "ng/dL", "0.2-5.0")]),
    { sex: "female", status: "luteal" },
  );
  ok(byName(res.markers, T_FREE) === res.markers[0] && hormoneOverlayOf(res.markers[0]) === null, "unit mismatch: untouched");
  ok(res.summary.notes.some((n) => n.includes("units differ") && n.includes("Testosterone Free")), "unit mismatch: note");
  // ug/dL vs mcg/dL is NOT a mismatch.
  const ug = applyHormoneOverlay(engine([matched(DHEAS, 115, "ug/dL", "19-237")]), { sex: "female", status: "luteal" });
  ok(ug.markers[0].flagStatus === "low", "ug/dL accepted for mcg/dL");
}

// ----- 13. Non-numeric values pass through -----

{
  const res = applyHormoneOverlay(engine([matched(PROGESTERONE, "Not detected", "ng/mL", "")]), { sex: "female", status: "luteal" });
  ok(hormoneOverlayOf(res.markers[0]) === null && res.summary.applied.length === 0, "non-numeric: untouched");
  const lt = applyHormoneOverlay(engine([matched(PROGESTERONE, "<0.1", "ng/mL", "")]), { sex: "female", status: "early_follicular" });
  ok(lt.markers[0].flagStatus === "optimal", "'<0.1' reads as 0.1 -> inside follicular 0.1-0.5");
}

// ----- 14. Re-eval trend uses the overlay window -----

{
  const e2 = byName(sydney.markers, ESTRADIOL);
  const w = hormoneOverlayOf(e2)!.optimal;
  ok(computeTrend(ESTRADIOL, "15 pg/mL", 50, false, e2.effectiveLabRange, w) === "Improved", "E2 15 -> 50 against 40-100: Improved");
  ok(computeTrend(ESTRADIOL, "60 pg/mL", 50, false, e2.effectiveLabRange, w) === "Stable/In Range", "E2 60 -> 50 both inside 40-100: Stable/In Range");
  ok(computeTrend(ESTRADIOL, "35 pg/mL", 20, false, e2.effectiveLabRange, w) === "Worsened", "E2 35 -> 20: Worsened");
  // Without the preferred window the dictionary has no optimal for E2 and the
  // fallback is the lab window — the pre-overlay behaviour, still intact.
  ok(computeTrend(ESTRADIOL, "60 pg/mL", 50, false, { min: 30, max: 144 }) === "Stable/In Range", "no preferred window: falls back as before");
}

// ----- 15. formatOptimalWindow -----

ok(formatOptimalWindow({ min: 1.0, max: 3.0 }) === "1–3", "1.0-3.0 renders 1–3");
ok(formatOptimalWindow({ min: 30, max: null }) === "≥ 30", ">= 30");
ok(formatOptimalWindow({ min: null, max: 0.2 }) === "≤ 0.2", "<= 0.2");

// ----- 16. Male / unspecified header text -----

{
  const a = buildDeterministicAnalysis(mixedPanel, { patientName: "T", patientDate: "2026-01-01", sex: "male" });
  ok(a.header.sex === "Male" && a.header.hormoneStatus === "n/a" && a.hormone === null, "male header: Sex Male, status n/a");
  const b = buildDeterministicAnalysis(mixedPanel, { patientName: "T", patientDate: "2026-01-01" });
  ok(b.header.sex === "—" && b.header.hormoneStatus === "n/a", "unspecified header");
  const p = buildPayload(mixedPanel, { age: null, sex: "male", intake: "", patientName: "T" });
  ok(p.patient.hormoneStatus === null && p.hormoneNotes.length === 0, "male payload: no hormone status / notes");
  ok(!buildInitialAnalysisPrompt(p).includes("Cycle phase"), "male prompt: no hormone context");
}

// ----- Report -----

if (failures.length) {
  console.error(`hormone-ranges: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log(`hormone-ranges: ${passed} assertions passed`);
