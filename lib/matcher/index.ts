/**
 * Matcher: parser output → optimal-ranges.ts canonical records.
 *
 * Does NOT compute flags or severity — that's the (still-unbuilt) flagging
 * engine. Does NOT mutate optimal-ranges.ts.
 *
 * Source tagging note: the parser doesn't currently emit a body|appendix
 * tag on each ParsedMarker. The matcher infers it from order: within a
 * single PDF's marker array, the first occurrence of a given rawName is
 * 'body' (body sections precede the appendix in every Function PDF), any
 * subsequent occurrence is 'appendix'. Divergent-value pairs are merged
 * back into one matched row per the spec.
 */

import type { ParsedMarker } from "../parsers/types";
import { OPTIMAL_RANGES, findMarker, type MarkerRange } from "../ranges/optimal-ranges";
import {
  fuzzyThreshold,
  levenshtein,
  normalizeLdlPatternArtifact,
  normalizeName,
  stripTrailingParen,
  stripTrailingQualifiers,
} from "./normalize";

export interface MatchedMarker {
  rawName: string;
  canonicalName: string;
  value: number | string;
  unit: string;
  referenceRangeRaw: string;
  optimalRange: { min: number | null; max: number | null; unit: string } | null;
  matchStatus: "matched" | "unmatched" | "ambiguous";
  matchConfidence: "exact" | "normalized" | "fuzzy";
  confirmationPending: boolean;
  confirmationSource: string | null;
  source: "body" | "appendix";
  notes: string[];
}

// Build a flat alias index once per module load. Each entry maps a
// lowercased alias (or canonicalName) to its MarkerRange.
const ALIAS_TABLE: Array<{ alias: string; normalized: string; rec: MarkerRange }> =
  (() => {
    const out: Array<{ alias: string; normalized: string; rec: MarkerRange }> = [];
    for (const rec of Object.values(OPTIMAL_RANGES)) {
      const names = [rec.canonicalName, ...rec.aliases];
      for (const n of names) {
        out.push({ alias: n, normalized: normalizeName(n), rec });
      }
    }
    return out;
  })();

interface MatchAttempt {
  rec: MarkerRange;
  confidence: "exact" | "normalized" | "fuzzy";
  editDistance?: number;
  matchedAlias: string;
}

/** Try the parsed alias dictionary (`findMarker`) for an exact alias hit,
 *  then a normalized hit, then fall back to fuzzy. Returns an array of
 *  candidates so the caller can detect ambiguity.
 *
 *  `rejectedShortFuzzy` carries any short-name fuzzy candidates that the
 *  guard refused — the caller writes them to notes[] so they're visible
 *  in the validation report without being treated as a real match. */
