/**
 * De-identification boundary for the Clinical Analysis feature.
 *
 * Non-negotiable #3: identifiers never reach the API. Everything the model is
 * allowed to see passes through this file, and this file constructs the payload
 * from an allow-list — it never copies a marker object wholesale, so a new
 * field added upstream cannot silently leak.
 *
 * Allowed out:
 *   - flagged markers: name, result string, value, unit, lab range, optimal
 *     range, status, direction  (the authoritative numbers the model must cite)
 *   - in-range markers: name + value  (for the reassuring paragraph)
 *   - age (integer) and sex
 *   - intake text, with the known patient name and any date-like tokens redacted
 *
 * Never out: patient name, date of birth, collection/report dates, the raw PDF,
 * `rawLine` (which can carry PHI), file names, or anything else.
 *
 * `buildPayload` returns the exact object that gets serialized, so the caller
 * can log or inspect precisely what left the machine.
 */

import type { FlaggedMarker } from "../flagging";
import { isFlagged } from "../flagging";
import {
  formatLabRange,
  formatOptimalRange,
  formatResult,
  formatStatus,
  withinLabRange,
  type PatientSex,
} from "./deterministic";

export const REDACTED = "[REDACTED]";

export interface PayloadMarker {
  name: string;
  /** Exactly as rendered in the chart, e.g. "123 mcg/dL" or "117 mg/dL (calc) H". */
  result: string;
  value: number | string;
  unit: string | null;
  labRange: string;
  optimalRange: string;
  status: string;
  direction: "high" | "low" | null;
}

export interface PayloadInRangeMarker {
  name: string;
  value: string;
}

export interface AnalysisPayload {
  patient: {
    age: number | null;
    sex: PatientSex;
  };
  /** Redacted intake text, or null when the practitioner left it blank. */
  intake: string | null;
  flaggedMarkers: PayloadMarker[];
  inRangeMarkers: PayloadInRangeMarker[];
}

export interface DeidentifyInputs {
  age: number | null;
  sex: PatientSex;
  intake: string;
  /** Used only to redact the name back out of the intake text. Not sent. */
  patientName: string;
  /** Used only to redact the DOB back out of the intake text. Not sent. */
  dob?: string | null;
}

// ----- Structural (label-driven) redaction -----

/**
 * Labels whose VALUE is an identifier, whatever it happens to say. Matched at
 * the start of a line, case-insensitively.
 *
 * This runs before any name-based redaction and does not consult the form at
 * all, so a prior report for the wrong patient — or one that prints the name in
 * a different format than the practitioner typed — is still scrubbed.
 */
const IDENTIFIER_LABELS = [
  "patient name",
  "patient",
  "name",
  "date of birth",
  "birth date",
  "birthdate",
  "dob / age",
  "dob/age",
  "dob",
  "prepared for",
  "prepared by",
  "ordering provider",
  "ordering physician",
  "referring provider",
  "referring physician",
  "provider",
  "physician",
  "clinician",
];

// Longest label first so "patient name" wins over "patient", "dob / age" over "dob".
const LABEL_RE = new RegExp(
  `^\\s*[-•*]?\\s*(${IDENTIFIER_LABELS.slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join("|")})\\s*:\\s*(.*)$`,
  "i",
);

/** An age is not an identifier and is clinically useful — keep "(Age 50)". */
function preserveAge(value: string): string {
  const age = value.match(/\(\s*age\s*\d{1,3}\s*\)/i);
  return age ? `${REDACTED} ${age[0]}` : REDACTED;
}

/** A value line looks like data, not another label or a sentence of prose. */
function looksLikeValueLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (LABEL_RE.test(t)) return false;
  // Prose runs long; a header-block value does not.
  return t.length <= 80;
}

/**
 * Strip the value that follows an identifier label, whether it sits on the same
 * line ("Patient: St. Germain, Bonnie") or on the next one, which is how a
 * .docx header TABLE extracts ("Patient:" / "Heather Robidoux"). Handles both
 * "Last, First" and "First Last" because it never parses the name at all — it
 * removes whatever the label introduces.
 */
