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

const patternBlock = {
  type: "object" as const,
  properties: {
    pattern: {
      type: "string" as const,
      description:
        "Heading naming the markers in this pattern and the direction they moved.",
    },
    bullets: stringArray("One point per line: mechanism, contributing factor, or what to confirm next."),
  },
  required: ["pattern", "bullets"],
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
    patientSummary: stringArray(
      "Plain-language paragraphs addressed to the patient as 'you'. One string per paragraph.",
    ),
  },
  required: [
    "clinicalPresentation",
    "reassuringNarrative",
    "rootCauseAnalysis",
    "phasedProtocol",
    "patientSummary",
  ],
  additionalProperties: false,
} as const;

export interface InitialNarrativeJson {
  clinicalPresentation: string[];
  reassuringNarrative: string;
  rootCauseAnalysis: Array<{ pattern: string; bullets: string[] }>;
  phasedProtocol: Array<{ phase: string; goal: string; bullets: string[] }>;
  patientSummary: string[];
}

// ----- Re-evaluation mode -----

export const REEVAL_NARRATIVE_SCHEMA = {
  type: "object",
  properties: {
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
    patientSummary: stringArray(
      "Plain-language comparative paragraphs addressed to the patient as 'you'. One string per paragraph.",
    ),
  },
  required: [
    "priorMarkers",
    "overview",
    "comparativeRootCause",
    "updatedProtocol",
    "patientSummary",
  ],
  additionalProperties: false,
} as const;

export interface ReevalNarrativeJson {
  priorMarkers: Array<{ name: string; priorValue: string; comparable: boolean }>;
  overview: string[];
  comparativeRootCause: Array<{ pattern: string; bullets: string[] }>;
  updatedProtocol: Array<{ phase: string; goal: string; bullets: string[] }>;
  patientSummary: string[];
}