function resolveCandidates(rawName: string): {
  candidates: MatchAttempt[];
  triedFuzzy: boolean;
  rejectedShortFuzzy?: MatchAttempt[];
} {
  // 1. Exact alias match via the existing index (case-insensitive on the
  //    raw alias text — no other normalization).
  const exactRec = findMarker(rawName);
  if (exactRec) {
    return {
      candidates: [
        { rec: exactRec, confidence: "exact", matchedAlias: rawName },
      ],
      triedFuzzy: false,
    };
  }

  const normalized = normalizeName(rawName);

  // 2. Normalized exact match: try the normalized rawName + the
  //    paren-stripped + qualifier-stripped variants against every alias's
  //    normalized form. Qualifier strip handles "CORTISOL, TOTAL, LC/MS"
  //    → "cortisol", "IRON, TOTAL" → "iron", "VITAMIN D,25-OH,TOTAL,IA" →
  //    "vitamin d 25-oh".
  const stripped = normalizeName(stripTrailingParen(rawName));
  const qualifierStripped = normalizeName(stripTrailingQualifiers(rawName));
  const normalizedHits: MatchAttempt[] = [];
  for (const entry of ALIAS_TABLE) {
    if (
      entry.normalized === normalized ||
      entry.normalized === stripped ||
      entry.normalized === qualifierStripped
    ) {
      normalizedHits.push({
        rec: entry.rec,
        confidence: "normalized",
        matchedAlias: entry.alias,
      });
    }
  }
  // Dedupe by rec (one record can have multiple aliases collapsing to the
  // same normalized form).
  const dedupedNormalized = uniqByRec(normalizedHits);
  if (dedupedNormalized.length > 0) {
    return { candidates: dedupedNormalized, triedFuzzy: false };
  }

  // 3. Fuzzy match — find every alias within the edit-distance threshold,
  //    keep only the minimum-distance candidates.
  //
  //    Short-name guard: when the parsed name is ≤4 normalized chars
  //    (typical acronyms like FSH / LH / TSH / LDH / EGFR), a 1-edit
  //    threshold collapses unrelated markers (FSH ↔ TSH, LH ↔ LD). Skip
  //    fuzzy in that case — better to surface as unmatched than to
  //    silently coalesce. The skipped candidates are still recorded in
  //    `rejectedFuzzy` so the caller can mention them in notes[].
  const threshold = fuzzyThreshold(normalized.length);
  if (normalized.length <= 4) {
    const tooShort: MatchAttempt[] = [];
    for (const entry of ALIAS_TABLE) {
      const d = levenshtein(normalized, entry.normalized);
      if (d <= threshold && entry.normalized.length <= 4) {
        tooShort.push({
          rec: entry.rec,
          confidence: "fuzzy",
          editDistance: d,
          matchedAlias: entry.alias,
        });
      }
    }
    return {
      candidates: [],
      triedFuzzy: true,
      rejectedShortFuzzy: uniqByRec(tooShort),
    };
  }

  let bestDistance = Infinity;
  const fuzzyHits: MatchAttempt[] = [];
  for (const entry of ALIAS_TABLE) {
    const d = levenshtein(normalized, entry.normalized);
    if (d <= threshold && d < bestDistance) {
      bestDistance = d;
      fuzzyHits.length = 0;
      fuzzyHits.push({
        rec: entry.rec,
        confidence: "fuzzy",
        editDistance: d,
        matchedAlias: entry.alias,
      });
    } else if (d === bestDistance) {
      fuzzyHits.push({
        rec: entry.rec,
        confidence: "fuzzy",
        editDistance: d,
        matchedAlias: entry.alias,
      });
    }
  }
  return { candidates: uniqByRec(fuzzyHits), triedFuzzy: true };
}

function uniqByRec(attempts: MatchAttempt[]): MatchAttempt[] {
  const seen = new Set<MarkerRange>();
  const out: MatchAttempt[] = [];
  for (const a of attempts) {
    if (seen.has(a.rec)) continue;
    seen.add(a.rec);
    out.push(a);
  }
  return out;
}

/** Group parser markers by rawName so we can detect divergent-value pairs
 *  and tag source by occurrence order. */
function groupByRawName(markers: ParsedMarker[]): Map<string, ParsedMarker[]> {
  const groups = new Map<string, ParsedMarker[]>();
  for (const m of markers) {
    const arr = groups.get(m.rawName) ?? [];
    arr.push(m);
    groups.set(m.rawName, arr);
  }
  return groups;
}

function collapseGroup(group: ParsedMarker[]): {
  primary: ParsedMarker;
  source: "body" | "appendix";
  notes: string[];
} {
  const notes: string[] = [];
  if (group.length === 1) {
    return { primary: group[0], source: "body", notes };
  }
  // Divergent pair (or larger group): keep body's value, appendix's range.
  // The parser dedup already removed exact-tuple duplicates, so anything
  // surviving with >1 occurrence has at least one differing field.
  const body = group[0];
  const appendix = group[group.length - 1];
  const merged: ParsedMarker = {
    ...body,
    referenceRangeRaw: appendix.referenceRangeRaw,
  };
  if (body.referenceRangeRaw !== appendix.referenceRangeRaw) {
    notes.push("appendix range preferred over body for cosmetic difference");
  }
  if (body.value !== appendix.value || body.unit !== appendix.unit) {
    notes.push(
      `divergent value/unit between body (${String(body.value)} ${body.unit ?? ""}) and appendix (${String(appendix.value)} ${appendix.unit ?? ""}); kept body`,
    );
  }
  return { primary: merged, source: "body", notes };
}

