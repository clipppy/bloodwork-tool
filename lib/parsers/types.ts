/**
 * Shared types for lab PDF parsers.
 *
 * Parsers extract RAW data only. They do not look up canonical markers in
 * the optimal-ranges library, compute flags, or assign severity. Those steps
 * live in the (still-to-be-built) flagging engine.
 */

export interface ParsedMarker {
  /** Exact marker name string as it appeared in the PDF (e.g. "GLUCOSE"). */
  rawName: string;
  /** Numeric value, or a string for categorical / unparseable results
   *  (e.g. "B" for LDL Pattern, "SEE NOTE:" when value wasn't reported). */
  value: number | string;
  /** Unit string, or null if the PDF didn't include one. */
  unit: string | null;
  /** H/L flag the lab itself applied next to the value, or null. */
  labFlagFromPdf: "H" | "L" | null;
  /** Reference range text exactly as it appeared in the PDF, joined with
   *  " | " separator if it spans multiple lines (cycle-phase ranges,
   *  interpretation tables, etc.). Null if no reference range was present. */
  referenceRangeRaw: string | null;
  /** Page number the value appeared on (1-indexed). For debugging. */
  pageNumber: number;
  /** The original line text — useful for debugging parser issues. May contain
   *  patient name (PHI). Safe in-memory only; never persist this field. */
  rawLine: string;
}

export interface PatientMeta {
  collectedDate: string | null;
  reportedDate: string | null;
  /** "Quest" if the PDF is a direct Quest report, "Function" if it's a
   *  Health Gorilla / Function Health distribution wrapping Quest, "Unknown"
   *  otherwise. */
  labSource: "Quest" | "Function" | "Unknown";
}

export interface ParseResult {
  markers: ParsedMarker[];
  patientMeta: PatientMeta;
  /** Lines the parser couldn't categorize, for debugging. Excludes lines that
   *  were intentionally skipped (page headers, disclaimers, etc.). */
  unparsedLines: string[];
  parserVersion: string;
}
