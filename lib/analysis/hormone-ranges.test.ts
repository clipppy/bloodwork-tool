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
  computeCycleDay,
  cycleDayToStatus,
  cyclePhaseWindows,
  estimatedOvulationDay,
  formatOptimalWindow,
  phaseWindowLabel,
  resolveCycleLength,
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

// ----- 17. cycleDayToStatus: Melissa's confirmed 28-day table (every day) -----

{
  const table28: Record<number, HormoneStatus> = {};
  for (let d = 1; d <= 5; d++) table28[d] = "early_follicular";
  for (let d = 6; d <= 11; d++) table28[d] = "mid_follicular";
  for (let d = 12; d <= 15; d++) table28[d] = "ovulatory";
  for (let d = 16; d <= 20; d++) table28[d] = "luteal";
  for (let d = 21; d <= 23; d++) table28[d] = "mid_luteal";
  for (let d = 24; d <= 28; d++) table28[d] = "luteal";
  for (let d = 1; d <= 28; d++) {
    ok(cycleDayToStatus(d) === table28[d], `28-day: day ${d} -> ${table28[d]} (default length)`);
    ok(cycleDayToStatus(d, 28) === table28[d], `28-day: day ${d} -> ${table28[d]} (explicit length)`);
  }
  ok(cycleDayToStatus(11) === "mid_follicular", "day 11 is mid-follicular (pre-surge), not ovulatory");
  ok(cycleDayToStatus(18) === "luteal", "day 18 -> luteal");
  ok(cycleDayToStatus(28) === "luteal", "day 28 -> luteal (late), no longer mid-luteal");
  // A cycle running up to two days long still reads as late luteal.
  ok(cycleDayToStatus(29) === "luteal" && cycleDayToStatus(30) === "luteal", "days 29-30 -> luteal (running long)");
  ok(cycleDayToStatus(18.9) === "luteal", "fractional day floors");
  for (const bad of [0, -3, 31, 35, 40, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    ok(cycleDayToStatus(bad) === null, `cycle day ${bad} -> null`);
  }
  ok(estimatedOvulationDay() === 14 && estimatedOvulationDay(28) === 14, "28-day ovulation ~day 14");
  const w28 = cyclePhaseWindows(28).map((w) => `${w.status}:${w.start}-${w.end}`).join(" ");
  ok(
    w28 === "early_follicular:1-5 mid_follicular:6-11 ovulatory:12-15 luteal:16-20 mid_luteal:21-23 luteal:24-28",
    `28-day windows (${w28})`,
  );
}

// ----- 18. computeCycleDay -----

{
  ok(computeCycleDay("2026-03-01", "2026-03-18") === 18, "LMP 3/1, draw 3/18 -> day 18");
  ok(computeCycleDay("2026-03-01", "2026-03-01") === 1, "draw on the LMP -> day 1");
  ok(computeCycleDay("2026-02-20", "2026-03-05") === 14, "across a month boundary -> day 14");
  ok(computeCycleDay("2026-03-18", "2026-03-01") === null, "draw before LMP -> null");
  ok(computeCycleDay("", "2026-03-18") === null, "missing LMP -> null");
  ok(computeCycleDay("2026-03-01", "") === null, "missing draw -> null");
  ok(computeCycleDay("not a date", "2026-03-18") === null, "unparseable LMP -> null");
  ok(computeCycleDay("2026-02-30", "2026-03-18") === null, "impossible calendar date -> null");
  // Composed: LMP + draw -> status, the path the form takes.
  const day = computeCycleDay("2026-03-01", "2026-03-18");
  ok(day !== null && cycleDayToStatus(day) === "luteal", "LMP path resolves to luteal");
  const late = computeCycleDay("2026-01-01", "2026-03-18");
  ok(late !== null && cycleDayToStatus(late) === null, "LMP too long ago -> null (manual selection kept)");
}

// ----- 19. Variable cycle lengths (ovulation = length - 14) -----

{
  // 24 days: O = 10. 1-5 | 6-7 | 8-11 | 12-16 | 17-19 | 20-24
  ok(estimatedOvulationDay(24) === 10, "24-day ovulation ~day 10");
  ok(cycleDayToStatus(7, 24) === "mid_follicular", "24-day: day 7 -> mid-follicular");
  ok(cycleDayToStatus(8, 24) === "ovulatory", "24-day: day 8 -> ovulatory");
  ok(cycleDayToStatus(11, 24) === "ovulatory", "24-day: day 11 -> ovulatory (would be mid-follicular at 28)");
  ok(cycleDayToStatus(12, 24) === "luteal", "24-day: day 12 -> luteal");
  ok(cycleDayToStatus(17, 24) === "mid_luteal", "24-day: day 17 -> mid-luteal");
  ok(cycleDayToStatus(20, 24) === "luteal", "24-day: day 20 -> luteal (late)");
  ok(cycleDayToStatus(24, 24) === "luteal", "24-day: day 24 -> luteal");
  ok(cycleDayToStatus(26, 24) === "luteal", "24-day: day 26 -> luteal (two days over)");
  ok(cycleDayToStatus(27, 24) === null, "24-day: day 27 -> null");

  // 32 days: O = 18. 1-5 | 6-15 | 16-19 | 20-24 | 25-27 | 28-32
  ok(estimatedOvulationDay(32) === 18, "32-day ovulation ~day 18");
  ok(cycleDayToStatus(15, 32) === "mid_follicular", "32-day: day 15 -> mid-follicular (would be ovulatory at 28)");
  ok(cycleDayToStatus(16, 32) === "ovulatory", "32-day: day 16 -> ovulatory");
  ok(cycleDayToStatus(19, 32) === "ovulatory", "32-day: day 19 -> ovulatory");
  ok(cycleDayToStatus(20, 32) === "luteal", "32-day: day 20 -> luteal");
  ok(cycleDayToStatus(22, 32) === "luteal", "32-day: day 22 -> luteal (would be mid-luteal at 28)");
  ok(cycleDayToStatus(25, 32) === "mid_luteal", "32-day: day 25 -> mid-luteal");
  ok(cycleDayToStatus(27, 32) === "mid_luteal", "32-day: day 27 -> mid-luteal");
  ok(cycleDayToStatus(28, 32) === "luteal", "32-day: day 28 -> luteal (late)");
  ok(cycleDayToStatus(32, 32) === "luteal", "32-day: day 32 -> luteal");
  ok(cycleDayToStatus(34, 32) === "luteal", "32-day: day 34 -> luteal (two days over)");
  ok(cycleDayToStatus(35, 32) === null, "32-day: day 35 -> null");

  // 35 days: O = 21. 1-5 | 6-18 | 19-22 | 23-27 | 28-30 | 31-35
  ok(estimatedOvulationDay(35) === 21, "35-day ovulation ~day 21");
  ok(cycleDayToStatus(18, 35) === "mid_follicular", "35-day: day 18 -> mid-follicular");
  ok(cycleDayToStatus(21, 35) === "ovulatory", "35-day: day 21 -> ovulatory");
  ok(cycleDayToStatus(23, 35) === "luteal", "35-day: day 23 -> luteal");
  ok(cycleDayToStatus(29, 35) === "mid_luteal", "35-day: day 29 -> mid-luteal");
  ok(cycleDayToStatus(35, 35) === "luteal", "35-day: day 35 -> luteal");
  ok(cycleDayToStatus(37, 35) === "luteal" && cycleDayToStatus(38, 35) === null, "35-day: 37 luteal, 38 null");

  // Every length in the supported band assigns each day 1..L exactly once,
  // in order, with early follicular always 1-5 and the last window ending at L.
  for (let L = 21; L <= 45; L++) {
    const ws = cyclePhaseWindows(L);
    let contiguous = ws[0].start === 1 && ws[ws.length - 1].end === L;
    for (let i = 1; i < ws.length; i++) contiguous = contiguous && ws[i].start === ws[i - 1].end + 1;
    ok(contiguous, `${L}-day windows are contiguous and cover 1..${L}`);
    ok(ws[0].status === "early_follicular" && ws[0].end === 5, `${L}-day: early follicular is 1-5`);
    ok(ws.every((w) => w.end >= w.start), `${L}-day: no empty window emitted`);
  }
}

// ----- 20. Short-cycle clamping (21 days squeezes mid-follicular out) -----

{
  // 21 days: O = 7. Mid-follicular would be 6..4 (empty) -> dropped; the
  // ovulatory window (5..8) is clamped to start after early follicular.
  const w21 = cyclePhaseWindows(21).map((w) => `${w.status}:${w.start}-${w.end}`).join(" ");
  ok(
    w21 === "early_follicular:1-5 ovulatory:6-8 luteal:9-13 mid_luteal:14-16 luteal:17-21",
    `21-day windows (${w21})`,
  );
  ok(cycleDayToStatus(5, 21) === "early_follicular", "21-day: day 5 -> early follicular");
  ok(cycleDayToStatus(6, 21) === "ovulatory", "21-day: day 6 -> ovulatory (no mid-follicular)");
  ok(!cyclePhaseWindows(21).some((w) => w.status === "mid_follicular"), "21-day: no mid-follicular window");
  ok(cycleDayToStatus(9, 21) === "luteal", "21-day: day 9 -> luteal");
  ok(cycleDayToStatus(14, 21) === "mid_luteal", "21-day: day 14 -> mid-luteal");
  ok(cycleDayToStatus(21, 21) === "luteal", "21-day: day 21 -> luteal");
  ok(cycleDayToStatus(23, 21) === "luteal" && cycleDayToStatus(24, 21) === null, "21-day: 23 luteal, 24 null");
  ok(phaseWindowLabel("mid_follicular", 21) === null, "21-day: mid-follicular has no day span");
}

// ----- 21. Invalid inputs + cycle-length fallback to 28 -----

{
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    ok(cycleDayToStatus(18, bad) === "luteal", `non-finite cycle length ${bad} reads as 28 (day 18 -> luteal)`);
    ok(cycleDayToStatus(bad, 32) === null, `non-finite cycle day ${bad} -> null`);
    ok(resolveCycleLength(bad).length === 28 && !resolveCycleLength(bad).fellBack, `resolveCycleLength(${bad}) -> 28, not a fallback`);
  }
  // Outside 21-45 -> 28 with the flag set.
  for (const out of [20, 46, 0, -5, 100, 20.9, "20", "46"]) {
    const r = resolveCycleLength(out);
    ok(r.length === 28 && r.fellBack, `cycle length ${JSON.stringify(out)} falls back to 28 (flagged)`);
    ok(cycleDayToStatus(22, out as number) === "mid_luteal", `cycle length ${JSON.stringify(out)}: day 22 -> mid-luteal (28-day table)`);
  }
  // Edges of the band are honoured, not clamped away.
  ok(resolveCycleLength(21).length === 21 && !resolveCycleLength(21).fellBack, "21 is accepted");
  ok(resolveCycleLength(45).length === 45 && !resolveCycleLength(45).fellBack, "45 is accepted");
  ok(cycleDayToStatus(29, 45) === "ovulatory", "45-day: day 29 -> ovulatory");
  ok(cycleDayToStatus(47, 45) === "luteal" && cycleDayToStatus(48, 45) === null, "45-day: 47 luteal, 48 null");
  // Blank / missing / non-numeric = "not provided" = 28, NOT a fallback.
  for (const blank of ["", "   ", null, undefined, "abc"]) {
    const r = resolveCycleLength(blank);
    ok(r.length === 28 && !r.fellBack, `cycle length ${JSON.stringify(blank)} -> 28 (not provided)`);
  }
  ok(resolveCycleLength("32").length === 32, "string '32' parses");
  ok(resolveCycleLength(32.7).length === 32, "fractional length floors");
  ok(cycleDayToStatus(18, 32.7) === "ovulatory", "fractional length 32.7 behaves as 32 (day 18 -> ovulatory)");
}

