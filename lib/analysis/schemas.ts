/**
 * JSON schemas for the narrative the model returns.
 *
 * The shape is enforced by the API (structured outputs) rather than recovered
 * by parsing prose, so section assembly cannot drift run-to-run: a section is
 * either present as a named field or the request fails loudly.
 *
 * Nothing here carries a lab value the tool computes. The one number the model
 * is allowed to supply is `priorMarkers[].priorValue`, read from the prior
 * report, and it lands only in the chart's Prior column.
 *
 * Structured-output requirements: every object sets `additionalProperties:
 * false` and lists every property in `required`.
 */

// ----- Shared fragments -----

const stringArray = (description: string) => ({
  type: "array" as const,
  description,
  items: { type: "string" as const },
});

// Shared by the Initial rootCauseAnalysis and the Re-eval comparativeRootCause,
// so symptomTags is defined once and required in both.
const patternBlock = {
  type: "object" as const,
  properties: {
    pattern: {
      type: "string" as const,
      description:
        "Heading naming the markers in this pattern and the direction they moved.",
    },
    bullets: stringArray("At most three or four short plain-language bullets written for the patient: everyday words, one or two short sentences each."),
    symptomTags: stringArray(
      "Short tags naming the patient-reported symptoms from the intake that this " +
        "pattern plausibly explains. Reasoning only: no lab values, no numbers, no " +
        "units, no dates, no names or other identifiers. Empty array when no intake " +
        "was provided or when no reported symptom maps to this pattern.",
    ),
    relevanceToChiefConcern: {
      type: "string" as const,
      description:
        "One or two sentences saying how this pattern bears on the chief concern " +
        "named in `chiefConcern` — whether it helps explain it, argues against a " +
        "contributor, or is incidental to it. Say plainly when the link is weak. " +
        "Reasoning only: no lab values and no numbers.",
    },
  },
  required: ["pattern", "bullets", "symptomTags", "relevanceToChiefConcern"],
  additionalProperties: false,
};

// Shared by both modes: the plain-language close, in three fixed subsections
// rather than a free-form list of paragraphs.
const patientSummaryBlock = {
  type: "object" as const,
  properties: {
    whatsGoingWell: {
      type: "string" as const,
      description:
        "One short paragraph addressed to the patient as 'you', leading with what " +
        "the panel shows is working. Plain language, roughly eighth-grade reading " +
        "level. No name.",
    },
    likelyDrivers: {
      type: "string" as const,
      description:
        "One short paragraph on what is most likely behind the chief concern named " +
        "in `chiefConcern`, and why it connects to how the patient feels.",
    },
    planInPlainLanguage: {
      type: "string" as const,
      description:
        "One short paragraph on what the plan will do about it, at category depth, " +
        "framed as the practitioner's recommendation.",
    },
  },
  required: ["whatsGoingWell", "likelyDrivers", "planInPlainLanguage"],
  additionalProperties: false,
};

const phaseBlock = (bulletsDescription: string) => ({
  type: "object" as const,
  properties: {
    phase: {
      type: "string" as const,
      description: "Phase heading, e.g. 'Phase 1 - Foundation & Stabilization (Weeks 1-4)'.",
    },
    goal: { type: "string" as const, description: "One sentence stating this phase's objective." },
    bullets: stringArray(bulletsDescription),
  },
  required: ["phase", "goal", "bullets"],
  additionalProperties: false,
});

// ----- Initial mode -----

export const INITIAL_NARRATIVE_SCHEMA = {
  type: "object",
  properties: {
    chiefConcern: {
      type: "string",
      description:
        "The patient's chief concern, as a short noun phrase in their own terms " +
        "(e.g. 'persistent fatigue'), taken from the intake. When the intake names " +
        "no single chief concern, use the dominant reported symptom. When no intake " +
        "was provided, use 'the findings on this panel'. No numbers, no identifiers.",
    },
    clinicalPresentation: stringArray(
      "One bullet per clinical fact drawn from the intake notes. If no intake was provided, a single sentence saying the analysis is labs-only.",
    ),
    reassuringNarrative: {
      type: "string",
      description:
        "One short paragraph naming the specific in-range markers that are clinically reassuring, with their values in parentheses, and what they argue against.",
    },
    rootCauseAnalysis: {
      type: "array",
      description: "Clinical patterns, not a marker-by-marker walk.",
      items: patternBlock,
    },
    phasedProtocol: {
      type: "array",
      description: "Three or four phases, ending with sustain-and-monitor.",
      items: phaseBlock(
        "One intervention or lab order per line, at category / practitioner-discretion depth.",
      ),
    },
    patientSummary: patientSummaryBlock,
  },
  required: [
    "chiefConcern",
    "clinicalPresentation",
    "reassuringNarrative",
    "rootCauseAnalysis",
    "phasedProtocol",
    "patientSummary",
  ],
  additionalProperties: false,
} as const;

