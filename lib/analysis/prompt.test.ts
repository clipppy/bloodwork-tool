/**
 * Empty-phase filtering in the narrative validators. Same house pattern as the
 * other tests here: a self-contained tsx script with a local ok(), non-zero
 * exit on failure.
 *
 * The structured-output API occasionally appends a filler entry
 * ({phase:"", goal:"", bullets:[]}) after the real protocol phases. That must
 * be dropped silently rather than surface to the practitioner as a failed
 * generation — but ONLY when the entry is empty in every field. A phase that
 * names itself and then carries no bullets is a malformed narrative and must
 * still be rejected.
 *
 * Run: npx tsx lib/analysis/prompt.test.ts  (or: npm run test:prompt)
 */

import {
  buildInitialAnalysisPrompt,
  buildReevalPrompt,
  cortisolContextLines,
  isEmptyPhaseEntry,
  markerNotesFrom,
  toAnalysisNarrative,
  toReevalNarrative,
  NarrativeParseError,
} from "./prompt";
import { buildPayload, buildReevalPayload } from "./deidentify";
import { parseSalivaCortisolText } from "../parsers/saliva-cortisol";
import { flagSalivaCortisol } from "./saliva-cortisol";
import {
  INITIAL_NARRATIVE_SCHEMA,
  REEVAL_NARRATIVE_SCHEMA,
  initialNarrativeSchema,
  reevalNarrativeSchema,
  type InitialNarrativeJson,
  type ReevalNarrativeJson,
} from "./schemas";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else failures.push(`  x ${msg}`);
}

const realPhase = {
  phase: "Phase 1 - Foundation & Stabilization (Weeks 1-4)",
  goal: "Stabilize the basics.",
  bullets: ["Introduce a protein-forward breakfast."],
};

const pattern = {
  pattern: "Blood sugar drifting up",
  bullets: ["Your fasting sugar is higher than we like to see."],
  symptomTags: ["afternoon fatigue"],
  relevanceToChiefConcern: "This fits the afternoon dip you describe.",
};

const NOTES = [
  { marker: "Glucose", note: "Glucose is the sugar in your blood. Yours runs a little high, which means your body is working harder than it should to keep it steady." },
  { marker: "Ferritin", note: "Ferritin is your iron storage. Low iron stores often show up as tiredness and feeling cold." },
];

function initialJson(phases: unknown[]): InitialNarrativeJson {
  return {
    chiefConcern: "persistent fatigue",
    clinicalPresentation: ["Reports afternoon fatigue."],
    reassuringNarrative: "Thyroid markers are reassuring.",
    rootCauseAnalysis: [pattern],
    phasedProtocol: phases as InitialNarrativeJson["phasedProtocol"],
    markerInterpretations: NOTES,
    patientSummary: {
      whatsGoingWell: "A lot of this panel looks solid.",
      likelyDrivers: "Blood sugar swings are the most likely driver.",
      planInPlainLanguage: "We will start with breakfast and retest.",
    },
  };
}

function reevalJson(phases: unknown[]): ReevalNarrativeJson {
  return {
    chiefConcern: "persistent fatigue",
    priorMarkers: [{ name: "Glucose", priorValue: "112 mg/dL", comparable: true }],
    overview: ["The prior panel flagged glucose."],
    comparativeRootCause: [pattern],
    updatedProtocol: phases as ReevalNarrativeJson["updatedProtocol"],
    alreadyImproving: [],
    backgroundFindings: [],
    markerInterpretations: NOTES,
    patientSummary: {
      whatsGoingWell: "Your numbers moved the right way.",
      likelyDrivers: "The same blood sugar pattern remains the driver.",
      planInPlainLanguage: "Keep the plan and retest.",
    },
  };
}

const rejects = (fn: () => unknown, label: string) => {
  try {
    fn();
    ok(false, `${label}: expected NarrativeParseError, got none`);
  } catch (err) {
    ok(err instanceof NarrativeParseError, `${label}: threw NarrativeParseError`);
  }
};