export interface LabeledRedaction {
  text: string;
  /** Name tokens harvested from the values that were removed. Redacting these
   *  document-wide is what catches the same person named in PROSE
   *  ("Bonnie originally presented with...") without ever consulting the form. */
  harvestedNames: string[];
}

/** Pull plausible name tokens out of a value we are about to redact. */
function harvestNameTokens(value: string, into: Set<string>): void {
  const head = value.split("|")[0].replace(/\(\s*age\s*\d{1,3}\s*\)/gi, "");
  // Drop anything date-shaped before tokenising, so months/years are not
  // mistaken for names.
  const cleaned = head
    .replace(/\b\d{1,4}[/-]\d{1,2}[/-]\d{2,4}\b/g, " ")
    .replace(new RegExp(`\\b(${MONTHS})\\b`, "gi"), " ");

  for (const token of cleaned.split(/[^A-Za-z'’-]+/)) {
    const t = token.replace(/^[-'’]+|[-'’]+$/g, "");
    if (t.length < 3) continue;
    if (!/^[A-Z]/.test(t)) continue;
    if (NON_NAME_TOKENS.has(t.toLowerCase())) continue;
    into.add(t);
  }
}

export function redactLabeledIdentifiers(text: string): LabeledRedaction {
  const lines = text.split("\n");
  const out: string[] = [];
  const harvested = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LABEL_RE);
    if (!m) {
      out.push(lines[i]);
      continue;
    }
    const [, label, sameLineValue] = m;
    const rest = (sameLineValue ?? "").trim();

    if (rest) {
      harvestNameTokens(rest, harvested);
      out.push(`${label}: ${preserveAge(rest)}`);
      continue;
    }

    // Value is on the following line (table-extracted header block).
    out.push(`${label}:`);
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) {
      out.push(lines[j]);
      j++;
    }
    if (j < lines.length && looksLikeValueLine(lines[j])) {
      harvestNameTokens(lines[j].trim(), harvested);
      out.push(preserveAge(lines[j].trim()));
      i = j;
    }
  }
  return { text: out.join("\n"), harvestedNames: [...harvested] };
}

// ----- Residual-name backstop -----

/** Words that make a Capitalized-Capitalized pair clinical vocabulary rather
 *  than a person. Kept deliberately broad: this is a review list, and a false
 *  positive costs a glance while a false negative costs a name. */
const NON_NAME_TOKENS = new Set(
  [
    // report / document furniture
    "report", "analysis", "summary", "clinical", "medicine", "functional", "lab",
    "laboratory", "results", "result", "panel", "range", "ranges", "optimal",
    "standard", "reference", "status", "marker", "markers", "phase", "protocol",
    "goal", "prior", "current", "patient", "practitioner", "provider", "physician",
    "chiropractic", "carbone", "center", "quest", "diagnostics", "health",
    "gorilla", "specimen", "collected", "reported", "ordering", "prepared",
    "decision", "support", "disclaimer", "note", "notes", "part", "section",
    "week", "weeks", "month", "months", "year", "years", "day", "days",
    "recommend", "recommended", "consider", "continue", "begin", "repeat",
    "order", "review", "reassess", "monitor", "taper", "intensify", "restart",
    "the", "this", "that", "these", "those", "there", "then", "with", "without",
    "her", "his", "their", "she", "him", "they", "for", "and", "but", "not",
    "given", "based", "due", "per", "via", "also", "both", "which", "while",
    // clinical vocabulary that shows up capitalized
    "vitamin", "total", "free", "serum", "blood", "cell", "red", "white",
    "thyroid", "antibodies", "antibody", "antigen", "iron", "sodium", "calcium",
    "glucose", "insulin", "cholesterol", "particle", "index", "acid", "ratio",
    "early", "nuclear", "capsid", "viral", "epstein", "barr", "grover",
    "raynaud", "hashimoto", "gilbert", "sleep", "apnea", "disease", "syndrome",
    "phenomenon", "deficiency", "reactivation", "borderline", "elevated", "low",
    "high", "normal", "negative", "positive", "male", "female", "age",
    "methylation", "hormone", "hormones", "adrenal", "kidney", "liver", "heart",
    "cardio", "particle", "size", "peak", "small", "medium", "large", "pattern",
    "fasting", "post", "pre", "follow", "up", "next", "first", "second", "third",
    "redacted", "truncated", "none", "not", "tested", "printed", "found",
  ].map((w) => w.toLowerCase()),
);

