/**
 * 4-point salivary cortisol — deterministic facts for the Clinical Analysis.
 *
 * Takes the parsed saliva report (lib/parsers/saliva-cortisol) and computes
 * what the model is allowed to narrate: each sample against its reference
 * window, where the morning value sits inside its window, and the shape of
 * the curve (does it fall from morning to night, and by how much). Nothing
 * here is a clinical conclusion; the prompt (lib/analysis/prompt) tells the
 * model how to interpret these facts in the practitioner's style.
 *
 * Thresholds are named constants so they can be tuned in one place. They are
 * curve-shape heuristics, not diagnostic cut-offs.
 */

import {
  CORTISOL_SLOTS,
  SLOT_CLOCK_LABELS,
  formatSalivaWindow,
  type CortisolSlot,
  type SalivaCortisolParse,
  type SalivaCortisolSample,
  type SalivaWindow,
} from "../parsers/saliva-cortisol";

export type CortisolSampleStatus = "in-range" | "above-range" | "below-range";

export interface CortisolSampleFact {
  sampleNo: number;
  slot: CortisolSlot;
  /** "Morning (8-10 AM)" — the chart's Time column. */
  timeLabel: string;
  /** Clock time as printed on the report, or null. Confirmatory only. */
  drawTime: string | null;
  value: number;
  /** "<0.02" style censor, carried so the chart can print it. */
  qualifier: "<" | ">" | null;
  unit: "mcg/dL";
  window: SalivaWindow;
  /** "0.04-0.56 mcg/dL" / "<= 0.21 mcg/dL". */
  rangeText: string;
  status: CortisolSampleStatus;
  /** Morning sample only: where the value sits up the window as a percentage
   *  (0 = at the floor, 100 = at the ceiling; can exceed 100). Null for the
   *  one-sided windows. */
  percentOfRange: number | null;
}

export type CortisolPattern = "declining" | "flat" | "rising" | "incomplete";

export interface CortisolCurveMetrics {
  sampleCount: number;
  morningValue: number | null;
  nightValue: number | null;
  /** Morning minus night, in mcg/dL. Null without both samples. */
  morningToNightDrop: number | null;
  /** The drop as a percentage of the morning value. Null without both samples
   *  or when the morning value is zero. */
  morningToNightDropPercent: number | null;
  /** Every later sample is at or below the one before it. */
  declinesMonotonically: boolean;
  /** Morning value is higher than the night value. */
  declinesMorningToNight: boolean;
  /** The morning-to-night fall is small (see LOW_AMPLITUDE_* constants). */
  lowAmplitude: boolean;
  /** Which sample carried the highest value. */
  peakSlot: CortisolSlot | null;
  pattern: CortisolPattern;
  aboveRangeSlots: CortisolSlot[];
  belowRangeSlots: CortisolSlot[];
  /** Plain-language statements of the computed facts, for the chart footnote
   *  and the model's context. No conclusions. */
  notes: string[];
}

export interface SalivaCortisolFlags {
  samples: CortisolSampleFact[];
  curve: CortisolCurveMetrics;
  /** Whether the windows came from the report's Note 1 or the standard set. */
  windowsSource: "printed" | "standard";
}

/** A morning-to-night fall smaller than this share of the morning value is
 *  called low-amplitude ("flat"). */
export const LOW_AMPLITUDE_DROP_PERCENT = 50;
/** ...or smaller than this absolute fall, in mcg/dL, whatever the share. */
export const LOW_AMPLITUDE_DROP_ABS = 0.05;

export const SLOT_DISPLAY_LABELS: Readonly<Record<CortisolSlot, string>> = {
  morning: `Morning (${SLOT_CLOCK_LABELS.morning})`,
  noon: `Midday (${SLOT_CLOCK_LABELS.noon})`,
  afternoon: `Afternoon (${SLOT_CLOCK_LABELS.afternoon})`,
  night: `Night (${SLOT_CLOCK_LABELS.night})`,
};

/** Sample N -> the Nth window, by order. Samples past 4 are ignored. */
export function slotForSample(sampleNo: number): CortisolSlot | null {
  return CORTISOL_SLOTS[sampleNo - 1] ?? null;
}