function main() {
  // ----- isEmptyPhaseEntry: what counts as filler -----
  ok(isEmptyPhaseEntry({ phase: "", goal: "", bullets: [] }), "all-empty entry is filler");
  ok(isEmptyPhaseEntry({ phase: "  ", goal: "", bullets: ["", "  "] }), "whitespace-only entry is filler");
  ok(isEmptyPhaseEntry({}), "empty object is filler");
  ok(isEmptyPhaseEntry(null), "null entry is filler");
  ok(!isEmptyPhaseEntry({ phase: "Phase 5", goal: "", bullets: [] }), "named phase is NOT filler");
  ok(!isEmptyPhaseEntry({ phase: "", goal: "Hold steady.", bullets: [] }), "goal-only entry is NOT filler");
  ok(!isEmptyPhaseEntry({ phase: "", goal: "", bullets: ["Retest."] }), "bulleted entry is NOT filler");
  ok(!isEmptyPhaseEntry(realPhase), "real phase is NOT filler");

  // ----- toAnalysisNarrative: trailing filler dropped, real phases kept -----
  const trailing = toAnalysisNarrative(
    initialJson([realPhase, { phase: "", goal: "", bullets: [] }]),
  );
  ok(
    trailing.protocol.filter((b) => b.type === "heading").length === 1,
    "initial: trailing filler phase dropped",
  );
  ok(
    trailing.protocol.some((b) => b.type === "bullet" && b.text === realPhase.bullets[0]),
    "initial: real phase content survives the filter",
  );

  // Filler between real phases is the same fluke and is also dropped.
  const middle = toAnalysisNarrative(initialJson([realPhase, {}, realPhase]));
  ok(
    middle.protocol.filter((b) => b.type === "heading").length === 2,
    "initial: mid-array filler dropped, both real phases kept",
  );

  // ----- still-rejected shapes are unchanged -----
  rejects(
    () => toAnalysisNarrative(initialJson([{ phase: "", goal: "", bullets: [] }])),
    "initial: filler-only protocol still rejected",
  );
  rejects(() => toAnalysisNarrative(initialJson([])), "initial: empty protocol still rejected");
  rejects(
    () => toAnalysisNarrative(initialJson([realPhase, { phase: "Phase 5", goal: "", bullets: [] }])),
    "initial: named-but-empty phase still rejected",
  );
  rejects(
    () => toAnalysisNarrative(initialJson([{ phase: "", goal: "", bullets: ["Retest."] }])),
    "initial: bullets-without-heading still rejected",
  );

  // ----- toReevalNarrative: same exposure, same filter -----
  const reeval = toReevalNarrative(
    reevalJson([realPhase, { phase: "", goal: "", bullets: [] }]),
  );
  ok(
    reeval.protocol.filter((b) => b.type === "heading").length === 1,
    "reeval: trailing filler phase dropped",
  );
  rejects(
    () => toReevalNarrative(reevalJson([{ phase: "", goal: "", bullets: [] }])),
    "reeval: filler-only protocol still rejected",
  );
  rejects(
    () => toReevalNarrative(reevalJson([realPhase, { phase: "Phase 5", goal: "", bullets: [] }])),
    "reeval: named-but-empty phase still rejected",
  );

  // ----- markerInterpretations: schema shape -----
  for (const [label, schema] of [
    ["initial", INITIAL_NARRATIVE_SCHEMA],
    ["reeval", REEVAL_NARRATIVE_SCHEMA],
  ] as const) {
    type ItemsSchema = {
      type?: string;
      required?: readonly string[];
      additionalProperties?: boolean;
      properties?: Record<string, { type?: string } | undefined>;
    };
    type ArrayField = { type?: string; items?: ItemsSchema } | undefined;
    const field = (schema.properties as Record<string, ArrayField>).markerInterpretations;
    ok(!!field && field.type === "array", `${label} schema: markerInterpretations is an array`);
    ok(field?.items?.type === "object", `${label} schema: items are objects`);
    ok(
      JSON.stringify(field?.items?.required) === JSON.stringify(["marker", "note"]),
      `${label} schema: items require marker + note`,
    );
    ok(field?.items?.additionalProperties === false, `${label} schema: items close additionalProperties`);
    ok(field?.items?.properties?.marker?.type === "string" && field?.items?.properties?.note?.type === "string", `${label} schema: marker and note are strings`);
    ok((schema.required as readonly string[]).includes("markerInterpretations"), `${label} schema: field is required`);
  }
  ok(
    "markerInterpretations" in (initialNarrativeSchema({ cortisol: true }).properties as object) &&
      "markerInterpretations" in (reevalNarrativeSchema({ cortisol: true }).properties as object),
    "cortisol variant keeps markerInterpretations",
  );

  // ----- markerInterpretations: round trip into markerNotes -----
  const n = toAnalysisNarrative(initialJson([realPhase]));
  ok(n.markerNotes.size === 2, `initial: two notes round-trip (got ${n.markerNotes.size})`);
  ok(n.markerNotes.get("Glucose") === NOTES[0].note, "initial: Glucose note keyed by canonical name");
  ok(n.markerNotes.get("Ferritin") === NOTES[1].note, "initial: Ferritin note keyed by canonical name");
  const r = toReevalNarrative(reevalJson([realPhase]));
  ok(r.markerNotes.size === 2 && r.markerNotes.get("Glucose") === NOTES[0].note, "reeval: notes round-trip");
  ok(n.markerNotes.get("Hemoglobin") === undefined, "a marker without an entry has no note");
  // Other sections are unaffected by the new field.
  ok(n.rootCause.length > 0 && n.patientSummary.length > 0, "initial: root cause and summary still render");

  // ----- markerNotesFrom: lenient on bad entries, never throws -----
  ok(markerNotesFrom(undefined).size === 0, "missing field -> empty map");
  ok(markerNotesFrom("nope").size === 0, "non-array -> empty map");
  const lenient = markerNotesFrom([
    { marker: "  Glucose ", note: "  trimmed  " },
    { marker: "", note: "no marker" },
    { marker: "NoNote", note: "   " },
    { marker: "Glucose", note: "second entry ignored" },
    null,
    "junk",
    { marker: 5, note: "wrong type" },
  ]);
  ok(lenient.size === 1 && lenient.get("Glucose") === "trimmed", `bad entries dropped, names and notes trimmed, first wins (got ${JSON.stringify([...lenient])})`);
  const noField = toAnalysisNarrative({ ...initialJson([realPhase]), markerInterpretations: undefined as unknown as InitialNarrativeJson["markerInterpretations"] });
  ok(noField.markerNotes.size === 0, "initial: absent field is not a parse failure");

  // ----- saliva cortisol instruction: one concise paragraph + brief caveats -----
  // The practitioner found the interpretation accurate but too long (~5
  // paragraphs). The instruction now asks for ONE focused paragraph plus the
  // caveats compressed into a sentence or two, with none of the caveats dropped.
  // Fixture through the real parser + flagger (same as saliva-cortisol.test).
  const salivaLines = ["CORTISOL, LC/MS, SALIVA, 4 SAMPLES"];
  [0.42, 0.14, 0.08, 0.03].forEach((v, i) => {
    salivaLines.push(
      `CORTISOL, LC/MS, SALIVA, SAMPLE ${i + 1}`,
      `DRAW DATE ${i + 1} 04/10/2026`,
      `DRAW TIME ${i + 1} ${["8:18AM", "12:45PM", "5:05PM", "9:20PM"][i]}`,
      `CORTISOL, SALIVA SAMPLE ${i + 1} ${v} mcg/dL See Note 1`,
    );
  });
  salivaLines.push("Note 1", "8-10 AM: 0.04-0.56 mcg/dL", "noon-2 PM: < or = 0.21 mcg/dL", "4-6 PM: < or = 0.15 mcg/dL", "10 PM-1 AM: < or = 0.09 mcg/dL");
  const salivaParsed = parseSalivaCortisolText(salivaLines.join("\n"));
  if (!salivaParsed) throw new Error("saliva fixture did not parse");
  const cortisolFlags = flagSalivaCortisol(salivaParsed);
  const withCortisol = buildPayload([], { age: 46, sex: "female", intake: "", patientName: "Jane Doe", salivaCortisol: cortisolFlags });
  const cortisolBlock = withCortisol.salivaCortisol;
  ok(cortisolBlock !== null && cortisolBlock.curve.pattern === "declining", "cortisol fixture: payload block built (declining)");
  const context = cortisolContextLines(cortisolBlock).join(" ");
  ok(/ONE focused paragraph of roughly four to six sentences/.test(context), "cortisol context: asks for one focused paragraph of 4-6 sentences");
  ok(/shape of the decline/.test(context) && /morning\s+peak/.test(context), "cortisol context: morning peak and shape of the decline named");
  ok(/one or two most\s+relevant links/.test(context) && /DHEA-S/.test(context) && /pregnenolone/.test(context), "cortisol context: limits links to the one or two most relevant markers");
  ok(/caveats compressed into one or\s+two short sentences/.test(context), "cortisol context: caveats compressed into one or two sentences");
  ok(/keeping every one of them/.test(context), "cortisol context: no caveat may be dropped");
  for (const caveat of ["single-day snapshot", "wake time", "sleep aids", "medication or supplement timing", "does not diagnose adrenal insufficiency", "8 AM serum cortisol", "ACTH", "only if symptoms warrant"]) {
    ok(context.includes(caveat), `cortisol context: caveat "${caveat}" still present`);
  }
  ok(/Do not walk through the samples or repeat\s+their numbers/.test(context), "cortisol context: no restated numbers the table already shows");
  ok(/cortisol dysregulation/.test(context) && /decision support, not a diagnosis/.test(context), "cortisol context: practitioner voice and functional framing kept");
  ok(!/two to\s+four/.test(context), "cortisol context: the old two-to-four-paragraph wording is gone");

  const initialPrompt = buildInitialAnalysisPrompt(withCortisol);
  const reevalPrompt = buildReevalPrompt(
    buildReevalPayload([], { age: 46, sex: "female", intake: "", patientName: "Jane Doe", salivaCortisol: cortisolFlags, priorPanelInterval: null, priorReportText: "prior" }),
  );
  for (const [label, text] of [["initial", initialPrompt], ["reeval", reevalPrompt]] as const) {
    const spec = text.slice(text.indexOf("- cortisolInterpretation:"));
    ok(spec.length > 0, `${label} field spec: present`);
    ok(/array of EXACTLY TWO strings/.test(spec), `${label} field spec: exactly two strings (paragraph + caveats)`);
    ok(/\[0\] ONE focused paragraph \(about four to six sentences\)/.test(spec), `${label} field spec: first string is one 4-6 sentence paragraph`);
    ok(/\[1\] the standard caveats compressed\s+into one or two short sentences, none dropped/.test(spec), `${label} field spec: second string is the compressed caveats, none dropped`);
    ok(!/\(two to\s+four\)/.test(spec), `${label} field spec: old two-to-four wording gone`);
    ok(/repeat\s+its numbers/.test(spec), `${label} field spec: no repeated numbers from the table`);
  }
  ok(!buildInitialAnalysisPrompt({ ...withCortisol, salivaCortisol: null }).includes("cortisol"), "no saliva block: prompt stays silent on cortisol");

  if (failures.length) {
    console.error(`prompt: ${failures.length} assertion(s) failed`);
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log(`prompt: all ${passed} assertions passed`);
}

main();
