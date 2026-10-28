/**
 * Saliva cortisol analysis test. House pattern: a self-contained tsx script
 * with a local ok() helper, non-zero exit on failure.
 *
 * Covers: flagSalivaCortisol() per-sample facts and curve metrics (a normal
 * declining curve, a blunted-morning + flat curve, above-range samples, a
 * rising curve, an incomplete set); the de-identified payload block (allow-
 * listed keys only, no identifiers, assertNoIdentifiers passes); the prompt
 * instruction and schema field appearing only when the block is present; the
 * narrative validator reading cortisolInterpretation; the deterministic
 * analysis carrying the facts; and the Word document rendering the table.
 *
 * Run: npx tsx lib/analysis/saliva-cortisol.test.ts   (or: npm run test:saliva-cortisol)
 */

import mammoth from "mammoth";
import { parseSalivaCortisolText, type SalivaCortisolParse } from "../parsers/saliva-cortisol";
import {
  LOW_AMPLITUDE_DROP_PERCENT,
  cortisolStatusWord,
  flagSalivaCortisol,
  formatCortisolResult,
  slotForSample,
} from "./saliva-cortisol";
import {
  assertNoIdentifiers,
  buildPayload,
  buildReevalPayload,
  serializePayload,
} from "./deidentify";
import {
  buildInitialAnalysisPrompt,
  buildReevalPrompt,
  cortisolContextLines,
  toAnalysisNarrative,
  toReevalNarrative,
} from "./prompt";
import {
  INITIAL_NARRATIVE_SCHEMA,
  REEVAL_NARRATIVE_SCHEMA,
  initialNarrativeSchema,
  reevalNarrativeSchema,
  type InitialNarrativeJson,
  type ReevalNarrativeJson,
} from "./schemas";
import { buildDeterministicAnalysis } from "./deterministic";
import { generateAnalysisReport, generateReevalReport } from "../generator/analysis-word";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else failures.push(`  x ${msg}`);
}

// ----- Fixtures (through the real parser so the two modules agree) -----

function report(values: [number, number, number, number] | number[], times = ["8:18AM", "12:45PM", "5:05PM", "9:20PM"]): SalivaCortisolParse {
  const lines = ["CORTISOL, LC/MS, SALIVA, 4 SAMPLES"];
  values.forEach((v, i) => {
    lines.push(
      `CORTISOL, LC/MS, SALIVA, SAMPLE ${i + 1}`,
      `DRAW DATE ${i + 1} 04/10/2026`,
      `DRAW TIME ${i + 1} ${times[i]}`,
      `CORTISOL, SALIVA SAMPLE ${i + 1} ${v} mcg/dL See Note 1`,
    );
  });
  lines.push(
    "Note 1",
    "8-10 AM: 0.04-0.56 mcg/dL",
    "noon-2 PM: < or = 0.21 mcg/dL",
    "4-6 PM: < or = 0.15 mcg/dL",
    "10 PM-1 AM: < or = 0.09 mcg/dL",
  );
  const parsed = parseSalivaCortisolText(lines.join("\n"));
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
}

// ----- 1. Normal declining curve -----

const normal = flagSalivaCortisol(report([0.42, 0.14, 0.08, 0.03]));
{
  ok(normal.samples.length === 4, "normal: 4 sample facts");
  ok(normal.samples.map((s) => s.slot).join(",") === "morning,noon,afternoon,night", "normal: slots by sample order");
  ok(normal.samples[0].timeLabel === "Morning (8-10 AM)", "normal: morning time label");
  ok(normal.samples[3].timeLabel === "Night (10 PM-1 AM)" && normal.samples[3].drawTime === "9:20 PM", "normal: 9:20 PM sample is the night slot");
  ok(normal.samples.every((s) => s.status === "in-range"), "normal: every sample in range");
  ok(normal.samples[0].rangeText === "0.04-0.56 mcg/dL" && normal.samples[1].rangeText === "<= 0.21 mcg/dL", "normal: range text per slot");
  ok(normal.samples[0].percentOfRange === 73, `normal: morning 0.42 sits 73% up 0.04-0.56 (got ${normal.samples[0].percentOfRange})`);
  ok(normal.samples[1].percentOfRange === null && normal.samples[3].percentOfRange === null, "normal: one-sided windows carry no percent");
  const c = normal.curve;
  ok(c.sampleCount === 4 && c.morningValue === 0.42 && c.nightValue === 0.03, "normal: morning / night values");
  ok(c.morningToNightDrop === 0.39 && c.morningToNightDropPercent === 93, `normal: drop 0.39 (93%) (got ${c.morningToNightDrop}, ${c.morningToNightDropPercent})`);
  ok(c.declinesMonotonically && c.declinesMorningToNight && !c.lowAmplitude, "normal: monotonic decline, not low amplitude");
  ok(c.peakSlot === "morning", "normal: peak in the morning");
  ok(c.pattern === "declining", `normal: pattern declining (got ${c.pattern})`);
  ok(c.aboveRangeSlots.length === 0 && c.belowRangeSlots.length === 0, "normal: nothing out of range");
  ok(c.notes.some((n) => n.includes("Curve shape: declining")), "normal: notes state the shape");
  ok(c.notes.some((n) => n.includes("73% of the way up")), "normal: notes state the morning position");
  ok(!c.notes.some((n) => /diagnos|insufficien|fatigue|dysregulat/i.test(n)), "normal: notes carry no clinical conclusion");
  ok(normal.windowsSource === "printed", "normal: windows printed");
}

