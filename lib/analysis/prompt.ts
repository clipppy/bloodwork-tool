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

import type { AnalysisPayload } from "./deidentify";
import { serializePayload } from "./deidentify";

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
