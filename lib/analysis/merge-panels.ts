/**
 * Multi-PDF bloodwork: several lab reports combined into ONE composite current
 * panel for the Clinical Analysis path.
 *
 * Each uploaded file is run through the existing pipeline on its own
 * (parse -> match -> flag -> same-file dedupe) and becomes a BloodPanel whose
 * every marker carries its source { lab, collectedDate, filename }. The panels
 * are then merged:
 *   - a marker that appears in only one file is taken as is;
 *   - a marker that appears in several files is taken from the MOST RECENT
 *     collection date (a file with no readable date counts as the oldest);
 *     results that share that newest date are treated as one draw and go
 *     through the same dedupe as same-file repeats;
 *   - the earlier readings stay attached to the winner (`earlierReadings`)
 *     for display only — tiering, flags and the payload use the current value.
 *
 * A file the parser cannot read, or that yields almost no markers, never fails
 * the run: it becomes a notice (printed in the document, returned to the UI)
 * and the run continues with the files that parsed. That notice is the hook
 * a UCONN / Labcorp parser plugs into later.
 *
 * Nothing here re-flags a marker or touches the flagging engine, the ranges,
 * or the prompt. Source tags are rendered by the Word generator only when the
 * composite spans more than one distinct date or lab, so a single-report run
 * renders exactly as before.
 */

import type { ParseResult, PatientMeta } from "../parsers/types";
import { matchMarkers } from "../matcher";
import { flagMarkers, type FlaggedMarker, type FlaggingSex } from "../flagging";
import { dedupeRepeatedMarkers, isRepeatMarker } from "./dedupe";
import {
  computeCycleDay,
  cycleDayToStatus,
  HORMONE_OVERLAY_MARKERS,
  type HormoneStatus,
} from "./hormone-ranges";
import {
  collectionDate,
  toISODate,
  type EarlierReading,
  type PanelSource,
  type SourcedMarker,
} from "./panel-source";

export type { EarlierReading, PanelSource, SourcedMarker } from "./panel-source";
export {
  collectionDate,
  earlierReadingsOf,
  formatEarlierReadings,
  formatSourcesLine,
  sourceOf,
  sourceTag,
  toISODate,
} from "./panel-source";

export interface BloodPanel {
  source: PanelSource;
  /** Flagged (not yet overlaid) markers from this file, same-file repeats
   *  already collapsed, every one tagged with `source`. */
  markers: SourcedMarker[];
  /** True when the file carries any of the sex-hormone markers the female
   *  overlay knows about — the file whose date anchors the cycle day. */
  hasHormonePanel: boolean;
}

export interface PanelNotice {
  filename: string;
  message: string;
}

export interface CompositePanel {
  markers: FlaggedMarker[];
  /** One entry per file that parsed, in upload order. */
  sources: PanelSource[];
  /** True when the composite spans more than one distinct (lab, date) pair —
   *  the condition under which the chart prints per-row source tags. */
  multiSource: boolean;
  /** Most recent collection date across the files ("MM/DD/YYYY"), or null. */
  collectedDate: string | null;
  /** Reported date of the file that supplied `collectedDate`, or null. */
  reportedDate: string | null;
  /** Collection date of the file carrying the sex-hormone panel, else the
   *  most recent file's: the draw date the LMP cycle-day count runs against. */
  hormoneDrawDate: string | null;
  /** Per-file read failures, in upload order. */
  notices: PanelNotice[];
  /** True when the composite's collection dates span more than one year, so
   *  a compact tag needs the year to be unambiguous. */
  spansYears: boolean;
}

/** Fewer matched markers than this from one file reads as "the layout was
 *  not recognised" rather than a genuinely small panel. */
export const MIN_MARKERS_PER_FILE = 3;

export function unreadableNotice(filename: string): string {
  return `Couldn't read ${filename} — its format isn't supported yet`;
}

/** Sort key: a later date sorts higher; an unknown date is the oldest. */
function dateKey(d: string | null): number {
  const iso = toISODate(d);
  if (!iso) return Number.NEGATIVE_INFINITY;
  return Date.parse(`${iso}T00:00:00Z`);
}

export function labNameOf(meta: Pick<PatientMeta, "labSource">): string {
  // A Function-distributed report is still a Quest report (Health Gorilla
  // wraps Quest output); the practitioner knows it as Quest.
  if (meta.labSource === "Quest" || meta.labSource === "Function") return "Quest";
  return "Unknown lab";
}