// ----- 2. Blunted morning + flat curve -----

const flat = flagSalivaCortisol(report([0.06, 0.05, 0.05, 0.045]));
{
  ok(flat.samples[0].percentOfRange === 4, `flat: morning 0.06 sits 4% up its window (got ${flat.samples[0].percentOfRange})`);
  ok(flat.samples.every((s) => s.status === "in-range"), "flat: every sample inside its window (blunting is a shape, not a range breach)");
  const c = flat.curve;
  ok(c.morningToNightDrop === 0.015 && c.morningToNightDropPercent === 25, `flat: drop 0.015 (25%) (got ${c.morningToNightDrop}, ${c.morningToNightDropPercent})`);
  ok(c.lowAmplitude, `flat: low amplitude (25% < ${LOW_AMPLITUDE_DROP_PERCENT}%)`);
  ok(c.declinesMonotonically && c.declinesMorningToNight, "flat: still a (small) decline");
  ok(c.pattern === "flat", `flat: pattern flat (got ${c.pattern})`);
  ok(c.notes.some((n) => n.includes("Curve shape: flat") && n.includes("low amplitude")), "flat: notes say flat / low amplitude");
}

// ----- 3. Above-range samples, below-range morning -----

{
  const high = flagSalivaCortisol(report([0.7, 0.25, 0.1, 0.12]));
  ok(high.samples[0].status === "above-range" && high.samples[0].percentOfRange === 127, "high: morning 0.70 above range, 127% up the window");
  ok(high.samples[1].status === "above-range" && high.samples[2].status === "in-range" && high.samples[3].status === "above-range", "high: noon and night above their caps");
  ok(high.curve.aboveRangeSlots.join(",") === "morning,noon,night", "high: above-range slots listed in order");
  ok(high.curve.pattern === "declining" && high.curve.declinesMonotonically === false, "high: overall decline but not monotonic (night > afternoon)");
  ok(high.curve.notes.some((n) => n.startsWith("Above the reference window: Morning")), "high: notes list the above-range slots");
  ok(high.curve.notes.some((n) => n.includes("not a steady decline")), "high: notes say it is not a steady decline");

  const low = flagSalivaCortisol(report([0.02, 0.03, 0.02, 0.01]));
  ok(low.samples[0].status === "below-range" && low.samples[0].percentOfRange === -4, "low: morning 0.02 below the floor, -4%");
  ok(low.curve.belowRangeSlots.join(",") === "morning", "low: below-range slot listed");
  ok(low.curve.morningToNightDropPercent === 50 && low.curve.morningToNightDrop === 0.01, "low: 50% fall but only 0.01 mcg/dL");
  ok(low.curve.lowAmplitude && low.curve.pattern === "flat", "low: tiny absolute fall -> flat even at 50%");
}

// ----- 4. Rising and incomplete curves -----

