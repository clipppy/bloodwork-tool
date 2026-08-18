/**
 * Prompt construction and response parsing for the initial-mode Clinical
 * Analysis (Robidoux structure).
 *
 * The model is a reasoning layer only. Every number in the report is rendered
 * by lib/generator/analysis-word.ts from the flagging engine's own output; the
 * marker JSON below is handed to the model as ground truth it must cite rather
 * than recompute, and it is explicitly barred from reprinting the chart.
 *
 * The narrative comes back as STRUCTURED JSON (lib/analysis/schemas.ts), with
 * the shape enforced by the API. This file builds the prompts and converts the
 * validated JSON into the render blocks the Word generator consumes — there is
 * no prose parsing anywhere in the path.
 */

import type { AnalysisPayload, ReevalPayload } from "./deidentify";
import { serializePayload } from "./deidentify";
import type { PriorMarkerFact } from "./deterministic";
import type { InitialNarrativeJson, ReevalNarrativeJson } from "./schemas";

// ----- Parsed narrative -----

export type NarrativeBlockType = "heading" | "goal" | "bullet" | "paragraph";

export interface NarrativeBlock {
  type: NarrativeBlockType;
  text: string;
}

export interface AnalysisNarrative {
  clinicalPresentation: NarrativeBlock[];
  reassuring: NarrativeBlock[];
  rootCause: NarrativeBlock[];
  protocol: NarrativeBlock[];
  patientSummary: NarrativeBlock[];
}

export class NarrativeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarrativeParseError";
  }
}

// ----- Prompt -----

export const SYSTEM_PROMPT = [
  "You are a functional-medicine clinical decision-support writer preparing a lab",
  "analysis for a licensed practitioner at a chiropractic practice. The practitioner",
  "reviews everything you write, owns every clinical decision, and selects the actual",
  "products. You are writing for that practitioner, not for the patient, except in the",
  "final plain-language section.",
  "",
  "Ground rules:",
  "- The marker data you are given is authoritative and was computed by a validated",
  "  tool. Reference those values, ranges, and statuses exactly as given. Never",
  "  recompute, adjust, round, convert, or restate a different number, and never",
  "  introduce a marker, value, or reference range that is not in the data.",
  "- If a clinical point needs a marker that was not tested, say it was not tested and",
  "  recommend it as follow-up. Do not estimate it.",
  "- Write decision support, not a diagnosis. Prefer 'consistent with', 'suggests',",
  "  'warrants evaluation for'.",
  "- Nutrient and botanical suggestions stay at the category or named-option level and",
  "  are explicitly at practitioner discretion. Never give doses, brands, or",
  "  prescription drug regimens.",
  "- Flag anything the panel cannot explain as needing additional targeted workup",
  "  rather than forcing a lab-based explanation.",
  "- The patient's name is not available to you. Never invent one, and never address",
  "  the patient by name.",
  "- Do not use markdown emphasis (no ** or _). Plain text only.",
].join("\n");

function fieldSpec(hasIntake: boolean): string {
  return [
    "Return the analysis as a JSON object with exactly these fields:",
    "",
    "- clinicalPresentation: array of strings.",
    hasIntake
      ? "    One entry per clinical fact from the intake notes: prior diagnoses, symptoms"
      : "    The intake notes were left blank, so this is a labs-only analysis. Return a",
    hasIntake
      ? "    with duration and pattern, relevant history, lifestyle and stress load. Do not"
      : "    single entry stating that no symptom intake was provided and that the findings",
    hasIntake
      ? "    add symptoms the intake does not state."
      : "    below are interpreted from the laboratory data alone.",
    "",
    "- reassuringNarrative: one short paragraph naming the specific in-range markers",
    "    that are clinically reassuring here, with their values in parentheses, and",
    "    stating what they argue against (insulin resistance, autoimmune thyroid",
    "    disease, acute-phase inflammation, renal impairment, and so on). Choose the",
    "    markers that matter for this picture; do not list all of them.",
    "",
    "- rootCauseAnalysis: array of { pattern, bullets }. Group the flagged markers",
    "    into clinical patterns rather than walking the list one row at a time.",
    "    `pattern` names the markers involved and their direction. `bullets` give the",
    "    candidate mechanisms, the contributing factors from the intake, what the",
    "    finding argues for or against, and any confirmatory testing to trend.",
    "",
    "- phasedProtocol: array of { phase, goal, bullets }. Three or four phases,",
    "    ending with a sustain-and-monitor phase that names the retest interval.",
    "    `phase` reads like 'Phase 1 - Foundation & Stabilization (Weeks 1-4)'.",
    "    `goal` is one sentence. `bullets` are the interventions and lab orders.",
    "",
    "- patientSummary: array of strings, one per paragraph, addressed to the patient",
    "    as 'you', at roughly an eighth-grade reading level. Lead with what looks",
    "    good, then what needs attention and why it connects to how they feel, then",
    "    what the plan will do about it. No name.",
    "",
    "Write plain prose inside the fields — no markdown, no bullet characters, no",
    "numbering. The document adds all formatting.",
  ].join("\n");
}

