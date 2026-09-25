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
  toAnalysisNarrative,
  toReevalNarrative,
  NarrativeParseError,
} from "./prompt";
import type { InitialNarrativeJson, ReevalNarrativeJson } from "./schemas";

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

function initialJson(phases: unknown[]): InitialNarrativeJson {
  return {
    chiefConcern: "persistent fatigue",
    clinicalPresentation: ["Reports afternoon fatigue."],
    reassuringNarrative: "Thyroid markers are reassuring.",
    rootCauseAnalysis: [pattern],
    phasedProtocol: phases as InitialNarrativeJson["phasedProtocol"],
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

  if (failures.length) {
    console.error(`prompt: ${failures.length} assertion(s) failed`);
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log(`prompt: all ${passed} assertions passed`);
}

main();