{
  const rising = flagSalivaCortisol(report([0.05, 0.1, 0.12, 0.2]));
  ok(rising.curve.pattern === "rising" && !rising.curve.declinesMorningToNight && !rising.curve.declinesMonotonically, "rising: pattern rising");
  ok(rising.curve.peakSlot === "night" && rising.curve.morningToNightDropPercent === -300, "rising: peak at night, negative drop");
  ok(rising.curve.notes.some((n) => n.includes("rise of 0.2")), "rising: notes describe a rise");

  const partial = flagSalivaCortisol(report([0.3, 0.1]));
  ok(partial.curve.sampleCount === 2 && partial.curve.pattern === "incomplete", "partial: two samples -> incomplete");
  ok(partial.curve.morningToNightDrop === null && partial.curve.nightValue === null, "partial: no night value, no drop");
  ok(partial.curve.notes.some((n) => n.includes("Only 2 of the 4")), "partial: notes say only 2 of 4 were readable");

  const standard = flagSalivaCortisol({ ...report([0.3, 0.1, 0.08, 0.04]), windowsSource: "standard" });
  ok(standard.windowsSource === "standard" && standard.curve.notes.some((n) => n.includes("standard saliva windows")), "standard windows are called out in the notes");

  ok(slotForSample(1) === "morning" && slotForSample(4) === "night" && slotForSample(5) === null && slotForSample(0) === null, "slotForSample maps 1-4 only");
  ok(cortisolStatusWord("in-range") === "OPTIMAL" && cortisolStatusWord("above-range") === "HIGH" && cortisolStatusWord("below-range") === "LOW", "status words use the chart vocabulary");
  ok(formatCortisolResult(normal.samples[0]) === "0.42 mcg/dL", "result formats with unit");
  ok(formatCortisolResult({ ...normal.samples[0], value: 0.02, qualifier: "<" }) === "<0.02 mcg/dL", "censored result keeps its qualifier");
}

// ----- 5. De-identified payload block -----

const identifiers = { patientName: "Jane Doe", dob: "1980-01-02" };
const basePayload = buildPayload([], {
  age: 46,
  sex: "female",
  intake: "Tired all day, wired at night. Jane Doe, DOB 1980-01-02.",
  patientName: identifiers.patientName,
  dob: identifiers.dob,
  salivaCortisol: normal,
});
{
  ok(basePayload.salivaCortisol !== null, "payload carries the cortisol block");
  const block = basePayload.salivaCortisol!;
  ok(Object.keys(block).sort().join(",") === "curve,samples,windowsSource", "block has exactly samples / curve / windowsSource");
  ok(
    block.samples.every((s) => Object.keys(s).sort().join(",") === "drawTime,percentOfRange,rangeText,status,timeLabel,unit,value"),
    "sample rows carry only the allow-listed fields",
  );
  ok(
    Object.keys(block.curve).sort().join(",") ===
      "aboveRangeSlots,belowRangeSlots,declinesMonotonically,lowAmplitude,morningToNightDropPercent,notes,pattern,peakSlot",
    "curve carries only the allow-listed fields",
  );
  ok(!("sampleNo" in block.samples[0]) && !("window" in block.samples[0]) && !("qualifier" in block.samples[0]), "parser-side fields are not copied through");
  const serialized = serializePayload(basePayload);
  ok(!serialized.includes("04/10/2026") && !/\b2026\b/.test(serialized), "no draw date in the payload");
  ok(serialized.includes('"drawTime": "8:18 AM"'), "clock time is allowed through");
  for (const id of ["Jane", "Doe", "1980-01-02", "01/02/1980", "Specimen", "Patient ID"]) {
    ok(!serialized.includes(id), `payload carries no "${id}"`);
  }
  let threw = false;
  try {
    assertNoIdentifiers(serialized, identifiers);
  } catch {
    threw = true;
  }
  ok(!threw, "assertNoIdentifiers passes with the cortisol block present");

  const none = buildPayload([], { age: 46, sex: "female", intake: "", patientName: "Jane Doe" });
  ok(none.salivaCortisol === null, "no saliva report -> salivaCortisol is null (key still present)");

  const reeval = buildReevalPayload([], {
    age: 46,
    sex: "female",
    intake: "",
    patientName: "Jane Doe",
    dob: identifiers.dob,
    salivaCortisol: flat,
    priorPanelInterval: "~6 months",
    priorReportText: "prior text",
  });
  ok(reeval.salivaCortisol?.curve.pattern === "flat", "re-eval payload carries the block too");
}

// ----- 6. Prompt instruction + schema field, only when present -----