// ----- 22. phaseWindowLabel (dynamic day spans for the form line) -----

{
  ok(phaseWindowLabel("early_follicular", 28) === "day 1-5", "28: early follicular label");
  ok(phaseWindowLabel("mid_follicular", 28) === "day 6-11", "28: mid-follicular label");
  ok(phaseWindowLabel("ovulatory", 28) === "day 12-15", "28: ovulatory label");
  ok(phaseWindowLabel("mid_luteal", 28) === "day 21-23", "28: mid-luteal label");
  ok(phaseWindowLabel("luteal", 28) === "day 16-20 or 24-28", "28: luteal lists both spans without a day");
  ok(phaseWindowLabel("luteal", 28, 18) === "day 16-20", "28: luteal + day 18 -> first span");
  ok(phaseWindowLabel("luteal", 28, 26) === "day 24-28", "28: luteal + day 26 -> late span");
  ok(phaseWindowLabel("luteal", 28, 30) === "day 24-28", "28: luteal + day 30 (running long) -> late span");
  ok(phaseWindowLabel("luteal", 32, 22) === "day 20-24", "32: luteal + day 22 -> day 20-24");
  ok(phaseWindowLabel("ovulatory", 32) === "day 16-19", "32: ovulatory label");
  ok(phaseWindowLabel("mid_follicular", 24) === "day 6-7", "24: mid-follicular label");
  ok(phaseWindowLabel("ovulatory", 21) === "day 6-8", "21: ovulatory label");
  ok(phaseWindowLabel("luteal") === "day 16-20 or 24-28", "default length is 28");
  ok(phaseWindowLabel("ovulatory", 50) === "day 12-15", "out-of-band length labels as 28");
  for (const s of ["not_sure", "postmenopausal", "postmenopausal_hrt", "birth_control"] as HormoneStatus[]) {
    ok(phaseWindowLabel(s, 28) === null, `${s} has no day span`);
  }
  // The label agrees with cycleDayToStatus for every day of every length.
  let agree = true;
  for (let L = 21; L <= 45; L++) {
    for (let d = 1; d <= L; d++) {
      const st = cycleDayToStatus(d, L);
      const label = st ? phaseWindowLabel(st, L, d) : null;
      const m = label?.match(/^day (\d+)(?:-(\d+))?$/);
      if (!m) { agree = false; continue; }
      const lo = Number(m[1]);
      const hi = m[2] ? Number(m[2]) : lo;
      if (d < lo || d > hi) agree = false;
    }
  }
  ok(agree, "phaseWindowLabel span contains the day for every day of every length 21-45");
}

