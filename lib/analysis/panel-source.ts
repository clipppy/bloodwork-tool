/**
 * Provenance of a marker in a multi-PDF composite panel: the types, the
 * annotation readers, and the small display formatters. Dependency-free so
 * both the deterministic layer and the merge step can import it without a
 * cycle (merge-panels -> dedupe -> deterministic -> here).
 *
 * Lab name and collection date are clinical context, not identifiers; they
 * are rendered in the document and never reach the API payload.
 */

import type { FlaggedMarker } from "../flagging";

/** Where a marker's value came from. */
export interface PanelSource {
  /** Upload order, 0-based. Breaks ties deterministically. */
  index: number;
  filename: string;
  /** "Quest", or "Unknown lab" when the layout was not recognised. */
  lab: string;
  /** "MM/DD/YYYY", or null when the file printed no readable collection date. */
  collectedDate: string | null;
  /** The collection stamp exactly as the parser read it (may carry a time). */
  collectedRaw: string | null;
  reportedDate: string | null;
}

/** An older result for the same marker from another file, kept for display. */
export interface EarlierReading {
  value: number | string;
  unit: string | null;
  labFlagFromPdf: "H" | "L" | null;
  source: PanelSource;
}

/** A flagged marker with its provenance. The analysis layer reads
 *  `panelSource` the way it reads `hormoneOverlay` / `repeatOf`: an optional
 *  annotation the flagging engine itself knows nothing about. */
export interface SourcedMarker extends FlaggedMarker {
  panelSource: PanelSource;
  earlierReadings: EarlierReading[];
}

export function sourceOf(m: FlaggedMarker): PanelSource | null {
  const s = (m as Partial<SourcedMarker>).panelSource;
  return s && typeof s.filename === "string" ? s : null;
}

export function earlierReadingsOf(m: FlaggedMarker): EarlierReading[] {
  const e = (m as Partial<SourcedMarker>).earlierReadings;
  return Array.isArray(e) ? e : [];
}

/** "MM/DD/YYYY" from the parser's collection stamp ("02/27/2026 / 07:06 EST",
 *  "08/26/2026 08:04"), or null. */
export function collectionDate(raw: string | null | undefined): string | null {
  const m = (raw ?? "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : null;
}

/** "YYYY-MM-DD" for date arithmetic (computeCycleDay), or null. */
export function toISODate(mmddyyyy: string | null | undefined): string | null {
  const m = (mmddyyyy ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/** Compact per-row tag: "Quest · 08/26" (the year is added only when the
 *  composite spans more than one year). "Quest · date unknown" when the file
 *  printed no collection date. */
export function sourceTag(source: PanelSource, withYear = false): string {
  const d = source.collectedDate;
  if (!d) return `${source.lab} · date unknown`;
  return `${source.lab} · ${withYear ? d : d.slice(0, 5)}`;
}

/** Header line listing every file: "Quest 06/14/2026 · UCONN 06/02/2026".
 *  Files that share a lab and date collapse to one entry with a count. */
export function formatSourcesLine(sources: PanelSource[]): string {
  const seen = new Map<string, { label: string; count: number }>();
  for (const s of sources) {
    const label = `${s.lab} ${s.collectedDate ?? "(date unknown)"}`;
    const hit = seen.get(label);
    if (hit) hit.count += 1;
    else seen.set(label, { label, count: 1 });
  }
  return [...seen.values()]
    .map((e) => (e.count > 1 ? `${e.label} (${e.count} reports)` : e.label))
    .join(" · ");
}

/** "earlier 4.1 g/dL · Quest 06/02" for the chart's secondary note. */
export function formatEarlierReadings(readings: EarlierReading[], withYear = false): string | null {
  if (!readings.length) return null;
  return readings
    .map((r) => {
      const v = `${String(r.value)}${r.unit ? ` ${r.unit}` : ""}${r.labFlagFromPdf ? ` ${r.labFlagFromPdf}` : ""}`;
      return `earlier ${v} · ${sourceTag(r.source, withYear)}`;
    })
    .join("; ");
}
