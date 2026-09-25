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

export type NarrativeBlockType =
  | "heading"
  | "goal"
  | "bullet"
  | "paragraph"
  /** Patient-reported symptoms a root-cause pattern explains. Reasoning only —
   *  carries no lab value, and the document renders it as a tag strip under the
   *  pattern's bullets. */
  | "symptomTags"
  /** "Relevance to <chief concern>: ..." — italic, under a pattern's bullets. */
  | "relevance"
  /** Sub-heading inside a section (the three summary subsections). */
  | "subhead"
  /** Bullet whose lead-in, up to the first colon, is bolded. */
  | "leadBullet";

export interface NarrativeBlock {
  type: NarrativeBlockType;
  text: string;
}

export interface AnalysisNarrative {
  /** Short noun phrase in the patient's own terms; drives the section labels. */
  chiefConcern: string;
  clinicalPresentation: NarrativeBlock[];
  reassuring: NarrativeBlock[];
  rootCause: NarrativeBlock[];
  protocol: NarrativeBlock[];
  patientSummary: NarrativeBlock[];
}

/** Joins the symptom tags into the single strip the document renders. */
export const SYMPTOM_TAG_SEPARATOR = "  ·  ";

/** Label the document prints ahead of the tag strip. */
export const SYMPTOM_TAG_LABEL = "Reported symptoms this pattern may explain: ";

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
  "products. The finished report is handed to the patient, who has no science",
  "background. Write for the practitioner, except in the root-cause section and the",
  "final plain-language summary, which the patient reads directly and which must be",
  "written in plain, everyday language.",
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
    "- chiefConcern: the patient's chief concern as a SHORT noun phrase in their",
    "    own terms, e.g. 'persistent fatigue' or 'joint pain and stiffness'. It is",
    "    used verbatim inside sentence-case labels ('What's likely behind <chief",
    hasIntake
      ? "    concern>'), so keep it lowercase and do not end it with a period. Take it"
      : "    concern>'), so keep it lowercase and do not end it with a period. No intake",
    hasIntake
      ? "    from the intake; if the intake names no single concern, use the dominant"
      : "    was provided, so return exactly: the findings on this panel",
    hasIntake ? "    reported symptom." : "",
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
    "- rootCauseAnalysis: array of { pattern, bullets, symptomTags }. Group the",
    "    flagged markers into clinical patterns rather than walking the list one row",
    "    at a time. `pattern` names the markers involved and their direction.",
    "    THE PATIENT READS THIS SECTION. Write it in the same plain, everyday voice",
    "    as the patientSummary fields — roughly an eighth-grade reading level — so a",
    "    reader with no science background understands every bullet on the first pass.",
    "    * `bullets`: at most THREE OR FOUR bullets per pattern, each one or two",
    "      short sentences with no stacked sub-clauses. Say what this group of",
    "      results likely means for the patient and what in their day-to-day life",
    "      (from the intake) may be contributing. Use the everyday word wherever one",
    "      exists; when a marker name must appear, add one short plain gloss in",
    "      parentheses on first use, e.g. 'ferritin (your iron storage)'. No",
    "      biochemistry walk-throughs, no chains of alternative diagnoses, no",
    "      commentary on lab methods — that depth belongs in the practitioner",
    "      conversation, not on this page. At most ONE bullet per pattern may",
    "      suggest follow-up testing, kept short and casual: 'worth checking X at",
    "      your next visit', not a workup list.",
    "    * `symptomTags`: short tags — two or three words each, four to six tags at",
    "      most — naming the symptoms THE PATIENT REPORTED in the intake that this",
    "      pattern plausibly explains, e.g. 'afternoon fatigue', 'cold hands',",
    "      'hair thinning'. Use the patient's own reported complaints; do not invent",
    "      symptoms the intake does not state, and do not restate a marker name as a",
    "      symptom. These are reasoning, not data: no lab values, no numbers, no",
    "      units, no dates, and no names or other identifiers.",
    hasIntake
      ? "      Return an empty array for a pattern that no reported symptom maps to."
      : "      No intake was provided, so return an empty array for every pattern.",
    "    * `relevanceToChiefConcern`: one or two sentences, in the same plain",
    "      everyday language as the bullets, on how this pattern relates to the chief",
    "      concern you named above — whether it helps explain it, argues against a",
    "      cause, or is unrelated to it. Say so plainly when the link is weak; do not",
    "      stretch a finding to fit the complaint. Reasoning only: no values and no",
    "      numbers.",
    "",
    "- phasedProtocol: array of { phase, goal, bullets }. Three or four phases,",
    "    ending with a sustain-and-monitor phase that names the retest interval.",
    "    `phase` reads like 'Phase 1 - Foundation & Stabilization (Weeks 1-4)'.",
    "    `goal` is one sentence. `bullets` are the interventions and lab orders.",
    "",
    "- patientSummary: an object with exactly three string fields, each one short",
    "    paragraph addressed to the patient as 'you', at roughly an eighth-grade",
    "    reading level, with no name:",
    "      whatsGoingWell:      what the panel shows is working.",
    "      likelyDrivers:       what is most likely behind the chief concern, and why",
    "                           it connects to how they feel.",
    "      planInPlainLanguage: what the plan will do about it, at category depth.",
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
  chiefConcern: string;
  overview: NarrativeBlock[];
  rootCause: NarrativeBlock[];
  protocol: NarrativeBlock[];
  /** Both may be empty; the document omits the heading when they are. */
  alreadyImproving: NarrativeBlock[];
  backgroundFindings: NarrativeBlock[];
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
    "- chiefConcern: the patient's chief concern as a SHORT lowercase noun phrase in",
    "    their own terms, e.g. 'persistent fatigue'. It is used verbatim inside",
    "    sentence-case labels, so do not end it with a period. Take it from the intake;",
    "    failing that, from the presenting complaint the prior report records; failing",
    "    both, use the dominant reported symptom.",
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
    "- comparativeRootCause: array of { pattern, bullets, symptomTags }. Group into",
    "    clinical patterns, not a marker walk. `pattern` names the markers and the",
    "    direction they moved.",
    "    THE PATIENT READS THIS SECTION. Write it in the same plain, everyday voice",
    "    as the patientSummary fields — roughly an eighth-grade reading level — so a",
    "    reader with no science background understands every bullet on the first pass.",
    "    * `bullets`: at most THREE OR FOUR bullets per pattern, each one or two",
    "      short sentences with no stacked sub-clauses. Say what moved since the last",
    "      draw, what has held steady, and whether the plan they have been following",
    "      is the likely reason. Use the everyday word wherever one exists; when a",
    "      marker name must appear, add one short plain gloss in parentheses on first",
    "      use, e.g. 'ferritin (your iron storage)'. No biochemistry walk-throughs,",
    "      no chains of alternative diagnoses, no commentary on lab methods — that",
    "      depth belongs in the practitioner conversation, not on this page. At most",
    "      ONE bullet per pattern may suggest follow-up testing, kept short and",
    "      casual: 'worth checking X at your next visit', not a workup list.",
    "    * `symptomTags`: short tags — two or three words each, four to six tags at",
    "      most — naming the symptoms THE PATIENT REPORTED that this pattern",
    "      plausibly explains, e.g. 'afternoon fatigue', 'cold hands'. Draw them from",
    "      the intake notes and, where the prior report records the presenting",
    "      complaints, from that. Do not invent symptoms neither source states, and",
    "      do not restate a marker name as a symptom. These are reasoning, not data:",
    "      no lab values, no numbers, no units, no dates, and no names or other",
    "      identifiers. Return an empty array for a pattern that no reported symptom",
    "      maps to.",
    "    * `relevanceToChiefConcern`: one or two sentences, in the same plain",
    "      everyday language as the bullets, on how this pattern relates to the chief",
    "      concern you named above. Say so plainly when the link is weak. Reasoning",
    "      only: no values and no numbers.",
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
    "- alreadyImproving: array of strings — what is already moving in the right",
    "    direction and should be REINFORCED rather than changed. One entry per",
    "    improvement, written for the practitioner. Ground every entry in the",
    "    improved / held / worsened verdict the tool computed and handed you above:",
    "    that verdict is the tool's, not yours to derive, and you must not claim a",
    "    movement the data does not show. Return an empty array if nothing improved.",
    "",
    "- backgroundFindings: array of strings — markers the PRIOR report flagged that",
    "    this draw did NOT re-test, so the practitioner can see what is still open.",
    "    Start each entry with the marker name followed by a colon, then why it still",
    "    matters and whether it is worth re-testing. Include a marker only when the",
    "    prior report flagged it AND it is absent from the current panel data above.",
    "    Return an empty array when this draw re-tested everything the prior report",
    "    flagged. Do not restate a marker that appears in the current panel.",
    "",
    "- patientSummary: an object with exactly three string fields, each one short",
    "    paragraph addressed to the patient as 'you', with no name:",
    "      whatsGoingWell:      what improved or is holding well.",
    "      likelyDrivers:       what is most likely behind the chief concern now, and",
    "                           why it connects to how they feel.",
    "      planInPlainLanguage: what the updated plan does about it.",
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
  chiefConcern: string,
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
    // Symptom tags are optional in practice: a labs-only run, or a pattern that
    // no reported symptom maps to, legitimately returns an empty array, and
    // that must not fail the whole narrative.
    const tags = requireNonEmptyStrings(
      (entry as { symptomTags?: unknown })?.symptomTags ?? [],
      field,
      { allowEmpty: true },
    );
    if (tags.length > 0) {
      blocks.push({ type: "symptomTags", text: tags.join(SYMPTOM_TAG_SEPARATOR) });
    }
    const relevance =
      typeof (entry as { relevanceToChiefConcern?: unknown })?.relevanceToChiefConcern ===
      "string"
        ? ((entry as { relevanceToChiefConcern: string }).relevanceToChiefConcern).trim()
        : "";
    if (relevance) {
      blocks.push({
        type: "relevance",
        text: `Relevance to ${chiefConcern}: ${relevance}`,
      });
    }
  }
  return blocks;
}