export interface ResidualNameCandidate {
  text: string;
  count: number;
}

/**
 * Surface anything still shaped like a person's name in text that is about to
 * be sent. Does NOT throw — a prior report legitimately contains capitalized
 * clinical terms, so this is a review list shown to the practitioner before the
 * call, not a blocker.
 */
export function findResidualNameCandidates(
  text: string,
  extraStopWords: string[] = [],
): ResidualNameCandidate[] {
  const stop = new Set(NON_NAME_TOKENS);
  for (const w of extraStopWords) {
    for (const token of w.split(/[^A-Za-z]+/)) {
      if (token.length >= 2) stop.add(token.toLowerCase());
    }
  }

  const counts = new Map<string, number>();
  // "Firstname Lastname", optionally with a middle initial or a particle.
  // [ \t]+ rather than \s+: a match must sit on one line, so a heading followed
  // by a sentence does not read as "Firstname Lastname".
  const re =
    /\b[A-Z][a-z]{1,15}(?:[ \t]+[A-Z]\.)?(?:[ \t]+(?:van|von|de|del|della|di|da|la|le|st\.?|mc|mac))?[ \t]+[A-Z][a-z]{1,15}\b/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const phrase = m[0];
    const words = phrase.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
    // Clinical if ANY word is known vocabulary — names rarely collide fully.
    if (words.some((w) => stop.has(w.replace(/[^A-Za-z]/g, "").toLowerCase()))) continue;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([text2, count]) => ({ text: text2, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
}

// ----- Intake redaction -----

/** Escape a string for literal use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December|" +
  "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";

/**
 * Best-effort scrub of the freeform intake text. Removes the known patient name
 * and anything that looks like a specific date, while leaving durations
 * ("6 months", "3 weeks") and ages intact — those are clinically load-bearing.
 *
 * Best-effort is the honest description: an unrelated name typed into the
 * intake box cannot be detected here. The practitioner is told not to paste
 * identifiers, and the guidance sits under the textarea on the page.
 */
export function redactIntake(
  intake: string,
  patientName: string,
  dob?: string | null,
  /** Additional personal names to strip — e.g. the practitioner named in a
   *  prior report's "Prepared For" line. Not patient PHI, but there is no
   *  reason to send a person's name to the API. */
  extraNames: string[] = [],
): string {
  let out = intake;

  // 1. Known personal names, whole and by token (tokens of 3+ chars only, so a
  //    middle initial can't blank out every "A" in the text).
  for (const raw of [patientName, ...extraNames]) {
    const whole = (raw ?? "").trim();
    if (whole.length >= 3) {
      out = out.replace(new RegExp(escapeRe(whole), "gi"), REDACTED);
    }
    const tokens = whole
      .split(/\s+/)
      .map((t) => t.replace(/[^A-Za-z'-]/g, ""))
      .filter((t) => t.length >= 3);
    for (const t of tokens) {
      out = out.replace(new RegExp(`\\b${escapeRe(t)}\\b`, "gi"), REDACTED);
    }
  }

  // 2. The DOB in the form's own format, plus its US rendering.
  const d = (dob ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (d) {
    for (const form of [
      `${d[1]}-${d[2]}-${d[3]}`,
      `${d[2]}/${d[3]}/${d[1]}`,
      `${Number(d[2])}/${Number(d[3])}/${d[1]}`,
    ]) {
      out = out.replace(new RegExp(escapeRe(form), "g"), REDACTED);
    }
  }

  // 3. Anything else shaped like a specific date.
  out = out
    // 03/07/2026, 3-7-26, 2026/03/07
    .replace(/\b\d{1,4}[/-]\d{1,2}[/-]\d{2,4}\b/g, REDACTED)
    // 2026-03-07
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, REDACTED)
    // March 7, 2026 / Mar 7 2026 / 7 March 2026
    .replace(new RegExp(`\\b(${MONTHS})\\.?\\s+\\d{1,2}(st|nd|rd|th)?,?\\s+\\d{4}\\b`, "gi"), REDACTED)
    .replace(new RegExp(`\\b\\d{1,2}\\s+(${MONTHS})\\.?,?\\s+\\d{4}\\b`, "gi"), REDACTED)
    // Bare "March 2026"
    .replace(new RegExp(`\\b(${MONTHS})\\.?\\s+\\d{4}\\b`, "gi"), REDACTED);

  return out.trim();
}

// ----- Payload -----

export function buildPayload(
  flagged: FlaggedMarker[],
  inputs: DeidentifyInputs,
): AnalysisPayload {
  const flaggedMarkers: PayloadMarker[] = flagged.filter(isFlagged).map((m) => ({
    name: m.canonicalName,
    result: formatResult(m),
    value: m.value,
    unit: m.unit || null,
    labRange: formatLabRange(m),
    optimalRange: formatOptimalRange(m),
    status: formatStatus(m, withinLabRange(m)),
    direction: m.flagDirection,
  }));

  const inRangeMarkers: PayloadInRangeMarker[] = flagged
    .filter((m) => m.flagStatus === "optimal")
    .map((m) => ({
      name: m.canonicalName,
      value: `${m.value}${m.unit ? ` ${m.unit}` : ""}`,
    }));

  const intake = inputs.intake.trim()
    ? redactIntake(inputs.intake, inputs.patientName, inputs.dob)
    : null;

  return {
    patient: { age: inputs.age, sex: inputs.sex },
    intake,
    flaggedMarkers,
    inRangeMarkers,
  };
}

// ----- Re-evaluation payload -----

export interface ReevalPayload {
  patient: {
    age: number | null;
    sex: PatientSex;
    /** "~8 months" — the interval only. The prior panel's date never leaves. */
    priorPanelInterval: string | null;
  };
  intake: string | null;
  /** Markers the engine flags on the CURRENT panel — authoritative. */
  currentFlaggedMarkers: PayloadMarker[];
  /** Every matched marker on the current panel, so the model can look up the
   *  current value of a marker the prior report flagged. Authoritative. */
  currentAllMarkers: PayloadInRangeMarker[];
  /** De-identified prior report text — the ONLY source of prior values. */
  priorReportText: string;
}

export interface ReevalDeidentifyInputs extends DeidentifyInputs {
  priorPanelInterval: string | null;
  /** Already redacted by lib/analysis/prior-report.ts. */
  priorReportText: string;
}

export function buildReevalPayload(
  flagged: FlaggedMarker[],
  inputs: ReevalDeidentifyInputs,
): ReevalPayload {
  const base = buildPayload(flagged, inputs);
  return {
    patient: {
      age: inputs.age,
      sex: inputs.sex,
      priorPanelInterval: inputs.priorPanelInterval,
    },
    intake: base.intake,
    currentFlaggedMarkers: base.flaggedMarkers,
    currentAllMarkers: flagged
      .filter((m) => m.matchStatus === "matched")
      .map((m) => ({
        name: m.canonicalName,
        value: `${m.value}${m.unit ? ` ${m.unit}` : ""}`,
      })),
    priorReportText: inputs.priorReportText,
  };
}

/** The exact JSON string embedded in the prompt. Log this to audit what left. */
export function serializePayload(payload: AnalysisPayload | ReevalPayload): string {
  return JSON.stringify(payload, null, 2);
}

/**
 * Belt-and-braces check used by the generate route before any network call:
 * scan the serialized payload for the identifiers we know about. Throws rather
 * than sending if one survived redaction.
 */
export function assertNoIdentifiers(
  serialized: string,
  identifiers: { patientName: string; dob?: string | null },
): void {
  const hay = serialized.toLowerCase();
  const offenders: string[] = [];

  const nameTokens = identifiers.patientName
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z'-]/g, ""))
    .filter((t) => t.length >= 3);
  for (const t of nameTokens) {
    if (new RegExp(`\\b${escapeRe(t.toLowerCase())}\\b`).test(hay)) {
      offenders.push(`patient name token "${t}"`);
    }
  }

  const d = (identifiers.dob ?? "").trim();
  if (d && hay.includes(d.toLowerCase())) offenders.push("date of birth");

  if (offenders.length) {
    throw new Error(
      `Refusing to send the analysis payload: it still contains ${offenders.join(", ")}.`,
    );
  }
}