{
  const withPrompt = buildInitialAnalysisPrompt(basePayload);
  ok(withPrompt.includes("SALIVARY CORTISOL (4 timed samples"), "initial prompt: cortisol context present");
  ok(withPrompt.includes("pattern = declining"), "initial prompt: pattern stated");
  ok(withPrompt.includes("- cortisolInterpretation:"), "initial prompt: field spec present");
  for (const caveat of ["single-day snapshot", "does not diagnose adrenal insufficiency", "8 AM", "ACTH", "wake time", "sleep aids"]) {
    ok(withPrompt.includes(caveat), `initial prompt: caveat "${caveat}" present`);
  }
  ok(withPrompt.includes("cortisol dysregulation"), "initial prompt: functional framing in the practitioner's words");
  ok(withPrompt.includes('"salivaCortisol"'), "initial prompt: the block is in the JSON data");

  const without = buildInitialAnalysisPrompt({ ...basePayload, salivaCortisol: null });
  ok(!without.includes("SALIVARY CORTISOL") && !without.includes("cortisolInterpretation"), "initial prompt: nothing about cortisol without the block");
  ok(cortisolContextLines(null).length === 0 && cortisolContextLines(undefined).length === 0, "cortisolContextLines: empty without a block");

  const reevalPayload = buildReevalPayload([], {
    age: 46,
    sex: "female",
    intake: "",
    patientName: "Jane Doe",
    salivaCortisol: flat,
    priorPanelInterval: null,
    priorReportText: "prior",
  });
  const rp = buildReevalPrompt(reevalPayload);
  ok(rp.includes("SALIVARY CORTISOL") && rp.includes("- cortisolInterpretation:") && rp.includes("(low amplitude"), "re-eval prompt: context, field spec and low-amplitude note present");
  ok(!buildReevalPrompt({ ...reevalPayload, salivaCortisol: null }).includes("cortisol"), "re-eval prompt: silent without the block");

  const sWith = initialNarrativeSchema({ cortisol: true }) as { properties: Record<string, unknown>; required: string[] };
  const sWithout = initialNarrativeSchema({ cortisol: false }) as { properties: Record<string, unknown>; required: string[] };
  ok("cortisolInterpretation" in sWith.properties && sWith.required.includes("cortisolInterpretation"), "initial schema: field added and required when requested");
  ok(!("cortisolInterpretation" in sWithout.properties) && sWithout === (INITIAL_NARRATIVE_SCHEMA as unknown), "initial schema: untouched base otherwise");
  ok(JSON.stringify(sWith.required.slice(0, -1)) === JSON.stringify(INITIAL_NARRATIVE_SCHEMA.required), "initial schema: base required list preserved in order");
  const rWith = reevalNarrativeSchema({ cortisol: true }) as { properties: Record<string, unknown>; required: string[] };
  ok("cortisolInterpretation" in rWith.properties && rWith.required.includes("cortisolInterpretation"), "re-eval schema: field added when requested");
  ok(reevalNarrativeSchema({ cortisol: false }) === (REEVAL_NARRATIVE_SCHEMA as unknown), "re-eval schema: untouched base otherwise");
}

// ----- 7. Narrative validator reads the field -----

const summary = { whatsGoingWell: "a", likelyDrivers: "b", planInPlainLanguage: "c" };
const pattern = { pattern: "p", bullets: ["x"], symptomTags: [], relevanceToChiefConcern: "r" };
const phase = { phase: "Phase 1", goal: "g", bullets: ["y"] };
const initialJson: InitialNarrativeJson = {
  chiefConcern: "fatigue",
  clinicalPresentation: ["tired"],
  reassuringNarrative: "fine",
  rootCauseAnalysis: [pattern],
  phasedProtocol: [phase],
  patientSummary: summary,
};
{
  const n0 = toAnalysisNarrative(initialJson);
  ok(n0.cortisol.length === 0, "narrative: no cortisolInterpretation -> empty blocks");
  const n1 = toAnalysisNarrative({
    ...initialJson,
    cortisolInterpretation: ["Morning output is adequate.", "", "  ", "This is a single-day snapshot."],
  });
  ok(n1.cortisol.length === 2 && n1.cortisol.every((b) => b.type === "paragraph"), "narrative: paragraphs, blanks dropped");
  ok(n1.cortisol[1].text === "This is a single-day snapshot.", "narrative: text trimmed and kept verbatim");
  const n2 = toAnalysisNarrative({ ...initialJson, cortisolInterpretation: [] });
  ok(n2.cortisol.length === 0, "narrative: empty array is not a parse failure");

  const reevalJson: ReevalNarrativeJson = {
    chiefConcern: "fatigue",
    priorMarkers: [],
    overview: ["o"],
    comparativeRootCause: [pattern],
    updatedProtocol: [phase],
    alreadyImproving: [],
    backgroundFindings: [],
    patientSummary: summary,
    cortisolInterpretation: ["Flat curve."],
  };
  ok(toReevalNarrative(reevalJson).cortisol.length === 1, "re-eval narrative: reads the field");
  ok(toReevalNarrative({ ...reevalJson, cortisolInterpretation: undefined }).cortisol.length === 0, "re-eval narrative: absent -> empty");
}

