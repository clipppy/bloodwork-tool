/**
 * Quest Diagnostics PDF parser.
 *
 * Extracts raw marker data from Quest lab PDFs (including those distributed
 * via Function Health / Health Gorilla — they use the same underlying Quest
 * format).
 *
 * Returns a ParseResult. Does NOT match against optimal-ranges, compute
 * flags, or assign severity — those are downstream concerns.
 */

import { PDFParse } from "pdf-parse";
import type { ParseResult, ParsedMarker, PatientMeta } from "./types";

const PARSER_VERSION = "1.0.0";

// ---- Known token sets -----------------------------------------------------

// Quest's lab-site codes — short uppercase tokens that appear at the END of
// marker rows and (annoyingly) sometimes in the middle of panel headers
// because the original PDF wrapped them. Known set from the 6 sample PDFs.
const LAB_CODES = new Set([
  "NL1",
  "AMD",
  "EZ",
  "MI",
  "RAM",
  "RFL",
  "Z4M",
  "Z3M",
  "DAL",
  "TPA",
  "JI",
]);

// Units that appear at the end of marker rows. Longest-first ordering matters
// when checking suffix matches.
const UNITS = [
  "mL/min/1.73m2",
  "Thousand/uL",
  "Million/uL",
  "nmol/min/mL",
  "umol/min/mL",
  "cells/uL",
  "% by wt",
  "mcg/dL",
  "mIU/mL",
  "uIU/mL",
  "ng/mL",
  "ng/dL",
  "pg/mL",
  "mg/dL",
  "mg/L",
  "g/dL",
  "mmol/L",
  "umol/L",
  "mEq/L",
  "nmol/L",
  "mIU/L",
  "IU/mL",
  "IU/L",
  "U/mL",
  "U/L",
  "fL",
  "pg",
  "Angstrom",
  "Pattern",
  "%",
];

// Section/panel headers in Quest PDFs (skip — these aren't markers). The
// parser also catches generic "all-caps line with no value" panels.
const KNOWN_PANEL_HEADERS = [
  "COMPREHENSIVE METABOLIC PANEL",
  "CBC (INCLUDES DIFF/PLT)",
  "IRON AND TOTAL IRON BINDING CAPACITY",
  "EPSTEIN BARR VIRUS ANTIBODY PANEL",
  "LIPID PANEL, STANDARD",
  "TESTOSTERONE, FREE, BIOAVAILABLE AND TOTAL, MS",
  "TESTOSTERONE, FREE AND BIOAVAILABLE",
  "SEX HORMONE BINDING GLOBULIN",
  "LIPOPROTEIN FRACTIONATION ION MOBILITY",
  "OMEGACHECK(R)",
  "CALCITRIOL 1,25 DIHYDROXYVITAMIN D",
  "ALBUMIN, RANDOM URINE W/O CREATININE",
  "HEMOGLOBIN A1c",
  "URIC ACID",
  "GGT",
  "TSH",
  "FSH",
  "LH",
  "APOLIPOPROTEIN B",
  "LIPOPROTEIN (a)",
  "HS CRP",
  "HOMOCYSTEINE",
  "PROGESTERONE",
  "ESTRADIOL, ULTRASENSITIVE, LC/MS/MS",
  "DHEA SULFATE",
  "PREGNENOLONE, LC/MS",
];

