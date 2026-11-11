/**
 * Lab-layout dispatcher: one entry point for every uploaded blood report.
 *
 * detectLabLayout() fingerprints the extracted text; parseLabReport() routes
 * to the matching parser. An unrecognised layout keeps today's behaviour —
 * the Quest parser runs, and the caller's "too few markers" guard surfaces
 * the "format isn't supported yet" notice.
 *
 * Text extraction is the same call the Quest parser makes, so a Quest PDF
 * parsed here yields byte-identical output to parseQuestPdf().
 */

import { PDFParse } from "pdf-parse";
import { parseQuestText } from "./quest";
import { looksLikeLabcorpReport, parseLabcorpText } from "./labcorp";
import type { ParseResult } from "./types";

export type LabLayout = "quest" | "labcorp" | "unknown";

/** Quest direct reports, Quanum (Lab Services Manager) and the Health
 *  Gorilla / Function Health distributions that wrap Quest output. */
const QUEST_FINGERPRINT_RE = /Quest Diagnostics|Health Gorilla|Source:\s*Quest|Quest, Quest/i;

export function detectLabLayout(text: string): LabLayout {
  if (looksLikeLabcorpReport(text)) return "labcorp";
  if (QUEST_FINGERPRINT_RE.test(text)) return "quest";
  return "unknown";
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  return (await parser.getText()).text ?? "";
}

export function parseLabReportText(text: string): ParseResult {
  const layout = detectLabLayout(text);
  if (layout === "labcorp") return parseLabcorpText(text);
  // "quest" and "unknown": the Quest parser, exactly as before.
  return parseQuestText(text);
}

export async function parseLabReport(buffer: Buffer): Promise<ParseResult> {
  return parseLabReportText(await extractPdfText(buffer));
}