// ----- 8. Deterministic analysis + Word rendering -----

(async () => {
  const analysis = buildDeterministicAnalysis([], {
    patientName: "Jane Doe",
    patientDate: "2026-04-10",
    dob: "1980-01-02",
    sex: "female",
    salivaCortisol: normal,
  });
  ok(analysis.salivaCortisol === normal && analysis.salivaCortisolNote === null, "deterministic: carries the facts");
  const bare = buildDeterministicAnalysis([], { patientName: "P", patientDate: "2026-04-10" });
  ok(bare.salivaCortisol === null && bare.salivaCortisolNote === null, "deterministic: null without a report");

  const text = async (buf: Buffer) => (await mammoth.extractRawText({ buffer: buf })).value;

  const placeholderDoc = await text(await generateAnalysisReport(analysis, null));
  ok(placeholderDoc.includes("Salivary Cortisol"), "docx: cortisol heading rendered");
  for (const cell of ["Morning (8-10 AM)", "drawn 8:18 AM", "0.42 mcg/dL", "0.04-0.56 mcg/dL", "Night (10 PM-1 AM)", "<= 0.09 mcg/dL", "In Range"]) {
    ok(placeholderDoc.includes(cell), `docx: table shows "${cell}"`);
  }
  ok(placeholderDoc.includes("Curve shape: declining"), "docx: curve facts printed");
  ok(placeholderDoc.includes("Diurnal Cortisol Interpretation") && placeholderDoc.includes("generated narrative goes here"), "docx: placeholder when no narrative");

  const narrated = await text(
    await generateAnalysisReport(analysis, {
      ...toAnalysisNarrative(initialJson),
      cortisol: [{ type: "paragraph", text: "Morning output is adequate and the curve falls as expected." }],
    }),
  );
  ok(narrated.includes("Diurnal interpretation") && narrated.includes("Morning output is adequate and the curve falls as expected."), "docx: model interpretation rendered under the table");
  ok(!narrated.includes("generated narrative goes here"), "docx: no placeholder when narrated");

  const high = flagSalivaCortisol(report([0.7, 0.25, 0.1, 0.12]));
  const highDoc = await text(await generateAnalysisReport(buildDeterministicAnalysis([], { patientName: "P", patientDate: "2026-04-10", salivaCortisol: high }), null));
  ok(highDoc.includes("Out of Lab Range") && highDoc.includes("(High)"), "docx: above-range sample gets the red High chip");

  const noteDoc = await text(
    await generateAnalysisReport(
      buildDeterministicAnalysis([], { patientName: "P", patientDate: "2026-04-10", salivaCortisolNote: "The uploaded saliva cortisol file was not recognised." }),
      null,
    ),
  );
  ok(noteDoc.includes("Salivary Cortisol") && noteDoc.includes("was not recognised"), "docx: unreadable upload prints the note");

  const noneDoc = await text(await generateAnalysisReport(bare, null));
  ok(!noneDoc.includes("Salivary Cortisol"), "docx: nothing rendered without a report");

  const reevalDoc = await text(await generateReevalReport(analysis, true, null, "2025-10-01"));
  ok(reevalDoc.includes("Salivary Cortisol") && reevalDoc.includes("0.42 mcg/dL"), "re-eval docx: cortisol section rendered");

  // ----- Report -----
  if (failures.length) {
    console.error(`saliva-cortisol: ${failures.length} failed, ${passed} passed`);
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log(`saliva-cortisol: ${passed} assertions passed`);
})();