export function makePanelSource(
  parsed: Pick<ParseResult, "patientMeta">,
  filename: string,
  index: number,
): PanelSource {
  return {
    index,
    filename,
    lab: labNameOf(parsed.patientMeta),
    collectedDate: collectionDate(parsed.patientMeta.collectedDate),
    collectedRaw: parsed.patientMeta.collectedDate ?? null,
    reportedDate: parsed.patientMeta.reportedDate ?? null,
  };
}

/**
 * One file -> one panel, through the unchanged pipeline (match -> flag ->
 * same-file dedupe), or a notice when the file yielded too few matched
 * markers to be a recognised layout.
 */
export function buildPanel(
  parsed: ParseResult,
  filename: string,
  index: number,
  sex: FlaggingSex | null,
): { panel: BloodPanel; notice: null } | { panel: null; notice: PanelNotice } {
  const source = makePanelSource(parsed, filename, index);
  const matched = matchMarkers(parsed.markers);
  const usable = matched.filter((m) => m.matchStatus === "matched").length;
  if (usable < MIN_MARKERS_PER_FILE) {
    return { panel: null, notice: { filename, message: unreadableNotice(filename) } };
  }
  const flagged = dedupeRepeatedMarkers(flagMarkers(matched, { sex: sex ?? undefined }));
  const markers: SourcedMarker[] = flagged.map((m) => ({
    ...m,
    panelSource: source,
    earlierReadings: [],
  }));
  const hormoneNames = new Set(HORMONE_OVERLAY_MARKERS);
  const hasHormonePanel = markers.some(
    (m) => m.matchStatus === "matched" && hormoneNames.has(m.canonicalName),
  );
  return { panel: { source, markers, hasHormonePanel }, notice: null };
}

// ----- Draw date for the cycle-day count -----

/** Statuses the practitioner picks deliberately; a recomputed cycle day never
 *  overrides one of these (mirrors the form's own rule). */
const NON_CYCLING_STATUSES: ReadonlySet<HormoneStatus> = new Set<HormoneStatus>([
  "postmenopausal",
  "postmenopausal_hrt",
  "birth_control",
]);

export interface DrawCycleInputs {
  /** "YYYY-MM-DD" from the form, or null/empty when not entered. */
  lmpDate: string | null;
  /** A cycle day the practitioner typed outright; it always wins. */
  typedCycleDay: number | null;
  /** The cycle day the form computed against the Patient Date (fallback). */
  clientCycleDay: number | null;
  cycleLength: number;
  status: HormoneStatus;
  /** True when the form's status was derived from its cycle inputs rather
   *  than chosen by hand, so it may follow a recomputed cycle day. */
  statusDerived: boolean;
  /** "YYYY-MM-DD" of the draw the LMP should be counted against: the file
   *  carrying the sex-hormone panel, else the most recent file. */
  drawDateISO: string | null;
}

export interface DrawCycle {
  cycleDay: number | null;
  status: HormoneStatus;
  /** True when the server's count differed from the form's. */
  recomputed: boolean;
}

/**
 * With several uploaded reports there is no single draw date, so the LMP is
 * counted against the hormone file's own collection date here, server side
 * (the form only knows the Patient Date). A typed cycle day, and any
 * deliberately chosen non-cycling status, are left alone.
 */
export function resolveDrawCycle(i: DrawCycleInputs): DrawCycle {
  if (i.typedCycleDay !== null && Number.isFinite(i.typedCycleDay)) {
    return { cycleDay: i.typedCycleDay, status: i.status, recomputed: false };
  }
  const lmp = (i.lmpDate ?? "").trim();
  if (!lmp || !i.drawDateISO) {
    return { cycleDay: i.clientCycleDay, status: i.status, recomputed: false };
  }
  const day = computeCycleDay(lmp, i.drawDateISO);
  if (day === null) return { cycleDay: i.clientCycleDay, status: i.status, recomputed: false };
  const derived =
    i.statusDerived && !NON_CYCLING_STATUSES.has(i.status)
      ? cycleDayToStatus(day, i.cycleLength)
      : null;
  return { cycleDay: day, status: derived ?? i.status, recomputed: day !== i.clientCycleDay };
}

/** Distinct (lab, date) pairs across the sources. */
function distinctSourceKeys(sources: PanelSource[]): Set<string> {
  return new Set(sources.map((s) => `${s.lab}|${s.collectedDate ?? "?"}`));
}

