/**
 * Labcorp "Patient Report" parser.
 *
 * Produces the same ParseResult shape as the Quest parser so matching,
 * flagging, printed-range reading and the multi-PDF merge run unchanged.
 *
 * Layout (per panel):
 *
 *   Fe+TIBC+Fer                                   <- panel header
 *   Test  Current Result and Flag  Previous Result and Date  Units  Reference Interval
 *   Iron 01   212   High   110   08/05/2025   ug/dL   27-159
 *
 * The column header line is the layout fingerprint (there is no literal
 * "Labcorp" string to key on in the body). Marker names carry a trailing
 * two-digit performing-lab code ("01") which is stripped; flags are the
 * words "High" / "Low"; the "Previous Result and Date" column is captured
 * as previousValue / previousDate and is never the current value.
 *
 * Two text forms are handled. pdf-parse (the app's extraction path)
 * collapses the columns to single spaces and joins a wrapped row (name on
 * one line, numbers on the next) back into one line. pdftotext -layout keeps
 * the wrap, so a name-only line followed by a numeric line is joined here,
 * the same way the Quest parser joins a two-line marker name.
 *
 * Columns are read right-to-left, which is unambiguous: reference interval,
 * then an optional unit, then an optional previous value + date, then an
 * optional flag word, then the current value; what remains is the name.
 */

import { PDFParse } from "pdf-parse";
import type { ParseResult, ParsedMarker, PatientMeta } from "./types";

const PARSER_VERSION = "labcorp-1.0.0";

/** The column header printed above every result table, whitespace-collapsed. */
export const LABCORP_TABLE_HEADER =
  "Test Current Result and Flag Previous Result and Date Units Reference Interval";

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

export function isLabcorpTableHeader(line: string): boolean {
  return collapse(line) === LABCORP_TABLE_HEADER;
}

/** Layout fingerprint: at least one result-table column header. */
export function looksLikeLabcorpReport(text: string): boolean {
  return text.split(/\r?\n|\f/).some(isLabcorpTableHeader);
}

// ---- Row grammar ----------------------------------------------------------

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
/** "212", "3.680", "<5", ">600", ">=190" — a result or threshold value. */
const VALUE_RE = /^[<>]?=?\d+(?:\.\d+)?$/;
/** "250-450", "0.450-4.500", "<100", ">39", "<=5.0". */
const RANGE_RE = /^(?:\d+(?:\.\d+)?-\d+(?:\.\d+)?|[<>]=?\d+(?:\.\d+)?)$/;
/** A unit has at least one letter or "%" and no spaces: ug/dL, x10E3/uL,
 *  mL/min/1.73, %, IU/L. */
const UNIT_RE = /^(?=.*[A-Za-z%])[A-Za-z0-9%/.*^()[\]-]+$/;
const LAB_CODE_RE = /^\d{2}$/;
const FLAG_WORDS: Record<string, "H" | "L"> = { High: "H", Low: "L" };
/** Single-token categorical results Labcorp prints in the value column. */
const CATEGORICAL_VALUES = new Set([
  "Negative",
  "Positive",
  "Reactive",
  "Nonreactive",
  "Non-Reactive",
  "Normal",
  "Abnormal",
  "Detected",
  "Equivocal",
  "Indeterminate",
]);

const isValueToken = (t: string): boolean => VALUE_RE.test(t) || CATEGORICAL_VALUES.has(t);

function toValue(t: string): number | string {
  return /^\d+(?:\.\d+)?$/.test(t) ? Number(t) : t;
}

export interface LabcorpRow {
  name: string;
  value: number | string;
  flag: "H" | "L" | null;
  previousValue: number | string | null;
  previousDate: string | null;
  unit: string | null;
  /** Printed reference interval; null for "Not Estab." (no range). */
  referenceRangeRaw: string | null;
}

/**
 * Parse one result row (already joined if it wrapped). Returns null for
 * anything that is not a row: panel headers, footnotes, the ASCII risk
 * tables under the lipid panel, interpretation lists ("Desirable < 90").
 */
export function parseLabcorpRow(line: string): LabcorpRow | null {
  const tokens = collapse(line).split(" ");
  if (tokens.length < 2) return null;
  let i = tokens.length - 1;

  // 1. Reference interval (rightmost). "Not Estab." = no range.
  let referenceRangeRaw: string | null;
  if (tokens[i] === "Estab." && tokens[i - 1] === "Not") {
    referenceRangeRaw = null;
    i -= 2;
  } else if (RANGE_RE.test(tokens[i])) {
    referenceRangeRaw = tokens[i];
    i -= 1;
  } else {
    return null;
  }

  // 2. Optional unit (absent for ratios like BUN/Creatinine).
  let unit: string | null = null;
  if (
    i >= 1 &&
    !DATE_RE.test(tokens[i]) &&
    !(tokens[i] in FLAG_WORDS) &&
    !isValueToken(tokens[i]) &&
    UNIT_RE.test(tokens[i])
  ) {
    unit = tokens[i];
    i -= 1;
  }

  // 3. Optional previous result + date. The value may carry a trailing "*"
  //    pointing at a "Previous Reference Interval" footnote.
  let previousValue: number | string | null = null;
  let previousDate: string | null = null;
  if (i >= 2 && DATE_RE.test(tokens[i])) {
    const prev = tokens[i - 1].replace(/\*+$/, "");
    if (!isValueToken(prev)) return null;
    previousDate = tokens[i];
    previousValue = toValue(prev);
    i -= 2;
  }

  // 4. Optional flag word, then the current value, then at least one name token.
  let flag: "H" | "L" | null = null;
  if (i >= 2 && tokens[i] in FLAG_WORDS) {
    flag = FLAG_WORDS[tokens[i]];
    i -= 1;
  }
  if (i < 1) return null;
  const current = tokens[i].replace(/\*+$/, "");
  if (!isValueToken(current)) return null;
  i -= 1;

  // 5. Name: strip the trailing performing-lab code ("01").
  let nameTokens = tokens.slice(0, i + 1);
  if (nameTokens.length > 1 && LAB_CODE_RE.test(nameTokens[nameTokens.length - 1])) {
    nameTokens = nameTokens.slice(0, -1);
  }
  const name = nameTokens.join(" ");
  if (!/[A-Za-z]/.test(name) || LAB_CODE_RE.test(name) || /:$/.test(name)) return null;

  return { name, value: toValue(current), flag, previousValue, previousDate, unit, referenceRangeRaw };
}

