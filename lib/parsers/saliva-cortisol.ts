/**
 * Quest 4-point salivary cortisol PDF parser — CLINICAL ANALYSIS PATH ONLY.
 *
 * The saliva cortisol report is a separate Quest PDF from the blood panel:
 *
 *   CORTISOL, LC/MS, SALIVA, 4 SAMPLES
 *   CORTISOL, LC/MS, SALIVA, SAMPLE 1
 *   DRAW DATE 1            04/10/2026
 *   DRAW TIME 1            8:18AM
 *   CORTISOL, SALIVA SAMPLE 1   0.32 mcg/dL   See Note 1
 *   ... (samples 2-4) ...
 *   Note 1
 *   8-10 AM:     0.04-0.56 mcg/dL
 *   noon-2 PM:   < or = 0.21 mcg/dL
 *   4-6 PM:      < or = 0.15 mcg/dL
 *   10 PM-1 AM:  < or = 0.09 mcg/dL
 *
 * Sample N maps to the Nth reference window by ORDER (1 morning, 2 noon,
 * 3 afternoon, 4 night). The draw time is carried along as confirmatory
 * context only; a 9:20 PM fourth sample still uses the 10 PM-1 AM window.
 *
 * No-PHI discipline: this module returns values, clock times, reference
 * windows and the collection date (used locally for the report header, never
 * sent). It never returns the raw text, and it never looks for a name, DOB,
 * specimen ID or any other identifier. The blood parser (lib/parsers/quest)
 * is not touched or reused beyond the same pdf-parse text extraction.
 */

import { PDFParse } from "pdf-parse";

export type CortisolSlot = "morning" | "noon" | "afternoon" | "night";

export const CORTISOL_SLOTS: readonly CortisolSlot[] = ["morning", "noon", "afternoon", "night"];

export interface SalivaWindow {
  min: number | null;
  max: number | null;
}

export type SalivaCortisolWindows = Record<CortisolSlot, SalivaWindow>;

export interface SalivaCortisolSample {
  /** 1-4, as printed. Position decides the reference window. */
  sampleNo: number;
  /** Clock time as printed, normalised to "8:18 AM"; null when not printed. */
  drawTime: string | null;
  value: number;
  /** "<" when the lab printed a censored value such as "<0.02". */
  qualifier: "<" | ">" | null;
  unit: "mcg/dL";
}

export interface SalivaCortisolParse {
  samples: SalivaCortisolSample[];
  windows: SalivaCortisolWindows;
  /** "printed" when all four Note 1 windows were read from the PDF; otherwise
   *  the standard Quest windows were substituted. */
  windowsSource: "printed" | "standard";
  /** "MM/DD/YYYY" of the first sample's draw date (else the report's
   *  Collected line). Header use only; never part of the API payload. */
  collectedDate: string | null;
}

/** Quest's published saliva cortisol windows (LC/MS), the fallback when the
 *  Note 1 block cannot be read. */
export const STANDARD_SALIVA_WINDOWS: Readonly<SalivaCortisolWindows> = {
  morning: { min: 0.04, max: 0.56 },
  noon: { min: null, max: 0.21 },
  afternoon: { min: null, max: 0.15 },
  night: { min: null, max: 0.09 },
};

/** Clock windows the four samples are meant to cover, in slot order. */
export const SLOT_CLOCK_LABELS: Readonly<Record<CortisolSlot, string>> = {
  morning: "8-10 AM",
  noon: "noon-2 PM",
  afternoon: "4-6 PM",
  night: "10 PM-1 AM",
};

export async function parseSalivaCortisolPdf(buffer: Buffer): Promise<SalivaCortisolParse | null> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const text = (await parser.getText()).text ?? "";
  return parseSalivaCortisolText(text);
}

/** Is this text a Quest saliva cortisol report at all? */
export function looksLikeSalivaCortisol(text: string): boolean {
  return /CORTISOL\s*,?\s*(?:LC\/?MS\s*,?\s*)?SALIVA/i.test(text);
}

/**
 * The whole parse from extracted text, split out so the fixture test can pin
 * the line rules without shipping a PDF. Returns null when the text is not a
 * saliva cortisol report or carries no readable sample.
 */
export function parseSalivaCortisolText(text: string): SalivaCortisolParse | null {
  if (!looksLikeSalivaCortisol(text)) return null;
  const flat = text.replace(/\r/g, "");

  const samples = extractSamples(flat);
  if (samples.length === 0) return null;

  const printed = extractNoteWindows(flat);
  const windows = printed ?? { ...STANDARD_SALIVA_WINDOWS };

  return {
    samples,
    windows,
    windowsSource: printed ? "printed" : "standard",
    collectedDate: extractCollectedDate(flat),
  };
}

// ----- Samples -----

const SAMPLE_ROW_RE =
  /CORTISOL\s*,\s*SALIVA\s+SAMPLE\s*([1-4])\s*[:\s]\s*([<>]?)\s*(\d+(?:\.\d+)?)\s*(?:H|L)?\s*(mcg\/dL|ug\/dL|µg\/dL|μg\/dL)?/gi;

// "8:18AM", "12:45 P.M.", or a bare 24-hour "0818" / "1705".
const DRAW_TIME_RE =
  /DRAW\s*TIME\s*([1-4])\s*:?\s*(\d{3,4}|\d{1,2})(?::(\d{2}))?\s*(AM|PM|A\.M\.|P\.M\.)?/gi;

