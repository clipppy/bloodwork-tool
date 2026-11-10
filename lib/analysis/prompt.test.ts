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
  isEmptyPhaseEntry,
  markerNotesFrom,
  toAnalysisNarrative,
  toReevalNarrative,
  NarrativeParseError,
} from "./prompt";
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
    type ArrayField = { type?: string; items?: { type?: string } } | undefined;
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

  if (failures.length) {
    console.error(`prompt: ${failures.length} assertion(s) failed`);
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log(`prompt: all ${passed} assertions passed`);
}

main();
