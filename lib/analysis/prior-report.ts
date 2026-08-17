/**
 * Prior-report ingestion for Re-evaluation mode.
 *
 * Extracts plain text from the practitioner's previous report (.docx via
 * mammoth, .pdf via the same pdf-parse path the lab parser uses) and runs it
 * through the SAME redaction as the intake box before it is used anywhere.
 *
 * This matters more here than for intake: a prior report carries the patient's
 * name and DOB in its own header block, so the raw extraction is PHI. Nothing
 * outside this module should ever see `raw` — `ingestPriorReport` returns the
 * redacted text, and the raw string is discarded when this function returns.
 *
 * The tool does NOT re-flag the prior blood work. This text is context for the
 * comparative reasoning step (Phase 2b) and the source of the prior-value
 * column; the current side of the chart always comes from the flagging engine.
 */

import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { redactIntake } from "./deidentify";
import { PREPARED_FOR } from "./deterministic";

/** Upper bound on the text handed downstream. Generous — the Bonnie sample is
 *  ~12k characters — but bounded so a pathological upload cannot blow up a
 *  later prompt. */
export const MAX_PRIOR_TEXT_CHARS = 80_000;

export class PriorReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriorReportError";
  }
}

export type PriorReportKind = "docx" | "pdf";

export interface PriorReportIngest {
  kind: PriorReportKind;
  /** De-identified text. This is the ONLY text callers get back. */
  redactedText: string;
  /** Diagnostics for the UI / logs. No content, just sizes. */
  rawChars: number;
  redactedChars: number;
  redactionCount: number;
  truncated: boolean;
}

export function priorReportKind(filename: string): PriorReportKind | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".pdf")) return "pdf";
  return null;
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value ?? "";
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText();
  return result.text ?? "";
}

/**
 * Extract + de-identify in one step. The caller never receives the raw text,
 * so there is no path where un-redacted prior-report content reaches a prompt.
 */
export async function ingestPriorReport(
  buffer: Buffer,
  filename: string,
  identifiers: { patientName: string; dob?: string | null },
): Promise<PriorReportIngest> {
  const kind = priorReportKind(filename);
  if (!kind) {
    throw new PriorReportError("The prior report must be a .docx or .pdf file.");
  }

  let raw: string;
  try {
    raw = kind === "docx" ? await extractDocx(buffer) : await extractPdf(buffer);
  } catch {
    throw new PriorReportError(
      `Could not read the prior report (${kind.toUpperCase()}). Please check the file and try again.`,
    );
  }

  const rawChars = raw.length;
  if (!raw.trim()) {
    throw new PriorReportError(
      "The prior report appears to contain no readable text. If it is a scanned PDF, export a text-based copy.",
    );
  }

  // Normalize the whitespace a Word/PDF export leaves behind, then redact.
  const normalized = raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // A prior report names the practitioner in its "Prepared For" line; strip
  // that too. Not patient PHI, but no personal name needs to reach the API.
  const redacted = redactIntake(normalized, identifiers.patientName, identifiers.dob, [
    PREPARED_FOR,
  ]);

  const truncated = redacted.length > MAX_PRIOR_TEXT_CHARS;
  const redactedText = truncated
    ? `${redacted.slice(0, MAX_PRIOR_TEXT_CHARS)}\n\n[TRUNCATED]`
    : redacted;

  return {
    kind,
    redactedText,
    rawChars,
    redactedChars: redactedText.length,
    redactionCount: (redactedText.match(/\[REDACTED\]/g) ?? []).length,
    truncated,
  };
}