function statusAgainst(value: number, w: SalivaWindow): CortisolSampleStatus {
  if (w.max !== null && value > w.max) return "above-range";
  if (w.min !== null && value < w.min) return "below-range";
  return "in-range";
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function sampleFact(s: SalivaCortisolSample, slot: CortisolSlot, w: SalivaWindow): CortisolSampleFact {
  const percentOfRange =
    slot === "morning" && w.min !== null && w.max !== null && w.max > w.min
      ? Math.round(((s.value - w.min) / (w.max - w.min)) * 100)
      : null;
  return {
    sampleNo: s.sampleNo,
    slot,
    timeLabel: SLOT_DISPLAY_LABELS[slot],
    drawTime: s.drawTime,
    value: s.value,
    qualifier: s.qualifier,
    unit: s.unit,
    window: w,
    rangeText: formatSalivaWindow(w, s.unit),
    status: statusAgainst(s.value, w),
    percentOfRange,
  };
}

export function flagSalivaCortisol(parsed: SalivaCortisolParse): SalivaCortisolFlags {
  const samples: CortisolSampleFact[] = [];
  for (const s of parsed.samples) {
    const slot = slotForSample(s.sampleNo);
    if (!slot) continue;
    samples.push(sampleFact(s, slot, parsed.windows[slot]));
  }

  const bySlot = new Map(samples.map((f) => [f.slot, f]));
  const morning = bySlot.get("morning") ?? null;
  const night = bySlot.get("night") ?? null;
  const morningValue = morning?.value ?? null;
  const nightValue = night?.value ?? null;

  const drop = morningValue !== null && nightValue !== null ? morningValue - nightValue : null;
  const dropPercent =
    drop !== null && morningValue !== null && morningValue > 0
      ? Math.round((drop / morningValue) * 100)
      : null;

  let declinesMonotonically = samples.length >= 2;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].value > samples[i - 1].value) declinesMonotonically = false;
  }
  const declinesMorningToNight = drop !== null && drop > 0;
  const lowAmplitude =
    (drop !== null && drop < LOW_AMPLITUDE_DROP_ABS + 1e-9) ||
    (dropPercent !== null && dropPercent < LOW_AMPLITUDE_DROP_PERCENT);

  let peakSlot: CortisolSlot | null = null;
  for (const f of samples) {
    if (peakSlot === null || f.value > bySlot.get(peakSlot)!.value) peakSlot = f.slot;
  }

  let pattern: CortisolPattern;
  if (drop === null) pattern = "incomplete";
  else if (drop < 0) pattern = "rising";
  else if (lowAmplitude) pattern = "flat";
  else pattern = "declining";

  const aboveRangeSlots = samples.filter((f) => f.status === "above-range").map((f) => f.slot);
  const belowRangeSlots = samples.filter((f) => f.status === "below-range").map((f) => f.slot);

  const notes: string[] = [];
  if (samples.length < 4) {
    notes.push(`Only ${samples.length} of the 4 timed samples were readable on the report.`);
  }
  if (morning) {
    const pos = morning.percentOfRange !== null ? `, ${morning.percentOfRange}% of the way up its ${morning.rangeText} window` : "";
    notes.push(`Morning sample ${morning.value} ${morning.unit} is ${morning.status.replace("-", " ")}${pos}.`);
  }
  if (drop !== null && dropPercent !== null) {
    notes.push(
      `Morning-to-night change: ${drop >= 0 ? "fall" : "rise"} of ${round1(Math.abs(drop))} ${morning!.unit} (${Math.abs(dropPercent)}% of the morning value).`,
    );
  }
  if (samples.length >= 2) {
    notes.push(
      declinesMonotonically
        ? "Each later sample is at or below the one before it (the expected downward shape)."
        : "At least one later sample is higher than the one before it (the curve is not a steady decline).",
    );
  }
  if (aboveRangeSlots.length) {
    notes.push(`Above the reference window: ${aboveRangeSlots.map((s) => SLOT_DISPLAY_LABELS[s]).join(", ")}.`);
  }
  if (belowRangeSlots.length) {
    notes.push(`Below the reference window: ${belowRangeSlots.map((s) => SLOT_DISPLAY_LABELS[s]).join(", ")}.`);
  }
  notes.push(
    pattern === "incomplete"
      ? "Curve shape: incomplete (morning or night sample missing)."
      : `Curve shape: ${pattern}${pattern === "flat" ? " (low amplitude: the morning-to-night fall is small)" : ""}.`,
  );
  if (parsed.windowsSource === "standard") {
    notes.push("Reference windows: Note 1 could not be read from the report, so Quest's standard saliva windows were used.");
  }

  return {
    samples,
    curve: {
      sampleCount: samples.length,
      morningValue,
      nightValue,
      morningToNightDrop: drop === null ? null : Math.round(drop * 1000) / 1000,
      morningToNightDropPercent: dropPercent,
      declinesMonotonically,
      declinesMorningToNight,
      lowAmplitude,
      peakSlot,
      pattern,
      aboveRangeSlots,
      belowRangeSlots,
      notes,
    },
    windowsSource: parsed.windowsSource,
  };
}

/** Chart wording for the Status chip: reuses the initial-mode vocabulary so
 *  statusChip() colours it like any other marker. */
export function cortisolStatusWord(status: CortisolSampleStatus): string {
  return status === "above-range" ? "HIGH" : status === "below-range" ? "LOW" : "OPTIMAL";
}

/** "0.32 mcg/dL" / "<0.02 mcg/dL" — the chart's Result column. */
export function formatCortisolResult(f: CortisolSampleFact): string {
  return `${f.qualifier ?? ""}${f.value} ${f.unit}`;
}