// Header / footer / disclaimer patterns to skip silently.
const SKIP_PATTERNS: RegExp[] = [
  /^Report Status:/i,
  /^Patient Information/i,
  /^DOB:/,
  /^Gender:/,
  /^Phone( \(H\))?:/i,
  /^Patient ID:/i,
  /^Health ID:/,
  /^Specimen:/i,
  /^Requisition:/,
  /^Client #:/,
  /^Source:\s*Quest/i,
  /^STATUS:\s*Final/i,
  /^Accession$/,
  /^Number:$/,
  /^Lab Ref #:/,
  /^Collected:\s*\d/i,
  /^Received:\s*\d/i,
  /^Reported:\s*\d/i,
  /^Time Reported:/i,
  /^Collection Date:/i,
  /^Time Collected:/i,
  /^UTC$/,
  /^PM UTC$/,
  /^AM UTC$/,
  /^EDT$/,
  /^EST$/,
  /^[A-Z]{2}\d{6}[A-Z]?\d?$/, // accession numbers like WC713097V, MZ917071L
  /^ORDERING PHYSICIAN:/i,
  /^Floor \d+$/,
  /^\d{3} (Congress|Forest|Wolcott)\b/, // address lines
  /^[A-Z][a-z]+,\s*(TX|MA|CT|VA|CA),\s*\d{5}/, // city/state/zip
  /^CARBONE CHIROPRACTIC$/i,
  /^\d{2,}-\d{2,}\s+\w+\s+(HILL|FOREST|ST|RD|DR|AVE)/i,
  /^CLIENT SERVICES:/i,
  /^Quest, Quest Diagnostics/i,
  /^COMMENTS:/i,
  /^Test Name In Range Out Of Range Reference Range Lab$/,
  /^Test In Range Out Of Range Reference Range Lab$/,
  /^Test Name Result Reference Range Lab$/,
  /^PAGE \d+ OF \d+$/i,
  /^Page \d+ of \d+$/i,
  /^-- \d+ of \d+ --$/,
  // Function-distributed "Appendix 1 [Enhanced PDF Report WC...] - Page X of Y"
  /^Appendix \d+\s*\[/,
  /^Appendix \d+/,
  // "Peak >20.0 mcg/dL" disclaimer for vitamin B12 etc.
  /^Peak [<>]/,
  // "Trough" similar
  /^Trough [<>]/,
  // Interpretation-table data rows that aren't real markers:
  //   "< or = 25 85 19"
  //   "< or = 30 93 9"
  /^<\s*or\s*=\s+\d/i,
  /^>\s*or\s*=\s+\d/i,
  // Narrative continuations that start with lowercase / connector words
  /^factor,\s/i,
  /^option\.$/i,
  /^purposes\.$/i,
  /^purpose\.$/i,
  /^inflammation\.$/i,
  /^infection\.$/i,
  /^Other causes/i,
  /^and inflammation/i,
  /^excretion as follows:/i,
  /^reference range\.$/i,
  /^The ADA recommends/i,
  /^The ADA defines/i,
  /^specimens collected within/i,
  /^abnormal before considering/i,
  /^within a diagnostic/i,
  /^A1c $/i,
  /^For additional information/i,
  /^This test was developed/i,
  /^http(s)?:\/\//i,
  /^\(http/,
  /educational purposes only/i,
  /^Printed from Health Gorilla/i,
  /^https:\/\/www\.healthgorilla\.com/,
  /^The contents of this document/i,
  /^contain information that is legally privileged/i,
  /^intended recipient,/i,
  /^or obtained this document/i,
  /^privacy@healthgorilla\.com/,
  /^FASTING:/i,
  /^FASTING /i,
  /^PERFORMING SITE:/i,
  /^Endocrinology$/,
  /^Physician Comments:/i,
  /^Selhub J, et al/,
  /^Martin SS et al/,
  /^Pearson TA,/,
  /^Jellinger PS et al/,
  /^Grundy SM,/,
  /^Handelsman Y,/,
  /^Adult Female Reference Ranges/,
  /^The ADA defines/,
  /^Albuminuria Category/,
  /^Normal to Mildly/,
  /^Moderately increased/,
  /^Severely increased/,
  /^Therapeutic target/,
  /^Desirable range/,
  /^For patients with diabetes/,
  /^LDL-C is now calculated/,
  /^calculation, which is/i,
  /^better accuracy than/,
  /^estimation of LDL-C/,
  /^For someone without known diabetes/,
  /^between 100 and 125/,
  /^prediabetes and should be/,
  /^follow-up test\.$/,
  /^Non-fasting reference interval$/,
  /^Fasting reference interval$/,
  /^of increased homocysteine/,
  /^antagonists such as/,
  /^exposure to nitrous oxide/,
  /^differentiates between these/,
  /^folate or vitamin B12/,
  /^Homocysteine is increased by/,
  /^Pre-Menopausal/,
  /^Postmenopausal Phase/,
  /^Suggestive of a recent/,
  /^INTERPRETATION:/,
  /^Reference Ranges? for Progesterone/i,
  /^used for clinical purposes/,
  /^to the CLIA regulations/,
  /^not been cleared or approved/i,
  /^Administration\.\s*This/i,
  /^characteristics have been/,
  /^Diagnostics Nichols Institute/,
  /^Diagnostics Cardiometabolic/,
  /^Drug Administration\./,
  /^Risk Category:/,
  /^Risk According to/,
  /^Lower relative cardiovascular/,
  /^Average relative cardiovascular/,
  /^Higher relative cardiovascular/,
  /^Persistent elevation/,
  /^may be associated with/,
  /^inflammation\.\s*$/,
  /^Consider retesting/,
  /^exclude a benign/,
  /^in the baseline CRP/,
  /^to infection or/,
  /^Of inflammation and/i,
  /^Centers for Disease Control/,
  /^A statement for healthcare/,
  /^application to clinical/,
  /^American Heart Association/,
  /^For ages /i,
  /^The potential exists for/,
  /^false positive EBV-EA/,
  /^\(Human Immunodeficiency Virus\)/,
  /^Relative Risk:/i, // multi-line, but we'll consume the first
  /^Male( and Female)? Reference Range/i,
  /^Female Reference Range/i,
  /^Range: \d/i,
  /^Range: Pattern/i,
  /^Range\.\s*Adult/i,
  /^points \(optimal/,
  /^reference population/,
  /^populations\./,
  /^Association between lipoprotein/,
  /^ATVB\.\d/,
  /^Angstrom\. Adult cardiovascular/,
  /^link is being provided/i,
  /^cut points are based/,
  /^recommendations\.$/,
  /^ApoB relative risk/,
  /^cut points/,
  /^A desirable treatment/,
  /^depending on the risk/,
  /^patients on lipid/,
  /^ASCVD, diabetes/,
  /^greater CKD/,
  /^hypercholesterolemia\./,
  /^Optimal <[\d.]+$/, // CRP narrative band line
  /^Moderate [\d.]+-[\d.]+$/,
  /^High > or = [\d.]+/,
  /^treating to a non-HDL-C/i,
  /^\(LDL-C of </i,
  /^option\.\s*$/,
  /^with > or = 2/i,
  /^<\d+ mg\/dL for/i,
  /^A1c$/i,
  /^TotalTestosteroneLCMSMSFAQ/,
  /^Vitamin D3, 1,25\(OH\)2 indicates/i,
  /^diet or supplementation/i,
  /^been cleared or approved/i,
  /^Copyright © 20/,
  /^All Rights Reserved/i,
  /^Other causes/,
  /^Reference Range$/i,        // standalone "Reference Range" header — context-tracked below
  /^Risk Category:$/,
  /^Not Reported:/i,
  /^Not established$/i,
  /^See Note:$/i,
];

const PATIENT_BANNER_NAME_RE =
  /^(VALLES, GINA|Guy Carbone|Steven Windwer|Taylor Miles|[A-Z][a-z]+ [A-Z][a-z]+ Quest Result )/;

// Patient name / clinic name patterns we want to skip without leaking into
// unparsedLines. The names in our 6 sample PDFs:
const PATIENT_NAMES_RE = /^(VALLES, GINA|Guy Carbone|Steven Windwer|Taylor Miles|TULISANO, MELISSA A|Joshua A Emdur,|Rebecca Ann|Hamm, ARNP|D\.O\.|, ARNP)$/;

// Reference range "spill" patterns:
//   "Reference range: <100"
//   "Reference Range: <90"
//   "Reference Range:"
const REF_RANGE_SPILL_RE = /^Reference [Rr]ange:?\s*(.*)$/;

// Cycle-phase / interpretation-band continuation lines (capture after a
// "Reference Range" / "Reference Ranges" header).
const PHASE_LINE_RE =
  /^(Follicular Phase|Mid-?[Cc]ycle Peak|Luteal Phase|Postmenopausal( Phase)?|Pre-Menopausal[^\n]*|Optimal|Moderate|High|Negative|Equivocal|Positive|Pattern [AB]|Reference Range|Range\.\s*)/;

// EBV interpretation table separator
const EBV_TABLE_SEP_RE = /^-{3,}\s+-{3,}/;
const EBV_TABLE_HEAD_RE = /^U\/mL\s+Interpretation\s*$/i;

// ---- Helpers -------------------------------------------------------------

function tokenize(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

function isLabCode(token: string): boolean {
  return LAB_CODES.has(token);
}

/** Match a trailing unit against the END of a token array. Returns the matched
 *  unit string and the number of trailing tokens it consumed, or null. */
function matchTrailingUnit(tokens: string[]): { unit: string; consumed: number } | null {
  // Try multi-token units first (longest first via UNITS ordering).
  for (const u of UNITS) {
    const parts = u.split(/\s+/);
    if (tokens.length < parts.length) continue;
    const tail = tokens.slice(tokens.length - parts.length);
    if (tail.join(" ") === u) return { unit: u, consumed: parts.length };
  }
  return null;
}

/** Numeric / comparison / categorical value pattern. */
function looksLikeValue(token: string): boolean {
  // Plain numeric (with optional thousands separator)
  if (/^-?\d+(,\d{3})*(\.\d+)?$/.test(token)) return true;
  // Comparison-prefixed: <0.1, >600.00, <=, >=
  if (/^[<>]=?-?\d+(\.\d+)?$/.test(token)) return true;
  return false;
}

/** Strict numeric (after stripping any comparison prefix) → number, else
 *  return the raw string. */
function parseValue(token: string): number | string {
  const stripped = token.replace(/^[<>]=?/, "").replace(/,/g, "");
  const n = Number(stripped);
  if (Number.isFinite(n) && /^[<>]?[<>]?=?-?\d+(\.\d+)?$/.test(token.replace(/,/g, ""))) {
    // Keep the comparison prefix in the string form when present
    return /^[<>]/.test(token) ? token : n;
  }
  return token;
}

/** Categorical / SEE-NOTE-style value detector. */
function looksLikeCategoricalValue(token: string): boolean {
  return (
    /^SEE$/.test(token) ||
    /^Pattern$/i.test(token) ||
    /^NEGATIVE$/i.test(token) ||
    /^POSITIVE$/i.test(token) ||
    /^[A-Z]$/.test(token) // single capital letter, e.g., "A", "B"
  );
}

/** Pre-pass: join PDF-parse artifacts (lab code on next line, "(calc)"
 *  fragment, "mL/min/1.\n73m2" unit split, etc.). */
function preprocess(rawLines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i].replace(/\s+$/, "");

    // Join unit fragment: "mL/min/1." + "73m2"
    if (i + 1 < rawLines.length && /\bmL\/min\/1\.\s*$/.test(line)) {
      const next = rawLines[i + 1].trim();
      if (/^73m2/.test(next)) {
        line = line.replace(/\s*$/, "") + next;
        i++;
      }
    }

    // Join wrapped "(calc)": current line ends mid-row, next is just "(calc)"
    if (i + 1 < rawLines.length && /^\s*\(calc\)\s*$/.test(rawLines[i + 1])) {
      line = `${line} (calc)`;
      i++;
    }

    // Join trailing lab code on its own line: " ... \n NL1"
    if (i + 1 < rawLines.length) {
      const next = rawLines[i + 1].trim();
      if (LAB_CODES.has(next)) {
        line = `${line} ${next}`;
        i++;
      }
    }

    out.push(line);
  }
  return out;
}

/** Patient meta extraction. Pulls collection / reported dates and detects
 *  whether this is a Function-distributed Quest report. We deliberately do
 *  NOT extract patient name, DOB, address, phone, IDs. */
function extractPatientMeta(text: string): PatientMeta {
  const labSource: PatientMeta["labSource"] = /Health Gorilla/i.test(text)
    ? "Function"
    : /Quest, Quest Diagnostics|Source:\s*Quest/i.test(text)
      ? "Quest"
      : "Unknown";

  const collected =
    text.match(/^\s*Collected:\s*([\d/\s:APM]+(?:[A-Z]{2,4})?)/m)?.[1]?.trim() ??
    text.match(/^\s*Collection Date:\s*([\d/\s:APM]+(?:[A-Z]{2,4})?)/m)?.[1]?.trim() ??
    null;

  const reported =
    text.match(/^\s*Reported:\s*([\d/\s:APM]+(?:[A-Z]{2,4})?)/m)?.[1]?.trim() ??
    text.match(/^\s*Time Reported:\s*([\d/\s:APM]+(?:[A-Z]{2,4})?)/m)?.[1]?.trim() ??
    null;

  return { collectedDate: collected, reportedDate: reported, labSource };
}

// Function-PDF panel headers have collection metadata appended:
//   "IRON, TIBC AND FERRITIN PANEL Collected: 02/27/2026 12:06 PM UTC Received: ..."
const FUNCTION_PANEL_HEADER_RE =
  /^(.+?)\s+Collected:\s+\d.+?$/i;

/** Does this line LOOK like a panel/section header (all-caps phrase, no value,
 *  possibly trailing lab code)? If so, return the cleaned header text. */
function detectPanelHeader(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Function-style: "PANEL_NAME Collected: ... Received: ..."
  const fnMatch = trimmed.match(FUNCTION_PANEL_HEADER_RE);
  if (fnMatch) {
    const candidate = fnMatch[1].trim();
    // Only treat as panel header if the name part is all-caps-ish prose
    // without a numeric value.
    if (/^[A-Z0-9,()&/.\s-]+$/.test(candidate) && !/^\d/.test(candidate)) {
      return candidate;
    }
  }

  // Already-joined known panels:
  for (const k of KNOWN_PANEL_HEADERS) {
    if (trimmed === k) return k;
    if (trimmed.startsWith(`${k} `) && !looksLikeMarkerRow(trimmed)) return k;
  }

  // Heuristic: all uppercase, no numeric, optional trailing lab code.
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return null;
  const last = tokens[tokens.length - 1];
  const withoutLab = isLabCode(last) ? tokens.slice(0, -1) : tokens;
  if (withoutLab.length === 0) return null;
  // Require ALL tokens to be upper-case-ish AND have no decimal numbers.
  const allCaps = withoutLab.every(
    (t) => /^[A-Z0-9,()&/.-]+$/.test(t) && !/^\d+(\.\d+)?$/.test(t),
  );
  if (!allCaps) return null;
  // Must contain at least one of these panel keywords.
  if (
    /\b(PANEL|PROFILE|CAPACITY|VIRUS|ANTIBODY|METABOLIC|ANTIGEN|FRACTIONATION|HORMONE|DIHYDROXYVITAMIN|OMEGACHECK|EBV|EPSTEIN|VCA|EBNA)\b/.test(
      withoutLab.join(" "),
    )
  ) {
    return withoutLab.join(" ");
  }
  return null;
}

/** Multi-line panel header reconstruction: PDF-parse sometimes splits an
 *  all-caps panel name across two lines because the lab code wraps mid-name.
 *  Examples:
 *    "IRON AND TOTAL IRON NL1" + "BINDING CAPACITY"
 *    "COMPREHENSIVE METABOLIC NL1" + "PANEL"
 *    "EPSTEIN BARR VIRUS NL1" + "ANTIBODY PANEL"
 *
 *  Heuristic: line N ends with a lab code, has no value, and line N+1 is a
 *  short all-caps phrase that completes a panel keyword. Return the joined
 *  panel name (without the lab code).
 */
function tryJoinMultiLinePanel(lineN: string, lineN1: string): string | null {
  const tokensN = tokenize(lineN);
  if (tokensN.length < 2) return null;
  const lastN = tokensN[tokensN.length - 1];
  if (!isLabCode(lastN)) return null;
  // line N should not have a value
  for (const t of tokensN.slice(0, -1)) {
    if (looksLikeValue(t)) return null;
  }
  const tokensN1 = tokenize(lineN1);
  if (tokensN1.length === 0 || tokensN1.length > 4) return null;
  if (!tokensN1.every((t) => /^[A-Z][A-Z0-9,()&/.-]*$/.test(t))) return null;
  // The continuation line must not have a value token (no false-join into a marker row)
  if (tokensN1.some((t) => looksLikeValue(t))) return null;
  return `${tokensN.slice(0, -1).join(" ")} ${tokensN1.join(" ")}`;
}

function looksLikeMarkerRow(line: string): boolean {
  const tokens = tokenize(line);
  if (tokens.length < 2) return false;
  // At least one token in the line is a value-shaped token AND
  // the line is not pure prose. A quick test: does any middle token look like a value?
  for (let i = 1; i < tokens.length; i++) {
    if (looksLikeValue(tokens[i])) return true;
  }
  return false;
}

// ---- Row extraction ------------------------------------------------------

interface RowParse {
  rawName: string;
  value: number | string;
  unit: string | null;
  labFlagFromPdf: "H" | "L" | null;
  referenceRangeRaw: string | null;
}

// Common English connectors that disqualify a marker name. If any of these
// appear as a token in the candidate name, the line is narrative prose, not
// a real marker row.
const NAME_LOWERCASE_REJECT = new Set([
  "to", "of", "the", "a", "an", "with", "from", "by", "as", "for", "or", "and",
  "in", "is", "are", "was", "were", "be", "been", "have", "has", "had",
  "do", "does", "did", "but", "if", "than", "that", "which", "should",
  "may", "can", "must", "this", "these", "those", "such", "where", "when",
  "while", "include", "includes", "including", "between", "among", "without",
]);

// Single-token "names" that are usually narrative fragments, not markers.
const SINGLE_TOKEN_REJECT = new Set([
  "Appendix", "Peak", "Trough", "Range", "Phase", "Reference", "Optimal",
  "Moderate", "High", "Low", "Lower", "Higher", "Average", "Pattern",
  "Risk", "Result", "Comment", "Note", "Notes", "Source", "Test",
]);

/** Does this token look like a numeric reference range value? Used to
 *  distinguish a structured marker row from random prose. */
function looksLikeNumericRefToken(token: string): boolean {
  return (
    /^[\d.]+\s*-\s*[\d.]+$/.test(token) ||         // "65-99"
    /^<[\d.]+$/.test(token) ||                       // "<200"
    /^>[\d.]+$/.test(token) ||                       // ">50"
    /^<=[\d.]+$/.test(token) ||
    /^>=[\d.]+$/.test(token)
  );
}

/** Try to parse a single line as a marker row. Returns null if no clear
 *  marker structure is present. */
function tryParseMarkerRow(line: string): RowParse | null {
  const tokens = tokenize(line);
  if (tokens.length < 2) return null;

  let working = [...tokens];
  let hadLabCode = false;

  // 1. Strip trailing lab code if present
  if (working.length && isLabCode(working[working.length - 1])) {
    working.pop();
    hadLabCode = true;
  }

  // 2. Strip trailing "(calc)" if present (modifier on unit)
  let calc = false;
  if (working.length && working[working.length - 1] === "(calc)") {
    calc = true;
    working.pop();
  }

  // 3. Strip trailing unit (multi-token aware)
  let unit: string | null = null;
  const unitMatch = matchTrailingUnit(working);
  if (unitMatch) {
    unit = unitMatch.unit;
    working = working.slice(0, working.length - unitMatch.consumed);
    if (calc) unit = `${unit} (calc)`;
  } else if (calc) {
    // "(calc)" without a unit just modifies whatever — treat as unit suffix
    unit = "(calc)";
  }

  // 4. Find the FIRST value-shaped token (or categorical) — everything before
  //    it is the marker name.
  let valueIdx = -1;
  for (let i = 0; i < working.length; i++) {
    const t = working[i];
    if (looksLikeValue(t)) {
      valueIdx = i;
      break;
    }
    // Special: "SEE NOTE:" two-token value
    if (t === "SEE" && working[i + 1] === "NOTE:") {
      valueIdx = i;
      break;
    }
    // Single-letter categorical value (e.g., LDL PATTERN B)
    // Only treat as value if we're past at least a 2-token name AND the
    // letter isn't part of a known marker name (e.g., "MS" in TESTOSTERONE).
    if (
      /^[A-Z]$/.test(t) &&
      i >= 2 &&
      // and the prior token isn't a comma-style suffix
      !working[i - 1].endsWith(",")
    ) {
      // Categorical value found
      valueIdx = i;
      break;
    }
  }
  if (valueIdx <= 0) return null;

  const nameTokens = working.slice(0, valueIdx);
  const afterName = working.slice(valueIdx);
  if (!nameTokens.length || !afterName.length) return null;

  // Reject if any name token is a lowercase English connector → this is prose.
  for (const t of nameTokens) {
    if (NAME_LOWERCASE_REJECT.has(t)) return null;
  }
  // Reject only if the FIRST name token starts with a non-letter symbol.
  // Marker names can contain "(BUN)", "(OH)2", "(IgG)" etc. in middle/end tokens.
  if (/^[<>\[,]/.test(nameTokens[0])) return null;
  if (/^\(/.test(nameTokens[0])) return null;

  // Reject single-token marker names that are common narrative fragments.
  if (nameTokens.length === 1 && SINGLE_TOKEN_REJECT.has(nameTokens[0])) return null;

  // 5. Extract value (1 or 2 tokens for "SEE NOTE:")
  let value: number | string;
  let consumedForValue = 1;
  if (afterName[0] === "SEE" && afterName[1] === "NOTE:") {
    value = "SEE NOTE:";
    consumedForValue = 2;
  } else if (afterName[0] === "Pattern" && /^[AB]$/.test(afterName[1] ?? "")) {
    value = `Pattern ${afterName[1]}`;
    consumedForValue = 2;
  } else {
    value = parseValue(afterName[0]);
  }

  // 6. Optional H/L flag
  let labFlag: "H" | "L" | null = null;
  let cursor = consumedForValue;
  if (afterName[cursor] === "H") {
    labFlag = "H";
    cursor += 1;
  } else if (afterName[cursor] === "L") {
    labFlag = "L";
    cursor += 1;
  }

  // 7. Everything remaining is the reference range
  const refTokens = afterName.slice(cursor);
  const refRangeRaw = refTokens.length ? refTokens.join(" ") : null;

  // Structural sanity check: a real marker row should have at least ONE of:
  //   - a known unit
  //   - a stripped lab code at the end
  //   - a recognizable numeric reference-range token
  // Without any of these, the line is probably narrative prose that
  // happened to contain a number.
  const refLooksNumeric = refTokens.some((t) => looksLikeNumericRefToken(t)) ||
    /^[<>]\s*OR\s*=\s*[\d.]/i.test(refTokens.join(" ")) ||
    /^[<>]\s*or\s*=\s*[\d.]/i.test(refTokens.join(" "));
  if (!unit && !hadLabCode && !refLooksNumeric) return null;

  return {
    rawName: nameTokens.join(" "),
    value,
    unit,
    labFlagFromPdf: labFlag,
    referenceRangeRaw: refRangeRaw,
  };
}

// ---- Main parse ----------------------------------------------------------

export async function parseQuestPdf(buffer: Buffer): Promise<ParseResult> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const text = (await parser.getText()).text ?? "";

  const meta = extractPatientMeta(text);

  // Track page numbers via the form-feed character pdf-parse inserts between
  // pages (\f). We split on that first, then by line.
  const pages = text.split(/\f/);
  const allLines: { text: string; pageNumber: number }[] = [];
  pages.forEach((page, idx) => {
    page.split(/\r?\n/).forEach((line) => {
      allLines.push({ text: line, pageNumber: idx + 1 });
    });
  });

  // Preprocess to join PDF-parse artifacts.
  const rawTexts = allLines.map((l) => l.text);
  const processedTexts = preprocess(rawTexts);
  // After preprocessing, the line<->page mapping may shift; rebuild a parallel
  // page index by walking original line indices. Preprocess collapses pairs,
  // so processedTexts.length <= allLines.length. We map back by tracking which
  // original line corresponds to each processed line.
  const processedLines: { text: string; pageNumber: number }[] = [];
  {
    let origIdx = 0;
    for (const txt of processedTexts) {
      // Find matching original line by scanning forward from origIdx
      let usedIdx = origIdx;
      while (
        usedIdx < allLines.length &&
        !txt.startsWith(allLines[usedIdx].text.replace(/\s+$/, ""))
      ) {
        usedIdx += 1;
      }
      const page =
        allLines[Math.min(usedIdx, allLines.length - 1)]?.pageNumber ?? 1;
      processedLines.push({ text: txt, pageNumber: page });
      // Advance origIdx — preprocess might have consumed 1 or 2 original
      // lines per processed line. Best-effort.
      origIdx = Math.max(origIdx + 1, usedIdx + 1);
    }
  }

  const markers: ParsedMarker[] = [];
  const unparsedLines: string[] = [];

  // Track multi-line marker name context (EBV-style: panel header on one
  // line, "AB (IGG)" continuation row on next non-noise line).
  let pendingNameContext: string | null = null;
  // Track "Reference Range" / "Reference Ranges" header: subsequent phase
  // lines append to the last marker.
  let inReferenceRangeBlock = false;
  let inEbvInterpretationBlock = false;

  for (let i = 0; i < processedLines.length; i++) {
    const { text: rawLine, pageNumber } = processedLines[i];
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed) {
      // Blank line ends "Reference Range" blocks.
      inReferenceRangeBlock = false;
      inEbvInterpretationBlock = false;
      continue;
    }

    // --- Skips ---

    if (SKIP_PATTERNS.some((re) => re.test(trimmed))) {
      // Some patterns (e.g. "Reference Range") need to flip context.
      if (/^Reference Range$/i.test(trimmed)) {
        inReferenceRangeBlock = true;
      }
      continue;
    }

    // Skip patient name banner / "X Y Quest Result MM/DD/YYYY"
    if (PATIENT_BANNER_NAME_RE.test(trimmed)) continue;
    if (PATIENT_NAMES_RE.test(trimmed)) continue;

    // EBV interpretation tables
    if (EBV_TABLE_HEAD_RE.test(trimmed) || EBV_TABLE_SEP_RE.test(trimmed)) {
      inEbvInterpretationBlock = true;
      const last = markers[markers.length - 1];
      if (last) {
        last.referenceRangeRaw = last.referenceRangeRaw
          ? `${last.referenceRangeRaw} | ${trimmed}`
          : trimmed;
      }
      continue;
    }
    if (inEbvInterpretationBlock) {
      // Lines like "<9.00 Negative", "9.00-10.99 Equivocal", ">10.99 Positive"
      if (
        /^[<>]\s*[\d.]+\s+(Negative|Equivocal|Positive)/i.test(trimmed) ||
        /^[\d.]+\s*-\s*[\d.]+\s+(Negative|Equivocal|Positive)/i.test(trimmed)
      ) {
        const last = markers[markers.length - 1];
        if (last) {
          last.referenceRangeRaw = last.referenceRangeRaw
            ? `${last.referenceRangeRaw} | ${trimmed}`
            : trimmed;
        }
        continue;
      }
      // End of EBV interpretation block
      inEbvInterpretationBlock = false;
    }

    // Reference Range header → start a phase block
    if (/^Reference Ranges?\s*:?$/i.test(trimmed)) {
      inReferenceRangeBlock = true;
      continue;
    }

    if (inReferenceRangeBlock) {
      if (PHASE_LINE_RE.test(trimmed)) {
        const last = markers[markers.length - 1];
        if (last) {
          last.referenceRangeRaw = last.referenceRangeRaw
            ? `${last.referenceRangeRaw} | ${trimmed}`
            : trimmed;
        }
        continue;
      }
      inReferenceRangeBlock = false;
    }

    // Reference range spill: "Reference range: <100"
    const refSpill = trimmed.match(REF_RANGE_SPILL_RE);
    if (refSpill) {
      const last = markers[markers.length - 1];
      if (last && refSpill[1]) {
        last.referenceRangeRaw = last.referenceRangeRaw
          ? `${last.referenceRangeRaw} | ${refSpill[1].trim()}`
          : refSpill[1].trim();
      }
      continue;
    }

    // Multi-line panel header: lab code wraps from line N into line N+1.
    if (i + 1 < processedLines.length) {
      const joined = tryJoinMultiLinePanel(trimmed, processedLines[i + 1].text.trim());
      if (joined) {
        pendingNameContext = joined;
        i += 1; // consume the continuation line
        continue;
      }
    }

    // Panel headers (single-line)
    const panelName = detectPanelHeader(trimmed);
    if (panelName) {
      pendingNameContext = panelName;
      continue;
    }

    // Try to parse as a marker row
    const parsed = tryParseMarkerRow(trimmed);
    if (parsed) {
      // Stitch EBV-style multi-line names: if pendingNameContext is an EBV
      // panel and the parsed name starts with "AB (", prepend.
      if (
        pendingNameContext &&
        /^EBV |EPSTEIN/.test(pendingNameContext) &&
        /^AB\s*\(/.test(parsed.rawName)
      ) {
        parsed.rawName = `${pendingNameContext} ${parsed.rawName}`;
        pendingNameContext = null;
      } else if (pendingNameContext && /\bSEX HORMONE BINDING\b/.test(pendingNameContext) && /^GLOBULIN\b/.test(parsed.rawName)) {
        parsed.rawName = pendingNameContext;
        pendingNameContext = null;
      } else {
        pendingNameContext = null;
      }

      markers.push({
        ...parsed,
        pageNumber,
        rawLine: trimmed,
      });
      continue;
    }

    // Couldn't parse — log to unparsedLines for review
    unparsedLines.push(trimmed);
  }

  return {
    markers,
    patientMeta: meta,
    unparsedLines,
    parserVersion: PARSER_VERSION,
  };
}