// ----- 23. Overlay: patient-facing cycle-timing note -----

{
  const noteRe = /estimated (\d+)-day cycle \(ovulation ~day (\d+)\)/;
  const std = applyHormoneOverlay(sydneyEngine, { sex: "female", status: "luteal" });
  ok(!std.summary.notes.some((n) => noteRe.test(n)), "no cycle length -> no timing note");
  const blank = applyHormoneOverlay(sydneyEngine, { sex: "female", status: "luteal", cycleLength: "", cycleDay: "18" });
  ok(!blank.summary.notes.some((n) => noteRe.test(n)), "blank cycle length -> no timing note");
  const twentyEight = applyHormoneOverlay(sydneyEngine, { sex: "female", status: "luteal", cycleLength: "28", cycleDay: "18" });
  ok(!twentyEight.summary.notes.some((n) => noteRe.test(n)), "28-day cycle -> no timing note");
  ok(
    twentyEight.summary.applied.length === std.summary.applied.length &&
      twentyEight.markers.every((m, i) => m.flagStatus === std.markers[i].flagStatus && m.flagSeverity === std.markers[i].flagSeverity),
    "cycle inputs never change the per-marker flags",
  );

  const long = applyHormoneOverlay(sydneyEngine, { sex: "female", status: "luteal", cycleLength: "32", cycleDay: "22" });
  const note = long.summary.notes.find((n) => noteRe.test(n));
  ok(!!note, "32-day cycle -> timing note present");
  ok(!!note && /estimated 32-day cycle \(ovulation ~day 18\)/.test(note), "note names 32 days and ovulation ~day 18");
  ok(!!note && note.includes("drawn on cycle day 22"), "note quotes the cycle day");
  ok(!!note && note.includes("adjusted from the standard 28-day timing"), "note says it was adjusted from 28");
  ok(!!note && note.includes("Confirm the sample was drawn on the intended cycle day"), "note asks the patient to confirm the draw day");
  ok(long.summary.notes[long.summary.notes.length - 1] === note, "timing note is the last note (after the range notes)");
  ok(
    long.markers.every((m, i) => m.flagStatus === std.markers[i].flagStatus && m.flagSeverity === std.markers[i].flagSeverity),
    "32-day cycle: per-marker flags identical to the 28-day run",
  );
  const noDay = applyHormoneOverlay(sydneyEngine, { sex: "female", status: "luteal", cycleLength: 24 });
  const n2 = noDay.summary.notes.find((n) => noteRe.test(n));
  ok(!!n2 && /24-day cycle \(ovulation ~day 10\)/.test(n2) && !n2.includes("from a sample drawn on cycle day"), "numeric length, no day -> note without the draw-day clause");

  // Gated: only a cycling phase, only when something was applied, female only.
  const notSureLong = applyHormoneOverlay(sydneyEngine, { sex: "female", status: "not_sure", cycleLength: "32", cycleDay: "22" });
  ok(!notSureLong.summary.notes.some((n) => noteRe.test(n)), "not sure + 32 -> no timing note");
  const postLong = applyHormoneOverlay(sydneyEngine, { sex: "female", status: "postmenopausal", cycleLength: "32" });
  ok(!postLong.summary.notes.some((n) => noteRe.test(n)), "postmenopausal + 32 -> no timing note");
  const bcLong = applyHormoneOverlay(sydneyEngine, { sex: "female", status: "birth_control", cycleLength: "32" });
  ok(!bcLong.summary.notes.some((n) => noteRe.test(n)), "birth control + 32 -> nothing applied, no timing note");
  const maleLong = applyHormoneOverlay(sydneyEngine, { sex: "male", status: "luteal", cycleLength: "32", cycleDay: "22" });
  ok(maleLong.markers === sydneyEngine && maleLong.summary.notes.length === 0, "male + cycle inputs -> overlay still a no-op");
  const fallbackLong = applyHormoneOverlay(sydneyEngine, { sex: "female", status: "luteal", cycleLength: "50", cycleDay: "22" });
  ok(!fallbackLong.summary.notes.some((n) => noteRe.test(n)), "out-of-band length (50) reads as 28 -> no timing note");
  const noHormones = applyHormoneOverlay(flagMarkers([matched("Glucose", 90, "mg/dL", "65-99")]), {
    sex: "female",
    status: "luteal",
    cycleLength: "32",
    cycleDay: "22",
  });
  ok(noHormones.summary.notes.length === 0, "panel without hormones -> no notes at all, timing note included");
}

// ----- Report -----

if (failures.length) {
  console.error(`hormone-ranges: ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log(`hormone-ranges: ${passed} assertions passed`);