// ---- Document walk --------------------------------------------------------

/** Lines that end a result table (page furniture and the trailing sections). */
const TABLE_END_RE = [
  /^Date Created and Stored/i,
  /^-- \d+ of \d+ --$/,
  /^©/,
  /^Previous Result$/i,
  /^Icon Legend/i,
  /^Performing Labs/i,
  /^Patient Details/i,
  /^Historical Results/i,
];

/** Lines inside a table that are not rows and not worth reporting. */
const SKIP_RE = [
  /^\* Previous Reference Interval/i,
  /^Please Note:/i,
  /^[:_]/, // ASCII box-drawn lipid risk table
];

/** A name-only line (wrapped row): letters, no range token, optional trailing
 *  lab code. The numbers for it are on the next line. */
const NAME_ONLY_RE = /^[A-Za-z][^\n]*?(?:\s+\d{2})?$/;
const STARTS_WITH_VALUE_RE = /^[<>]?=?\d/;

function extractPatientMeta(text: string): PatientMeta {
  const collected = text.match(/Date Collected:\s*(\d{2}\/\d{2}\/\d{4})/)?.[1] ?? null;
  const reported = text.match(/Date Reported:\s*(\d{2}\/\d{2}\/\d{4})/)?.[1] ?? null;
  return { collectedDate: collected, reportedDate: reported, labSource: "Labcorp" };
}

export async function parseLabcorpPdf(buffer: Buffer): Promise<ParseResult> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  return parseLabcorpText((await parser.getText()).text ?? "");
}

export function parseLabcorpText(text: string): ParseResult {
  const patientMeta = extractPatientMeta(text);
  const markers: ParsedMarker[] = [];
  const unparsedLines: string[] = [];

  // Page tracking: pdftotext separates pages with \f, pdf-parse with a
  // "-- N of M --" line.
  const lines: { text: string; pageNumber: number }[] = [];
  let page = 1;
  for (const raw of text.split(/\r?\n/)) {
    const parts = raw.split(/\f/);
    parts.forEach((part, idx) => {
      if (idx > 0) page += 1;
      lines.push({ text: part, pageNumber: page });
    });
  }

  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const { text: rawLine, pageNumber } = lines[i];
    const line = rawLine.trim();
    if (!line) continue;

    const pageBreak = line.match(/^-- (\d+) of \d+ --$/);
    if (pageBreak) page = Number(pageBreak[1]) + 1;

    if (isLabcorpTableHeader(line)) {
      inTable = true;
      continue;
    }
    if (TABLE_END_RE.some((re) => re.test(line))) {
      inTable = false;
      continue;
    }
    if (!inTable) continue;
    if (SKIP_RE.some((re) => re.test(line))) continue;

    let row = parseLabcorpRow(line);
    let consumed = 0;
    if (!row && NAME_ONLY_RE.test(line) && !RANGE_RE.test(line.split(/\s+/).pop() ?? "")) {
      // Wrapped row: name alone, numbers on the next non-blank line.
      let j = i + 1;
      while (j < lines.length && !lines[j].text.trim()) j++;
      const next = lines[j]?.text.trim() ?? "";
      if (next && STARTS_WITH_VALUE_RE.test(next)) {
        row = parseLabcorpRow(`${line} ${next}`);
        if (row) consumed = j - i;
      }
    }
    if (!row) {
      unparsedLines.push(line);
      continue;
    }
    i += consumed;

    markers.push({
      rawName: row.name,
      value: row.value,
      unit: row.unit,
      labFlagFromPdf: row.flag,
      referenceRangeRaw: row.referenceRangeRaw,
      pageNumber: lines[i]?.pageNumber ?? pageNumber,
      rawLine: consumed ? `${line} ${lines[i].text.trim()}` : line,
      previousValue: row.previousValue,
      previousDate: row.previousDate,
    });
  }

  return {
    markers,
    patientMeta,
    unparsedLines,
    parserVersion: PARSER_VERSION,
    stats: { duplicatesRemoved: 0, bandRowsRejected: 0, divergentValueNames: [] },
  };
}