export interface PatientSummaryJson {
  whatsGoingWell: string;
  likelyDrivers: string;
  planInPlainLanguage: string;
}

export interface PatternJson {
  pattern: string;
  bullets: string[];
  symptomTags: string[];
  relevanceToChiefConcern: string;
}

export interface InitialNarrativeJson {
  chiefConcern: string;
  clinicalPresentation: string[];
  reassuringNarrative: string;
  rootCauseAnalysis: PatternJson[];
  phasedProtocol: Array<{ phase: string; goal: string; bullets: string[] }>;
  patientSummary: PatientSummaryJson;
}

// ----- Re-evaluation mode -----

export const REEVAL_NARRATIVE_SCHEMA = {
  type: "object",
  properties: {
    chiefConcern: {
      type: "string",
      description:
        "The patient's chief concern, as a short noun phrase in their own terms " +
        "(e.g. 'persistent fatigue'), taken from the intake or, failing that, from " +
        "the presenting complaint the prior report records. When neither states " +
        "one, use the dominant reported symptom. No numbers, no identifiers.",
    },
    priorMarkers: {
      type: "array",
      description:
        "Every marker the PRIOR report flagged as out of range, with its prior value copied verbatim from that report.",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Use the marker's name from currentAllMarkers verbatim when it corresponds to one; otherwise the prior report's own name.",
          },
          priorValue: {
            type: "string",
            description:
              "The prior value exactly as the prior report prints it, including units. Use 'NOT-PRINTED' when the prior report flagged the marker without printing a usable value.",
          },
          comparable: {
            type: "boolean",
            description:
              "False when the two panels used different assays or units, so a trend would mislead.",
          },
        },
        required: ["name", "priorValue", "comparable"],
        additionalProperties: false,
      },
    },
    overview: stringArray(
      "Two or three paragraphs: what the patient presented with and what the prior panel found, what this panel compares against, and the headline direction of travel. One string per paragraph.",
    ),
    comparativeRootCause: {
      type: "array",
      description: "Comparative reasoning grouped into clinical patterns.",
      items: patternBlock,
    },
    updatedProtocol: {
      type: "array",
      description: "Phases that build on the prior plan rather than replacing it.",
      items: phaseBlock(
        "Each bullet MUST begin with one of: CONTINUE:, TAPER:, INTENSIFY:, NEW:, RE-START:, STOP:, MONITOR: — that tag is how the practitioner sees what changed against the prior plan.",
      ),
    },
    alreadyImproving: stringArray(
      "What is already moving in the right direction and should be reinforced " +
        "rather than changed. One entry per improvement. Ground every entry in the " +
        "improved/held/worsened trend the tool computed and supplied to you — that " +
        "verdict is the tool's, not yours to derive, and you must not invent a " +
        "movement the data does not show. Empty array when nothing improved.",
    ),
    backgroundFindings: stringArray(
      "Markers the PRIOR report flagged that this draw did not re-test, so the " +
        "practitioner can see what is still open. One entry per finding, each " +
        "leading with the marker name and a colon, then why it still matters and " +
        "whether it is worth re-testing. Use only markers present in the prior " +
        "report and absent from the current panel. Empty array when the current " +
        "draw re-tested everything the prior report flagged.",
    ),
    patientSummary: patientSummaryBlock,
  },
  required: [
    "chiefConcern",
    "priorMarkers",
    "overview",
    "comparativeRootCause",
    "updatedProtocol",
    "alreadyImproving",
    "backgroundFindings",
    "patientSummary",
  ],
  additionalProperties: false,
} as const;

export interface ReevalNarrativeJson {
  chiefConcern: string;
  priorMarkers: Array<{ name: string; priorValue: string; comparable: boolean }>;
  overview: string[];
  comparativeRootCause: PatternJson[];
  updatedProtocol: Array<{ phase: string; goal: string; bullets: string[] }>;
  alreadyImproving: string[];
  backgroundFindings: string[];
  patientSummary: PatientSummaryJson;
}
