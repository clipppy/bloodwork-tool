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
): string {
  let out = intake;

  // 1. Known patient name, whole and by token (tokens of 3+ chars only, so a
  //    middle initial can't blank out every "A" in the text).
  const nameTokens = patientName
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z'-]/g, ""))
    .filter((t) => t.length >= 3);
  const wholeName = patientName.trim();
  if (wholeName.length >= 3) {
    out = out.replace(new RegExp(escapeRe(wholeName), "gi"), REDACTED);
  }
  for (const t of nameTokens) {
    out = out.replace(new RegExp(`\\b${escapeRe(t)}\\b`, "gi"), REDACTED);
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

/** The exact JSON string embedded in the prompt. Log this to audit what left. */
export function serializePayload(payload: AnalysisPayload): string {
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