function buildOptimalRange(
  rec: MarkerRange,
): MatchedMarker["optimalRange"] {
  const min = rec.optimalRange?.min ?? null;
  const max = rec.optimalRange?.max ?? null;
  if (min === null && max === null) return null;
  return { min, max, unit: rec.unit };
}

export function matchMarkers(markers: ParsedMarker[]): MatchedMarker[] {
  const out: MatchedMarker[] = [];
  const groups = groupByRawName(markers);

  for (const group of Array.from(groups.values())) {
    const { primary, source, notes: collapseNotes } = collapseGroup(group);
    const notes = [...collapseNotes];

    // LDL Pattern range artifact ("A A" → "A").
    let referenceRangeRaw = primary.referenceRangeRaw ?? "";
    if (primary.rawName.toUpperCase() === "LDL PATTERN") {
      const { cleaned, changed } = normalizeLdlPatternArtifact(referenceRangeRaw);
      if (changed) {
        notes.push(`LDL Pattern range column artifact: "${referenceRangeRaw}" → "${cleaned}"`);
        referenceRangeRaw = cleaned;
      }
    }

    const { candidates, triedFuzzy, rejectedShortFuzzy } = resolveCandidates(
      primary.rawName,
    );
    if (rejectedShortFuzzy && rejectedShortFuzzy.length > 0) {
      for (const r of rejectedShortFuzzy) {
        notes.push(
          `rejected short-name fuzzy candidate: "${primary.rawName}" → alias "${r.matchedAlias}" of "${r.rec.canonicalName}" (edit distance ${r.editDistance}) — both names too short for reliable Levenshtein match`,
        );
      }
    }

    const base: Omit<MatchedMarker, "canonicalName" | "optimalRange" | "matchStatus" | "matchConfidence" | "confirmationPending" | "confirmationSource"> = {
      rawName: primary.rawName,
      value: primary.value,
      unit: primary.unit ?? "",
      referenceRangeRaw,
      source,
      notes,
    };

    if (candidates.length === 0) {
      out.push({
        ...base,
        canonicalName: "",
        optimalRange: null,
        matchStatus: "unmatched",
        matchConfidence: triedFuzzy ? "fuzzy" : "exact",
        confirmationPending: false,
        confirmationSource: null,
      });
      continue;
    }

    if (candidates.length > 1) {
      const names = candidates.map((c) => c.rec.canonicalName).join(" | ");
      out.push({
        ...base,
        canonicalName: "",
        optimalRange: null,
        matchStatus: "ambiguous",
        matchConfidence: candidates[0].confidence,
        confirmationPending: false,
        confirmationSource: null,
        notes: [...notes, `ambiguous: matched ${candidates.length} canonical records → ${names}`],
      });
      continue;
    }

    const winner = candidates[0];
    if (winner.confidence === "fuzzy") {
      notes.push(
        `fuzzy match (edit distance ${winner.editDistance}): "${primary.rawName}" → alias "${winner.matchedAlias}" of "${winner.rec.canonicalName}"`,
      );
    } else if (winner.confidence === "normalized") {
      notes.push(
        `normalized match: "${primary.rawName}" → alias "${winner.matchedAlias}" of "${winner.rec.canonicalName}"`,
      );
    }

    const requiresConfirmation = winner.rec.requiresConfirmation === true;

    out.push({
      ...base,
      canonicalName: winner.rec.canonicalName,
      optimalRange: buildOptimalRange(winner.rec),
      matchStatus: "matched",
      matchConfidence: winner.confidence,
      confirmationPending: requiresConfirmation,
      // Per spec: confirmationSource stays null until Melissa confirms,
      // even though the optimal-ranges record has a citation-pending note.
      confirmationSource: null,
      notes,
    });
  }

  return out;
}
