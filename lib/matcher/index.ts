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
import { parseReferenceRange } from "../flagging/range-parse";
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
  /** H/L flag the lab itself printed next to the value, carried through from
   *  the parser's ParsedMarker so the flagging engine can fall back on it when
   *  the tool has no reference range of its own. */
  labFlagFromPdf: "H" | "L" | null;
  referenceRangeRaw: string;
  optimalRange: { min: number | null; max: number | null; unit: string } | null;
  matchStatus: "matched" | "unmatched" | "ambiguous";
  matchConfidence: "exact" | "normalized" | "fuzzy";
  confirmationPending: boolean;
  confirmationSource: string | null;
  source: "body" | "appendix";
  notes: string[];
  /** ANA titer (e.g. "1:40") — only populated for synthesized ANA rows. */
  titer?: string | null;
  /** ANA pattern (e.g. "Nuclear, Speckled") — only populated for synthesized ANA rows. */
  pattern?: string | null;
  /** Debug flag set by the parser's ANA synthesis step. */
  anaSynthesized?: boolean;
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

// ----- post-match de-dupe -----

/** Canonical records that legitimately carry MULTIPLE distinct rows on one
 *  report, so same-canonical rows must NEVER be collapsed even when their
 *  values happen to coincide.
 *
 *  MTHFR is the live case: C677T and A1298C are clinically different variants
 *  that both resolve to the shared "MTHFR" record (see the TODO on that record
 *  in optimal-ranges.ts). Two variant rows frequently report the SAME genotype
 *  string ("Heterozygous", "Not Detected"), so the same-value rule below is not
 *  enough on its own to protect them — losing one would drop a real result. */
const NEVER_COLLAPSE: ReadonlySet<string> = new Set(["MTHFR"]);

/** Comparison key for a marker value. Numeric values compare numerically
 *  (2.57 === "2.57"), everything else as trimmed, case-folded text. Returns
 *  null for a blank value — blanks never count as "the same value". */
function valueKey(v: number | string): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? `n:${v}` : null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  const n = Number.parseFloat(trimmed);
  if (Number.isFinite(n) && String(n) === trimmed) return `n:${n}`;
  return `s:${trimmed.toLowerCase()}`;
}

/** Units are "compatible" when they agree, or when at least one is blank (the
 *  parser leaves the unit off some wrapped rows). Two rows carrying DIFFERENT
 *  non-blank units are different measurements — never collapse those. */
function unitsCompatible(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return true;
  return x === y;
}

function hasParseableRange(raw: string): boolean {
  if (!raw.trim()) return false;
  const p = parseReferenceRange(raw);
  return p.min !== null || p.max !== null;
}

/** Collapse matched rows that are the same result printed twice.
 *
 *  Why this is needed: the body/appendix collapse in `groupByRawName` is keyed
 *  on rawName, so it only catches a repeat that prints the marker name
 *  IDENTICALLY in both places. Function reports wrap long names, and the body
 *  and appendix keep different halves — "ANTI-MULLERIAN HORMONE (AMH), FEMALE"
 *  in one, "(AMH), FEMALE" in the other. Both resolve to canonical AMH, so the
 *  report rendered the same result as two rows.
 *
 *  The collapse is deliberately narrow: same canonicalName AND same value AND
 *  compatible units. Same-canonical rows with DIFFERENT values are always kept
 *  — they are distinct results, not a duplicate (MTHFR C677T vs A1298C), and
 *  NEVER_COLLAPSE additionally protects records whose rows stay distinct even
 *  at equal values. */
function dedupeMatched(rows: MatchedMarker[]): MatchedMarker[] {
  const out: MatchedMarker[] = [];
  // key → index into `out` of the row we're keeping for that key.
  const keptIndexByKey = new Map<string, number>();

  for (const row of rows) {
    const vKey = row.matchStatus === "matched" ? valueKey(row.value) : null;
    if (vKey === null || NEVER_COLLAPSE.has(row.canonicalName)) {
      out.push(row);
      continue;
    }
    const key = `${row.canonicalName} ${vKey}`;
    const priorIndex = keptIndexByKey.get(key);
    if (priorIndex === undefined) {
      keptIndexByKey.set(key, out.length);
      out.push(row);
      continue;
    }

    const prior = out[priorIndex];
    if (!unitsCompatible(prior.unit, row.unit)) {
      out.push(row);
      continue;
    }

    // Duplicate confirmed. Keep whichever row came from the body; on a tie the
    // earlier row wins (body sections precede the appendix in every report).
    const keepPrior = prior.source === "body" || row.source !== "body";
    const winner = keepPrior ? prior : row;
    const loser = keepPrior ? row : prior;

    // Backfill anything the winner is missing but the loser has: a usable
    // printed range, a unit, and — safety-critical — the lab's own H/L flag.
    const referenceRangeRaw =
      hasParseableRange(winner.referenceRangeRaw) || !hasParseableRange(loser.referenceRangeRaw)
        ? winner.referenceRangeRaw
        : loser.referenceRangeRaw;

    out[priorIndex] = {
      ...winner,
      unit: winner.unit.trim() ? winner.unit : loser.unit,
      referenceRangeRaw,
      labFlagFromPdf: winner.labFlagFromPdf ?? loser.labFlagFromPdf,
      notes: [
        ...winner.notes,
        ...loser.notes.filter((n) => !winner.notes.includes(n)),
        `duplicate row collapsed: same canonical marker and value also printed as "${loser.rawName}" (${loser.source})`,
      ],
    };
  }

  return out;
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
      labFlagFromPdf: primary.labFlagFromPdf,
      referenceRangeRaw,
      source,
      notes,
      // Carry ANA sub-row fields through if the parser synthesized them.
      ...(primary.titer !== undefined ? { titer: primary.titer } : {}),
      ...(primary.pattern !== undefined ? { pattern: primary.pattern } : {}),
      ...(primary.anaSynthesized ? { anaSynthesized: true } : {}),
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

    // Pending = legacy requiresConfirmation flag still set AND no source
    // populated. Post-2026-05-27 refactor, none of the bundled markers hit
    // this branch — it's a safety net for future additions.
    const confirmationPending =
      winner.rec.requiresConfirmation === true && !winner.rec.confirmationSource;

    out.push({
      ...base,
      canonicalName: winner.rec.canonicalName,
      optimalRange: buildOptimalRange(winner.rec),
      matchStatus: "matched",
      matchConfidence: winner.confidence,
      confirmationPending,
      confirmationSource: winner.rec.confirmationSource ?? null,
      notes,
    });
  }

  return dedupeMatched(out);
}
