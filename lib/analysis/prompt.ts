/**
 * Prompt construction and response parsing for the initial-mode Clinical
 * Analysis (Robidoux structure).
 *
 * The model is a reasoning layer only. Every number in the report is rendered
 * by lib/generator/analysis-word.ts from the flagging engine's own output; the
 * marker JSON below is handed to the model as ground truth it must cite rather
 * than recompute, and it is explicitly barred from reprinting the chart.
 *
 * Output is delimited by ===SECTION=== markers so the response parses
 * structurally instead of by heuristics over prose.
 */

import type { AnalysisPayload, ReevalPayload } from "./deidentify";
import { serializePayload } from "./deidentify";
import type { PriorMarkerFact } from "./deterministic";

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

const SECTION_KEYS = [
  "CLINICAL_PRESENTATION",
  "REASSURING",
  "ROOT_CAUSE",
  "PROTOCOL",
  "PATIENT_SUMMARY",
] as const;

type SectionKey = (typeof SECTION_KEYS)[number];

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

function sectionSpec(hasIntake: boolean): string {
  return [
    "Output EXACTLY these five sections, in this order, each introduced by its marker",
    "on its own line, and nothing else. No preamble, no closing remarks, no markdown",
    "headings of your own.",
    "",
    "===CLINICAL_PRESENTATION===",
    hasIntake
      ? "  One bullet per clinical fact drawn from the intake notes: prior diagnoses,"
      : "  The intake notes were left blank, so this is a labs-only analysis. Write one",
    hasIntake
      ? "  symptoms with duration and pattern, relevant history, lifestyle and stress"
      : "  short paragraph (no bullets) stating that no symptom intake was provided and",
    hasIntake
      ? "  load. Bullets start with '- '. Do not add symptoms the intake does not state."
      : "  that the findings below are interpreted from the laboratory data alone.",
    "",
    "===REASSURING===",
    "  One short paragraph (no bullets) naming the specific in-range markers that are",
    "  clinically reassuring here, with their values in parentheses, and stating plainly",
    "  what they argue against (for example: insulin resistance, autoimmune thyroid",
    "  disease, acute-phase inflammation, renal impairment). Choose the markers that",
    "  matter for this patient's picture; do not list all of them.",
    "",
    "===ROOT_CAUSE===",
    "  Group the flagged markers into clinical patterns rather than walking the list",
    "  one row at a time. For each pattern write a heading line starting with '## '",
    "  that names the markers involved and their direction, then bullets starting with",
    "  '- ' giving the candidate mechanisms, the contributing factors from the intake,",
    "  what the finding argues for or against, and any confirmatory testing to trend.",
    "",
    "===PROTOCOL===",
    "  A phased plan. Each phase begins with a heading line starting with '## ' in the",
    "  form '## Phase 1 - Foundation & Stabilization (Weeks 1-4)', immediately followed",
    "  by a line starting with 'Goal: ' stating that phase's objective, then bullets",
    "  starting with '- ' for the interventions. Use three or four phases, ending with",
    "  a sustain-and-monitor phase that names the retest interval. Include confirmatory",
    "  lab orders in the phase where they belong.",
    "",
    "===PATIENT_SUMMARY===",
    "  Plain-language paragraphs addressed to the patient as 'you', at roughly an",
    "  eighth-grade reading level, no marker jargon without a short gloss. Lead with",
    "  what looks good, then what needs attention and why it connects to how they feel,",
    "  then what the plan will do about it. No bullets, no name.",
    "",
    "===END===",
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
    sectionSpec(hasIntake),
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

const REEVAL_SECTION_KEYS = [
  "PRIOR_MARKERS",
  "OVERVIEW",
  "ROOT_CAUSE",
  "PROTOCOL",
  "PATIENT_SUMMARY",
] as const;

type ReevalSectionKey = (typeof REEVAL_SECTION_KEYS)[number];

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
  "course discuss direction of travel in the prose sections.",
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
    "plus the prior values you extract. Do NOT reproduce that table anywhere in",
    "your prose, and do not write a marker-by-marker list that restates it.",
    "",
    "Output EXACTLY these five sections, each introduced by its marker on its own",
    "line, and nothing else.",
    "",
    "===PRIOR_MARKERS===",
    "  One line per marker the PRIOR report flagged as outside its lab range or",
    "  outside the functional/optimal range, in this pipe-delimited form:",
    "    <marker name> | <prior value exactly as the prior report prints it> | <comparable|not-comparable>",
    "  Rules:",
    "  - Use the marker's name from `currentAllMarkers` verbatim whenever the",
    "    prior marker corresponds to one; otherwise use the prior report's own name.",
    "  - Copy the prior value character-for-character from the prior report,",
    "    including its unit. If the prior report flagged a marker but printed no",
    "    usable value, write NOT-PRINTED in the value field.",
    "  - Mark not-comparable when the two panels used different assays or units",
    "    for that marker, so a trend would be misleading.",
    "  - Include a marker here even if it is normal on the current panel; that is",
    "    how an improvement is surfaced. Do not include markers the prior report",
    "    did not flag.",
    "",
    "===OVERVIEW===",
    "  Two or three short paragraphs: what the patient originally presented with",
    "  and what the prior panel found, what this panel is being compared against,",
    "  and the headline direction of travel. Mention the interval only if it was",
    "  provided above.",
    "",
    "===ROOT_CAUSE===",
    "  Comparative reasoning grouped into clinical patterns, not a marker walk.",
    "  For each pattern write a heading line starting with '## ' naming the",
    "  markers and the direction they moved, then bullets starting with '- '",
    "  covering: what changed since the prior panel and what held, the candidate",
    "  mechanisms, whether the prior protocol plausibly explains the change, and",
    "  what to confirm or trend next.",
    "",
    "===PROTOCOL===",
    "  An UPDATED plan that builds on the prior report's protocol rather than",
    "  replacing it. Each phase begins with a heading line starting with '## ' in",
    "  the form '## Phase 1 - Re-establish Digestion (Weeks 1-6)', then a line",
    "  starting with 'Goal: ', then bullets starting with '- '.",
    "  Every protocol bullet MUST begin with one of these tags, which is how the",
    "  practitioner sees what changed against the prior plan:",
    "    CONTINUE:  kept as-is from the prior plan",
    "    TAPER:     reduced to maintenance because the marker improved",
    "    INTENSIFY: same intervention, pushed harder because the marker held",
    "    NEW:       added because something worsened or is newly flagged",
    "    RE-START:  was in the prior plan, appears to have lapsed",
    "    STOP:      discontinue",
    "    MONITOR:   retest or watch, no intervention change",
    "  Name nutrient and botanical categories or specific options at practitioner",
    "  discretion. No doses, no brands, no prescription regimens. If the prior",
    "  report named a specific product, you may reference it as the prior plan's",
    "  choice and say whether to continue, taper, or reassess it.",
    "",
    "===PATIENT_SUMMARY===",
    "  Plain-language paragraphs addressed to the patient as 'you', roughly",
    "  eighth-grade reading level. Lead with what improved, then what needs",
    "  attention now and why, then what the updated plan does about it. No",
    "  bullets, no name.",
    "",
    "===END===",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Parse "Name | value | comparable" lines into prior facts. */
function parsePriorMarkers(raw: string): Map<string, PriorMarkerFact> {
  const facts = new Map<string, PriorMarkerFact>();
  for (const rawLine of raw.split("\n")) {
    const line = cleanLine(rawLine).trim().replace(/^-\s*/, "");
    if (!line || !line.includes("|")) continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 2) continue;
    const [name, value, comparability] = parts;
    if (!name || /^marker name$/i.test(name)) continue; // skip an echoed header

    const notPrinted = !value || /^not[- ]printed$/i.test(value) || value === "—";
    facts.set(name, {
      value: notPrinted ? null : value,
      notComparable: /not[- ]comparable/i.test(comparability ?? ""),
    });
  }
  return facts;
}

export function parseReevalNarrative(response: string): ReevalNarrative {
  const found = new Map<ReevalSectionKey, string>();

  for (let i = 0; i < REEVAL_SECTION_KEYS.length; i++) {
    const key = REEVAL_SECTION_KEYS[i];
    const start = response.indexOf(`===${key}===`);
    if (start === -1) continue;
    const from = start + `===${key}===`.length;
    let end = response.length;
    for (const other of [...REEVAL_SECTION_KEYS.slice(i + 1), "END" as const]) {
      const idx = response.indexOf(`===${other}===`, from);
      if (idx !== -1 && idx < end) end = idx;
    }
    found.set(key, response.slice(from, end).trim());
  }

  const missing = REEVAL_SECTION_KEYS.filter((k) => !found.has(k));
  if (missing.length) {
    throw new NarrativeParseError(
      `The model's response was missing ${missing.length} of 5 sections (${missing.join(", ")}).`,
    );
  }

  const narrative: ReevalNarrative = {
    priorFacts: parsePriorMarkers(found.get("PRIOR_MARKERS")!),
    overview: parseBlocks(found.get("OVERVIEW")!),
    rootCause: parseBlocks(found.get("ROOT_CAUSE")!),
    protocol: parseBlocks(found.get("PROTOCOL")!),
    patientSummary: parseBlocks(found.get("PATIENT_SUMMARY")!),
  };

  const empty = (["overview", "rootCause", "protocol", "patientSummary"] as const).filter(
    (k) => narrative[k].length === 0,
  );
  if (empty.length) {
    throw new NarrativeParseError(
      `The model returned empty content for: ${empty.join(", ")}.`,
    );
  }
  return narrative;
}

// ----- Response parsing -----

/** Strip markdown emphasis the model may still emit, and normalize bullets. */
function cleanLine(line: string): string {
  return line
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^\s*[•*]\s+/, "- ")
    .trimEnd();
}