/** The three-subsection plain-language close. */
function summaryToBlocks(value: unknown, chiefConcern: string): NarrativeBlock[] {
  const v = (value ?? {}) as Record<string, unknown>;
  const sections: Array<[string, string]> = [
    ["What's going well", requireText(v.whatsGoingWell, "patientSummary.whatsGoingWell")],
    [
      `What's likely behind ${chiefConcern}`,
      requireText(v.likelyDrivers, "patientSummary.likelyDrivers"),
    ],
    [
      "What we're going to do about it",
      requireText(v.planInPlainLanguage, "patientSummary.planInPlainLanguage"),
    ],
  ];
  const blocks: NarrativeBlock[] = [];
  for (const [head, body] of sections) {
    blocks.push({ type: "subhead", text: head });
    blocks.push({ type: "paragraph", text: body });
  }
  return blocks;
}

/** Bullets whose lead-in (up to the first colon) is bolded on the page. */
const leadBullets = (items: string[]): NarrativeBlock[] =>
  items.map((text) => ({ type: "leadBullet" as const, text }));

/** Chief concern, defaulted so the section labels always read sensibly. */
function readChiefConcern(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  return s || "the findings on this panel";
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
  const chiefConcern = readChiefConcern(json.chiefConcern);
  return {
    chiefConcern,
    clinicalPresentation: bullets(
      requireNonEmptyStrings(json.clinicalPresentation, "clinicalPresentation"),
    ),
    reassuring: paragraphs([requireText(json.reassuringNarrative, "reassuringNarrative")]),
    rootCause: patternsToBlocks(json.rootCauseAnalysis, "rootCauseAnalysis", chiefConcern),
    protocol: phasesToBlocks(json.phasedProtocol, "phasedProtocol"),
    patientSummary: summaryToBlocks(json.patientSummary, chiefConcern),
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

  const chiefConcern = readChiefConcern(json.chiefConcern);
  return {
    priorFacts,
    chiefConcern,
    overview: paragraphs(requireNonEmptyStrings(json.overview, "overview")),
    rootCause: patternsToBlocks(
      json.comparativeRootCause,
      "comparativeRootCause",
      chiefConcern,
    ),
    protocol: phasesToBlocks(json.updatedProtocol, "updatedProtocol"),
    // Both sections are legitimately empty — nothing improved yet, or the draw
    // re-tested everything — so they pass allowEmpty and the document drops the
    // heading rather than printing an empty one.
    alreadyImproving: bullets(
      requireNonEmptyStrings(json.alreadyImproving ?? [], "alreadyImproving", {
        allowEmpty: true,
      }),
    ),
    backgroundFindings: leadBullets(
      requireNonEmptyStrings(json.backgroundFindings ?? [], "backgroundFindings", {
        allowEmpty: true,
      }),
    ),
    patientSummary: summaryToBlocks(json.patientSummary, chiefConcern),
  };
}