export function buildInitialAnalysisPrompt(payload: AnalysisPayload): string {
  const hasIntake = !!payload.intake && payload.intake.trim().length > 0;
  const ageSex = [
    payload.patient.age !== null ? `${payload.patient.age}-year-old` : "age not provided",
    payload.patient.sex !== "unspecified" ? payload.patient.sex : "sex not provided",
  ].join(", ");

  return [
    `Patient context: ${ageSex}.`,
    "",
    "AUTHORITATIVE MARKER DATA (computed by the tool; treat as ground truth):",
    "```json",
    serializePayload(payload),
    "```",
    "",
    "How to use that data:",
    "- `flaggedMarkers` are the markers outside the standard lab range and/or the",
    "  functional optimal range. `status` is the tool's verdict; a trailing asterisk",
    "  means the value is inside the standard lab range but outside the functional",
    "  optimal range.",
    "- `inRangeMarkers` are within both ranges.",
    "- When you cite a value or a range in prose, copy it character-for-character from",
    "  this data.",
    "",
    "IMPORTANT: a table of the flagged markers with their values, ranges, and statuses",
    "is already rendered in the document immediately above your output. Do NOT reproduce",
    "that table, and do not write a marker-by-marker list that restates it. Your job is",
    "the reasoning around it.",
    "",
    hasIntake
      ? "PRACTITIONER INTAKE NOTES (identifiers removed; interpret what is here and do not invent more):"
      : "PRACTITIONER INTAKE NOTES: none provided.",
    hasIntake ? "```" : "",
    hasIntake ? (payload.intake as string) : "",
    hasIntake ? "```" : "",
    "",
    fieldSpec(hasIntake),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// ----- Re-evaluation mode -----

export interface ReevalNarrative {
  /** Prior values keyed by canonical marker name. The only LLM-sourced numbers
   *  that reach the document, and only into the Prior column. */
  priorFacts: Map<string, PriorMarkerFact>;
  overview: NarrativeBlock[];
  rootCause: NarrativeBlock[];
  protocol: NarrativeBlock[];
  patientSummary: NarrativeBlock[];
}

export const REEVAL_SYSTEM_PROMPT = [
  SYSTEM_PROMPT,
  "",
  "This is a FOLLOW-UP report comparing a current panel against the patient's",
  "previous one. Two separate sources of truth, and they must not be mixed:",
  "- CURRENT values come only from the structured marker data you are given.",
  "- PRIOR values come only from the prior report text you are given.",
  "Never carry a number from one side to the other, never estimate a prior value",
  "that the prior report does not state, and never adjust a current value to make",
  "a trend look cleaner. If the prior report does not print a value for a marker,",
  "say so — that is a normal and useful finding.",
  "",
  "Do not state whether a marker improved or worsened as a verdict in the",
  "comparison table: that is computed from the two values by the tool. You may of",
  "course discuss direction of travel in the prose fields.",
].join("\n");

export function buildReevalPrompt(payload: ReevalPayload): string {
  const hasIntake = !!payload.intake && payload.intake.trim().length > 0;
  const ageSex = [
    payload.patient.age !== null ? `${payload.patient.age}-year-old` : "age not provided",
    payload.patient.sex !== "unspecified" ? payload.patient.sex : "sex not provided",
  ].join(", ");
  const interval = payload.patient.priorPanelInterval;

  return [
    `Patient context: ${ageSex}.`,
    interval
      ? `Time between the prior panel and this one: ${interval}.`
      : "The interval between the two panels was not provided; do not guess it.",
    "",
    "CURRENT PANEL (computed by the tool; authoritative):",
    "```json",
    serializePayload(payload),
    "```",
    "",
    "How to use that data:",
    "- `currentFlaggedMarkers` are outside the standard lab range and/or the",
    "  functional optimal range on the CURRENT panel. A trailing asterisk on",
    "  `status` means inside the lab range but outside the functional range.",
    "- `currentAllMarkers` is every marker measured on the current panel, so you",
    "  can look up the current value of a marker the prior report flagged.",
    "- `priorReportText` is the previous report, de-identified. It is the only",
    "  source for prior values and for the prior protocol. [REDACTED] marks a",
    "  removed identifier — ignore those tokens.",
    "",
    hasIntake
      ? "PRACTITIONER INTAKE NOTES for this visit (identifiers removed):"
      : "PRACTITIONER INTAKE NOTES: none provided for this visit.",
    hasIntake ? "```" : "",
    hasIntake ? (payload.intake as string) : "",
    hasIntake ? "```" : "",
    "",
    "IMPORTANT: the comparison table is rendered by the tool from the data above",
    "plus the prior values you return. Do NOT reproduce that table in prose, and do",
    "not write a marker-by-marker list that restates it.",
    "",
    "Return the follow-up analysis as a JSON object with exactly these fields:",
    "",
    "- priorMarkers: array of { name, priorValue, comparable }, one entry per marker",
    "    the PRIOR report flagged as outside its lab range or outside the",
    "    functional/optimal range.",
    "    * `name`: use the marker's name from `currentAllMarkers` verbatim whenever",
    "      the prior marker corresponds to one; otherwise the prior report's own name.",
    "    * `priorValue`: copied character-for-character from the prior report,",
    "      including its unit. Use 'NOT-PRINTED' when the prior report flagged a",
    "      marker but printed no usable value.",
    "    * `comparable`: false when the two panels used different assays or units for",
    "      that marker, so a trend would mislead; true otherwise.",
    "    Include a marker even if it is normal on the current panel — that is how an",
    "    improvement is surfaced. Do not include markers the prior report did not flag.",
    "",
    "- overview: array of strings, one per paragraph. What the patient originally",
    "    presented with and what the prior panel found, what this panel is compared",
    "    against, and the headline direction of travel. Mention the interval only if",
    "    it was provided above.",
    "",
    "- comparativeRootCause: array of { pattern, bullets }. Group into clinical",
    "    patterns, not a marker walk. `pattern` names the markers and the direction",
    "    they moved. `bullets` cover what changed and what held, the candidate",
    "    mechanisms, whether the prior protocol plausibly explains the change, and",
    "    what to confirm or trend next.",
    "",
    "- updatedProtocol: array of { phase, goal, bullets } that builds on the prior",
    "    report's protocol rather than replacing it. Every bullet MUST begin with one",
    "    of these tags, which is how the practitioner sees what changed:",
    "      CONTINUE:  kept as-is from the prior plan",
    "      TAPER:     reduced to maintenance because the marker improved",
    "      INTENSIFY: same intervention, pushed harder because the marker held",
    "      NEW:       added because something worsened or is newly flagged",
    "      RE-START:  was in the prior plan, appears to have lapsed",
    "      STOP:      discontinue",
    "      MONITOR:   retest or watch, no intervention change",
    "    Name nutrient and botanical categories or specific options at practitioner",
    "    discretion. No doses, no brands, no prescription regimens. If the prior report",
    "    named a specific product, you may reference it as the prior plan's choice and",
    "    say whether to continue, taper, or reassess it.",
    "",
    "- patientSummary: array of strings, one per paragraph, addressed to the patient",
    "    as 'you'. Lead with what improved, then what needs attention now and why,",
    "    then what the updated plan does about it. No name.",
    "",
    "Write plain prose inside the fields — no markdown, no bullet characters, no",
    "numbering. The document adds all formatting.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// ----- Validation + conversion to render blocks -----

function requireNonEmptyStrings(
  value: unknown,
  field: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value)) {
    throw new NarrativeParseError(`The model returned no "${field}" content.`);
  }
  const items = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
  if (!items.length && !allowEmpty) {
    throw new NarrativeParseError(`The model returned no "${field}" content.`);
  }
  return items;
}

function requireText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new NarrativeParseError(`The model returned no "${field}" content.`);
  }
  return text;
}

