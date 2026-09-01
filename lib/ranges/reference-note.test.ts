/**
 * Unparseable reference tables: capture, display, and sex-based selection.
 *
 * House pattern — self-contained tsx script, local ok(), non-zero exit on
 * failure. Run: npx tsx lib/ranges/reference-note.test.ts
 *
 * The bug this pins down: Quest prints leptin's reference as a sex/BMI/age
 * table, not a low-high pair. parseReferenceRange rightly refuses it, but the
 * report then left the Standard Lab Range cell blank (in the deployed tool it
 * came out as the garbled fragment "s for Leptin:") and no lab-range flag
 * computed. The reference must never be dropped, and where the caller knows the
 * patient's sex the correct row must drive the flag.
 *
 * Estradiol (second half of this file) is the same class of bug one level up,
 * in the parser: the line "Reference range established on post-pubertal
 * patient" opens seven lines of assay prose, and the spill rule stored the
 * clause after "Reference range" as if it were the range. The range cell must
 * show a real range or the captured reference table — never a prose fragment.
 */

import { compactReferenceNote, referenceNoteForCell } from "./reference-note";
import { matchMarkers } from "../matcher";
import { flagMarkers } from "../flagging";
import { formatLabRange } from "../analysis/deterministic";
import { parseReferenceRange } from "../flagging/range-parse";
import { parseQuestText } from "../parsers/quest";
import type { ParsedMarker } from "../parsers/types";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else failures.push(`  x ${msg}`);
}
const eq = (actual: string, expected: string, label: string) =>
  ok(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

/** Verbatim from samples/function/Lab Results of Record GC.pdf. */
const LEPTIN_REFERENCE =
  "Reference Ranges for Leptin: Adult Lean Subjects (18-71 years) with BMI range " +
  "of 18-25: Males: 0.3-13.4 ng/mL Females: 4.7-23.7 ng/mL Adult Subjects (19-60 " +
  "years) with BMI range of 25-30: Males: 1.8-19.9 ng/mL Females: 8.0-38.9 ng/mL " +
  "Pediatric Reference Ranges for Leptin: 5-9.9 years: 0.6-16.8 ng/mL 10-13.9 " +
  "years: 1.4-16.5 ng/mL 14-17.9 years: 0.6-24.9 ng/mL";

function leptin(value: number): ParsedMarker {
  return {
    rawName: "LEPTIN",
    value,
    unit: "ng/mL",
    labFlagFromPdf: null,
    // This is the point of the fixture: no parseable range, but a reference
    // block that very much exists.
    referenceRangeRaw: null,
    referenceNoteRaw: LEPTIN_REFERENCE,
    pageNumber: 1,
    rawLine: `LEPTIN ${value} ng/mL EZ`,
  };
}

function main() {
  // ----- The premise: this reference genuinely does not parse -----
  const parsed = parseReferenceRange(LEPTIN_REFERENCE);
  ok(
    parsed.min === null && parsed.max === null,
    `the stratified table does not reduce to one range (got ${parsed.min}-${parsed.max})`,
  );

  // ----- 1. The text is never dropped -----
  const compact = compactReferenceNote(LEPTIN_REFERENCE)!;
  ok(!!compact, "a reference block always compacts to something");
  eq(compact.text, "M 0.3-13.4 / F 4.7-23.7 (adult lean)", "leptin compaction");
  ok(compact.truncated, "compaction reports that the table carries more strata");
  ok(compact.text.length <= 46, `compacted text fits the cell (${compact.text.length} chars)`);
  // Must pick the ADULT LEAN rows, not the BMI 25-30 rows further down.
  ok(!compact.text.includes("1.8"), "does not pick the BMI 25-30 male row");
  ok(!compact.text.includes("8.0"), "does not pick the BMI 25-30 female row");

  // The header is not worth cell space — the numbers under it are. This is the
  // Cortisol case, where truncating the header away used to eat every figure.
  const cortisol = compactReferenceNote(
    "Adult Reference Ranges for Cortisol, Total: 8-10 AM 4.6-20.6 mcg/dL 4-6 PM 1.8-13.6 mcg/dL",
  )!;
  eq(cortisol.text, "8-10 AM 4.6-20.6 mcg/dL 4-6 PM 1.8-13.6 mcg/dL", "cortisol keeps its figures");
  ok(/4\.6-20\.6/.test(cortisol.text), "cortisol AM range survives compaction");
  ok(/1\.8-13\.6/.test(cortisol.text), "cortisol PM range survives compaction");
  ok(!/Reference Ranges for/i.test(cortisol.text), "the header prefix is dropped");

  // Generic fallback: any future unparseable table, with no sex rows at all.
  const generic = compactReferenceNote(
    "Reference Ranges for Widgetase: Cohort A (18-40): 10-20 U/L Cohort B (41-65): 12-24 U/L",
  )!;
  ok(generic.text.length > 0, "an unfamiliar table still yields cell text");
  ok(generic.text.length <= 46, `unfamiliar table is abridged to fit (${generic.text.length})`);
  ok(generic.truncated, "abridgement is reported as truncated");
  ok(generic.text.endsWith("…"), "abridged text is visibly abridged");
  ok(!/\s…$/.test(generic.text), "abridgement does not leave a dangling space");

  // Short enough to show whole -> shown whole, not marked truncated.
  const short = compactReferenceNote("Negative at 1:40 dilution")!;
  eq(short.text, "Negative at 1:40 dilution", "short reference shown verbatim");
  ok(!short.truncated, "short reference is not marked truncated");

  // Nothing in, nothing out — callers keep their em dash for that case.
  ok(compactReferenceNote("") === null, "empty note yields null");
  ok(compactReferenceNote(null) === null, "null note yields null");
  ok(compactReferenceNote("   ") === null, "whitespace-only note yields null");
  ok(referenceNoteForCell(null) === null, "referenceNoteForCell passes null through");

  // ----- 2. Sex-based selection drives the flag where sex is known -----
  const matched = matchMarkers([leptin(1.3)]);
  ok(matched[0]?.canonicalName === "Leptin", `leptin matches the dictionary (got ${matched[0]?.canonicalName})`);
  ok(
    matched[0]?.referenceNoteRaw === LEPTIN_REFERENCE,
    "the matcher carries the reference note through untouched",
  );

  // Sex unknown -> display only. This is the guard that stopped a male patient
  // being flagged "low" against the female range.
  const unknown = flagMarkers(matched)[0];
  eq(unknown.flagStatus, "not_flaggable", "sex unknown leaves leptin display-only");
  ok(
    unknown.flagNotes.some((n) => /sex\/BMI reference table/i.test(n)),
    "sex-unknown path explains itself in the notes",
  );
  // Even unflagged, the range cell must show the printed reference.
  eq(
    formatLabRange(unknown),
    "M 0.3-13.4 / F 4.7-23.7 (adult lean)",
    "range cell shows the reference even when not flagged",
  );
  ok(formatLabRange(unknown) !== "—", "range cell is never an em dash when the lab printed a table");

  // 1.3 ng/mL: inside the male range, below the female range.
  const male = flagMarkers(matched, { sex: "male" })[0];
  eq(male.flagStatus, "optimal", "1.3 is optimal for a male");
  ok(male.effectiveLabRange?.min === 0.3 && male.effectiveLabRange?.max === 13.4, "male range selected");
  eq(String(male.labRangeSource), "sex_selected", "male range is marked sex-selected");
  ok(
    male.flagNotes.some((n) => /sex-selected adult reference/i.test(n)),
    "male flag notes record the sex selection",
  );

  const female = flagMarkers(matched, { sex: "female" })[0];
  eq(female.flagStatus, "low", "1.3 is low for a female");
  eq(String(female.flagDirection), "low", "female flag direction is low");
  ok(female.effectiveLabRange?.min === 4.7 && female.effectiveLabRange?.max === 23.7, "female range selected");

  // A value inside BOTH ranges must not flag for either sex.
  const bothOk = matchMarkers([leptin(8.0)]);
  eq(flagMarkers(bothOk, { sex: "male" })[0].flagStatus, "optimal", "8.0 optimal for male");
  eq(flagMarkers(bothOk, { sex: "female" })[0].flagStatus, "optimal", "8.0 optimal for female");

  // A value above both must flag high for either sex.
  const tooHigh = matchMarkers([leptin(40)]);
  eq(flagMarkers(tooHigh, { sex: "male" })[0].flagStatus, "high", "40 high for male");
  eq(flagMarkers(tooHigh, { sex: "female" })[0].flagStatus, "high", "40 high for female");

  // ----- 3. Sex selection must not leak into other markers -----
  const glucose: ParsedMarker = {
    rawName: "GLUCOSE",
    value: 95,
    unit: "mg/dL",
    labFlagFromPdf: null,
    referenceRangeRaw: "65-99",
    pageNumber: 1,
    rawLine: "GLUCOSE 95 mg/dL 65-99",
  };
  const gMatched = matchMarkers([glucose]);
  const gPlain = flagMarkers(gMatched)[0];
  const gSexed = flagMarkers(gMatched, { sex: "female" })[0];
  eq(gSexed.flagStatus, gPlain.flagStatus, "a normal marker flags identically with sex supplied");
  eq(
    JSON.stringify(gSexed.effectiveLabRange),
    JSON.stringify(gPlain.effectiveLabRange),
    "a normal marker's effective range is unaffected by sex",
  );

  estradiol();

  if (failures.length > 0) {
    console.error(`\nreference-note: ${failures.length} FAILED, ${passed} passed\n`);
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(`reference-note: all ${passed} assertions passed`);
}

/** The assay disclaimer Quest prints under every Estradiol result. Verbatim
 *  from samples/function/Lab Results of Record GC.pdf (identical in SW1, TM).
 *  Line 1 is the trap: it opens "Reference range ..." with no colon. */
const ESTRADIOL_PROSE = [
  "Reference range established on post-pubertal patient",
  "population. No pre-pubertal reference range",
  "established using this assay. For any patients for",
  "whom low Estradiol levels are anticipated (e.g. males,",
  "pre-pubertal children and hypogonadal/post-menopausal",
  "females), the Quest Diagnostics Nichols Institute",
  "Estradiol, Ultrasensitive, LCMSMS assay is recommended",
  "(order code 30289).",
];

/** GC / SW1 shape: the result row carries its own range, and the prose follows.
 *  Verbatim from samples/function/Lab Results of Record GC.pdf. */
const ESTRADIOL_WITH_RANGE = [
  "Test In Range Out Of Range Reference Range Lab",
  "ESTRADIOL Collected: 02/27/2026 12:06 PM UTC Received: 02/27/2026 12:09 PM UTC",
  "ESTRADIOL 37 < OR = 39 pg/mL NL1",
  ...ESTRADIOL_PROSE,
].join("\n");

/** TM shape: the result row carries NO range at all. What Quest prints instead
 *  is a cycle-phase table, and then the same prose. Verbatim from
 *  samples/function/Lab Results of Record TM.pdf. */
const ESTRADIOL_PHASE_TABLE = [
  "Test In Range Out Of Range Reference Range Lab",
  "ESTRADIOL Collected: 03/17/2026 02:35 PM UTC Received: 03/17/2026 02:36 PM UTC",
  "ESTRADIOL 37 pg/mL NL1",
  "Reference Range",
  "Female:",
  "Follicular Phase: 30-144",
  "Mid-Cycle: 64-357",
  "Luteal Phase: 56-214",
  "Postmenopausal: < or = 31",
  ...ESTRADIOL_PROSE,
].join("\n");

/** Any word that could only have come from the disclaimer paragraph. */
const PROSE_LEAK_RE = /post-pubertal|established (on|using)|assay|fulvestrant|order code/i;

function estradiolFrom(text: string) {
  const parsed = parseQuestText(text).markers.filter((m) => m.rawName === "ESTRADIOL");
  ok(parsed.length === 1, `one estradiol marker parsed (got ${parsed.length})`);
  return parsed[0];
}

function estradiol() {
  // ----- The row that HAS a range: prose must not append to it -----
  const withRange = estradiolFrom(ESTRADIOL_WITH_RANGE);
  eq(withRange.referenceRangeRaw ?? "", "< OR = 39", "printed range is kept exactly");
  ok(
    !PROSE_LEAK_RE.test(withRange.referenceRangeRaw ?? ""),
    `no prose appended to the range (got ${JSON.stringify(withRange.referenceRangeRaw)})`,
  );
  const flaggedWithRange = flagMarkers(matchMarkers([withRange]))[0];
  eq(formatLabRange(flaggedWithRange), "≤ 39", "range cell shows the printed range");

  // ----- The row that has NONE: the phase table stands in, not the prose -----
  const phaseTable = estradiolFrom(ESTRADIOL_PHASE_TABLE);
  ok(
    !phaseTable.referenceRangeRaw,
    `a row printing no range gets no range (got ${JSON.stringify(phaseTable.referenceRangeRaw)})`,
  );
  const note = phaseTable.referenceNoteRaw ?? "";
  ok(!!note, "the cycle-phase table Quest printed is captured");
  ok(/Follicular Phase: 30-144/.test(note), "the table's figures survive capture");
  ok(/Postmenopausal: < or = 31/.test(note), "capture runs to the last stratum row");
  ok(!PROSE_LEAK_RE.test(note), `capture stops before the prose (got ${JSON.stringify(note)})`);

  const flaggedPhase = flagMarkers(matchMarkers([phaseTable]))[0];
  const cell = formatLabRange(flaggedPhase);
  ok(cell !== "—", "range cell is not an em dash when the lab printed a table");
  ok(/Follicular Phase: 30-144/.test(cell), `range cell leads with the printed table (got ${cell})`);
  ok(!PROSE_LEAK_RE.test(cell), `range cell carries no prose (got ${JSON.stringify(cell)})`);
  ok(cell.length <= 46, `range cell fits the column (${cell.length} chars)`);

  // ----- The rule generalised: a colon-less "Reference range ..." prose line
  // never becomes a range, while a real spill still does. -----
  const spill = parseQuestText(
    ["Test In Range Out Of Range Reference Range Lab", "HOMOCYSTEINE 8.4 umol/L NL1", "Reference range: <10.4"].join("\n"),
  ).markers.find((m) => m.rawName === "HOMOCYSTEINE");
  eq(spill?.referenceRangeRaw ?? "", "<10.4", "a genuine spilled range is still captured");
}

main();