function parseBlocks(raw: string): NarrativeBlock[] {
  const blocks: NarrativeBlock[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: paragraph.join(" ").trim() });
      paragraph = [];
    }
  };

  for (const rawLine of raw.split("\n")) {
    const line = cleanLine(rawLine);
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      continue;
    }
    if (trimmed.startsWith("## ")) {
      flush();
      blocks.push({ type: "heading", text: trimmed.slice(3).trim() });
      continue;
    }
    if (/^goal\s*:/i.test(trimmed)) {
      flush();
      blocks.push({ type: "goal", text: trimmed.replace(/^goal\s*:\s*/i, "").trim() });
      continue;
    }
    if (trimmed.startsWith("- ")) {
      flush();
      blocks.push({ type: "bullet", text: trimmed.slice(2).trim() });
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();
  return blocks.filter((b) => b.text.length > 0);
}

/**
 * Split the model's response on the section markers. Tolerant of surrounding
 * chatter and of a missing ===END===; strict about the five sections existing,
 * so a malformed response surfaces as a clean error instead of a half-empty doc.
 */
export function parseNarrative(response: string): AnalysisNarrative {
  const found = new Map<SectionKey, string>();

  for (let i = 0; i < SECTION_KEYS.length; i++) {
    const key = SECTION_KEYS[i];
    const start = response.indexOf(`===${key}===`);
    if (start === -1) continue;
    const from = start + `===${key}===`.length;

    // The section ends at whichever later marker appears first.
    let end = response.length;
    for (const other of [...SECTION_KEYS.slice(i + 1), "END" as const]) {
      const idx = response.indexOf(`===${other}===`, from);
      if (idx !== -1 && idx < end) end = idx;
    }
    found.set(key, response.slice(from, end).trim());
  }

  const missing = SECTION_KEYS.filter((k) => !found.has(k));
  if (missing.length) {
    throw new NarrativeParseError(
      `The model's response was missing ${missing.length} of 5 sections (${missing.join(", ")}).`,
    );
  }

  const narrative: AnalysisNarrative = {
    clinicalPresentation: parseBlocks(found.get("CLINICAL_PRESENTATION")!),
    reassuring: parseBlocks(found.get("REASSURING")!),
    rootCause: parseBlocks(found.get("ROOT_CAUSE")!),
    protocol: parseBlocks(found.get("PROTOCOL")!),
    patientSummary: parseBlocks(found.get("PATIENT_SUMMARY")!),
  };

  const empty = (Object.keys(narrative) as Array<keyof AnalysisNarrative>).filter(
    (k) => narrative[k].length === 0,
  );
  if (empty.length) {
    throw new NarrativeParseError(
      `The model returned empty content for: ${empty.join(", ")}.`,
    );
  }
  return narrative;
}