function patternsToBlocks(
  value: unknown,
  field: string,
): NarrativeBlock[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new NarrativeParseError(`The model returned no "${field}" content.`);
  }
  const blocks: NarrativeBlock[] = [];
  for (const entry of value) {
    const pattern = requireText((entry as { pattern?: unknown })?.pattern, field);
    blocks.push({ type: "heading", text: pattern });
    for (const bullet of requireNonEmptyStrings(
      (entry as { bullets?: unknown })?.bullets,
      field,
    )) {
      blocks.push({ type: "bullet", text: bullet });
    }
  }
  return blocks;
}

function phasesToBlocks(value: unknown, field: string): NarrativeBlock[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new NarrativeParseError(`The model returned no "${field}" content.`);
  }
  const blocks: NarrativeBlock[] = [];
  for (const entry of value) {
    const phase = requireText((entry as { phase?: unknown })?.phase, field);
    blocks.push({ type: "heading", text: phase });
    blocks.push({
      type: "goal",
      text: requireText((entry as { goal?: unknown })?.goal, field),
    });
    for (const bullet of requireNonEmptyStrings(
      (entry as { bullets?: unknown })?.bullets,
      field,
    )) {
      blocks.push({ type: "bullet", text: bullet });
    }
  }
  return blocks;
}