function extractSamples(text: string): SalivaCortisolSample[] {
  const times = new Map<number, string>();
  let m: RegExpExecArray | null;
  DRAW_TIME_RE.lastIndex = 0;
  while ((m = DRAW_TIME_RE.exec(text)) !== null) {
    const no = Number(m[1]);
    if (times.has(no)) continue;
    const t = normaliseClock(m[2], m[3], m[4]);
    if (t) times.set(no, t);
  }

  const seen = new Map<number, SalivaCortisolSample>();
  SAMPLE_ROW_RE.lastIndex = 0;
  while ((m = SAMPLE_ROW_RE.exec(text)) !== null) {
    const no = Number(m[1]);
    if (seen.has(no)) continue;
    const value = Number.parseFloat(m[3]);
    if (!Number.isFinite(value)) continue;
    seen.set(no, {
      sampleNo: no,
      drawTime: times.get(no) ?? null,
      value,
      qualifier: m[2] === "<" ? "<" : m[2] === ">" ? ">" : null,
      unit: "mcg/dL",
    });
  }
  return [...seen.values()].sort((a, b) => a.sampleNo - b.sampleNo);
}

/** "8", "18", "AM" -> "8:18 AM"; "0818" (no colon, no AM/PM) -> "8:18 AM" by
 *  24-hour reading; null when the digits make no sense. */
function normaliseClock(h: string, mm: string | undefined, ampm: string | undefined): string | null {
  let hour = Number(h);
  let minute = mm === undefined ? 0 : Number(mm);
  if (mm === undefined && h.length === 4) {
    hour = Number(h.slice(0, 2));
    minute = Number(h.slice(2));
  } else if (mm === undefined && h.length === 3) {
    hour = Number(h.slice(0, 1));
    minute = Number(h.slice(1));
  }
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null;
  const mer = ampm ? ampm.replace(/\./g, "").toUpperCase() : null;
  if (mer) {
    if (hour < 1 || hour > 12) return null;
    return `${hour}:${String(minute).padStart(2, "0")} ${mer}`;
  }
  if (hour > 23) return null;
  const suffix = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

// ----- Note 1 windows -----

const WINDOW_LABEL_RES: Readonly<Record<CortisolSlot, RegExp>> = {
  morning: /\b8\s*(?:-|to|–)\s*10\s*A\.?M\.?\s*:?/i,
  noon: /\b(?:noon|12\s*(?:P\.?M\.?|noon)?)\s*(?:-|to|–)\s*2\s*P\.?M\.?\s*:?/i,
  afternoon: /\b4\s*(?:-|to|–)\s*6\s*P\.?M\.?\s*:?/i,
  night: /\b10\s*P\.?M\.?\s*(?:-|to|–)\s*1\s*A\.?M\.?\s*:?/i,
};

/** Reads all four windows from the Note 1 block. Null unless every window
 *  parsed, so a half-read note never mixes printed and assumed bounds. */
export function extractNoteWindows(text: string): SalivaCortisolWindows | null {
  const out: Partial<SalivaCortisolWindows> = {};
  for (const slot of CORTISOL_SLOTS) {
    const label = WINDOW_LABEL_RES[slot].exec(text);
    if (!label) return null;
    // The range text runs from the label to the unit (or end of line).
    const after = text.slice(label.index + label[0].length);
    const stop = after.search(/mcg\/dL|ug\/dL|µg\/dL|μg\/dL|\n/i);
    const rangeText = (stop >= 0 ? after.slice(0, stop) : after).trim();
    const w = parseWindowText(rangeText);
    if (!w) return null;
    out[slot] = w;
  }
  return out as SalivaCortisolWindows;
}

/** "0.04-0.56" | "<= 0.21" | "< or = 0.21" | "≤0.21" | "<0.21" | ">= 0.04". */
export function parseWindowText(raw: string): SalivaWindow | null {
  const s = raw.replace(/\s+/g, " ").trim();
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)$/);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  m = s.match(/^(?:<\s*or\s*=|<=|≤|<)\s*(\d+(?:\.\d+)?)$/i);
  if (m) return { min: null, max: Number(m[1]) };
  m = s.match(/^(?:>\s*or\s*=|>=|≥|>)\s*(\d+(?:\.\d+)?)$/i);
  if (m) return { min: Number(m[1]), max: null };
  return null;
}

// ----- Collection date (local header use only) -----

function extractCollectedDate(text: string): string | null {
  const draw = text.match(/DRAW\s*DATE\s*1\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (draw) return draw[1];
  const collected = text.match(/^\s*Collected:\s*(\d{2}\/\d{2}\/\d{4})/m);
  return collected ? collected[1] : null;
}

/** "0.04-0.56 mcg/dL" / "<= 0.21 mcg/dL" — the window as the report prints it. */
export function formatSalivaWindow(w: SalivaWindow, unit = "mcg/dL"): string {
  if (w.min !== null && w.max !== null) return `${w.min}-${w.max} ${unit}`;
  if (w.max !== null) return `<= ${w.max} ${unit}`;
  if (w.min !== null) return `>= ${w.min} ${unit}`;
  return "not printed";
}