function byNewest(a: PanelSource, b: PanelSource): number {
  return dateKey(b.collectedDate) - dateKey(a.collectedDate) || a.index - b.index;
}

function earlierReading(m: SourcedMarker): EarlierReading {
  return {
    value: m.value,
    unit: m.unit ?? null,
    labFlagFromPdf: m.labFlagFromPdf,
    source: m.panelSource,
  };
}

/**
 * Merge the panels into one composite. See the module comment for the rule.
 * Output order is upload order (file by file), losers removed, so a single
 * panel comes back with its marker list unchanged.
 */
export function mergePanels(panels: BloodPanel[], notices: PanelNotice[] = []): CompositePanel {
  const sources = panels.map((p) => p.source);

  // Group every matched marker by canonical name across files. Unmatched rows
  // have no canonical identity to merge on, and a "(repeat)" row kept by the
  // same-file dedupe stays with its own file's result rather than competing.
  const all: SourcedMarker[] = panels.flatMap((p) => p.markers);
  const groups = new Map<string, number[]>();
  all.forEach((m, i) => {
    if (m.matchStatus !== "matched" || isRepeatMarker(m)) return;
    const list = groups.get(m.canonicalName);
    if (list) list.push(i);
    else groups.set(m.canonicalName, [i]);
  });

  const drop = new Set<number>();
  const replacement = new Map<number, SourcedMarker>();
  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    const newest = Math.max(...indices.map((i) => dateKey(all[i].panelSource.collectedDate)));
    const current = indices.filter((i) => dateKey(all[i].panelSource.collectedDate) === newest);
    const older = indices
      .filter((i) => dateKey(all[i].panelSource.collectedDate) !== newest)
      .sort((a, b) => byNewest(all[a].panelSource, all[b].panelSource) || a - b);

    // Results that share the newest date are one draw: the same preference
    // (unit, printed range, document order) as same-file repeats decides, and
    // a materially different second result survives as a "(repeat)" row.
    const survivors = dedupeRepeatedMarkers(current.map((i) => all[i])) as SourcedMarker[];
    const indexOf = (s: SourcedMarker): number =>
      current.find((i) => all[i] === s) ??
      current.find(
        (i) =>
          all[i].panelSource === s.panelSource &&
          all[i].rawName === s.rawName &&
          all[i].value === s.value,
      ) ??
      current[0];
    const keeper = survivors.find((s) => !isRepeatMarker(s)) ?? survivors[0];
    const keeperIndex = indexOf(keeper);
    const kept = new Map<number, SourcedMarker>(survivors.map((s) => [indexOf(s), s]));
    for (const i of current) {
      if (i === keeperIndex) continue;
      const s = kept.get(i);
      if (s) replacement.set(i, s);
      else drop.add(i);
    }
    for (const i of older) drop.add(i);

    if (older.length) {
      const earlier = older.map((i) => earlierReading(all[i]));
      replacement.set(keeperIndex, {
        ...keeper,
        earlierReadings: [...keeper.earlierReadings, ...earlier],
        flagNotes: [
          ...keeper.flagNotes,
          `most recent of ${indices.length} readings across the uploaded reports; earlier: ${earlier
            .map(
              (e) =>
                `${String(e.value)}${e.unit ? ` ${e.unit}` : ""} (${e.source.lab} ${e.source.collectedDate ?? "date unknown"})`,
            )
            .join(", ")}`,
        ],
      });
    }
  }

  const markers: FlaggedMarker[] = [];
  all.forEach((m, i) => {
    if (drop.has(i)) return;
    markers.push(replacement.get(i) ?? m);
  });

  const dated = sources.filter((s) => s.collectedDate !== null).sort(byNewest);
  const newest = dated[0] ?? null;
  const hormoneFile =
    panels
      .filter((p) => p.hasHormonePanel)
      .map((p) => p.source)
      .sort(byNewest)[0] ?? null;
  const years = new Set(dated.map((s) => s.collectedDate!.slice(-4)));

  return {
    markers,
    sources,
    multiSource: distinctSourceKeys(sources).size > 1,
    collectedDate: newest?.collectedDate ?? null,
    reportedDate: newest?.reportedDate ?? null,
    hormoneDrawDate: hormoneFile?.collectedDate ?? newest?.collectedDate ?? null,
    notices,
    spansYears: years.size > 1,
  };
}