const paragraphs = (items: string[]): NarrativeBlock[] =>
  items.map((text) => ({ type: "paragraph" as const, text }));

const bullets = (items: string[]): NarrativeBlock[] =>
  items.map((text) => ({ type: "bullet" as const, text }));

/**
 * Validate the structured response and convert it to render blocks.
 * Throws NarrativeParseError on anything malformed, which the route turns into
 * the clean error + deterministic-scaffold path.
 */
export function toAnalysisNarrative(json: InitialNarrativeJson): AnalysisNarrative {
  if (!json || typeof json !== "object") {
    throw new NarrativeParseError("The model returned no analysis content.");
  }
  return {
    clinicalPresentation: bullets(
      requireNonEmptyStrings(json.clinicalPresentation, "clinicalPresentation"),
    ),
    reassuring: paragraphs([requireText(json.reassuringNarrative, "reassuringNarrative")]),
    rootCause: patternsToBlocks(json.rootCauseAnalysis, "rootCauseAnalysis"),
    protocol: phasesToBlocks(json.phasedProtocol, "phasedProtocol"),
    patientSummary: paragraphs(requireNonEmptyStrings(json.patientSummary, "patientSummary")),
  };
}

export function toReevalNarrative(json: ReevalNarrativeJson): ReevalNarrative {
  if (!json || typeof json !== "object") {
    throw new NarrativeParseError("The model returned no analysis content.");
  }

  const priorFacts = new Map<string, PriorMarkerFact>();
  if (Array.isArray(json.priorMarkers)) {
    for (const entry of json.priorMarkers) {
      const name = typeof entry?.name === "string" ? entry.name.trim() : "";
      if (!name) continue;
      const raw = typeof entry?.priorValue === "string" ? entry.priorValue.trim() : "";
      const notPrinted = !raw || /^not[- ]printed$/i.test(raw) || raw === "—";
      priorFacts.set(name, {
        value: notPrinted ? null : raw,
        notComparable: entry?.comparable === false,
      });
    }
  }

  return {
    priorFacts,
    overview: paragraphs(requireNonEmptyStrings(json.overview, "overview")),
    rootCause: patternsToBlocks(json.comparativeRootCause, "comparativeRootCause"),
    protocol: phasesToBlocks(json.updatedProtocol, "updatedProtocol"),
    patientSummary: paragraphs(requireNonEmptyStrings(json.patientSummary, "patientSummary")),
  };
}
