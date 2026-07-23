/**
 * parseReferenceRange: turn a lab's PRINTED reference-range string into a
 * numeric { min, max } pair the flagging engine can compare against.
 *
 * The printed range varies by lab (and sometimes by patient), so it can't be
 * hardcoded. This parser reads it off the report. It is intentionally strict:
 * the WHOLE (unit-stripped) string must be a single range or comparator
 * expression. Prose, tables, and multi-range strings (cortisol's "8 a.m. …",
 * leptin's sex/BMI table) return { null, null } so the caller falls back to
 * the hardcoded range instead of trusting a number lifted out of prose.
 *
 * Pure and side-effect free — unit-tested in range-parse.test.ts.
 */

export interface ParsedRange {
  min: number | null;
  max: number | null;
}

const NONE: ParsedRange = { min: null, max: null };

/** A number token: integer or decimal (e.g. "22", "0.8", "5.0", "180"). */
const NUM = "\\d+(?:\\.\\d+)?";

const RANGE_RE = new RegExp(`^(${NUM})-(${NUM})$`);
const LESS_RE = new RegExp(`^(<=?)(${NUM})$`); // "<14" | "<=2"
const GREATER_RE = new RegExp(`^(>=?)(${NUM})$`); // ">40" | ">=40"

/** Normalize a raw reference-range string to the canonical, whitespace-free
 *  form the anchored patterns match: drop "(calc)", fold comparator glyphs /
 *  worded forms to <= / >=, unify dashes, strip a trailing unit, remove spaces.
 *  Returns "" when nothing usable remains. Shared by parseReferenceRange (which
 *  reads the numeric bounds) and formatPrintedRange (which keeps the original
 *  digit substrings for display). */
function normalizeRangeString(raw: string): string {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (!s) return "";

  // Drop a trailing "(calc)" / "(calc.)" annotation.
  s = s.replace(/\(calc\.?\)/gi, " ").trim();

  // Normalize comparator glyphs and worded forms to <= / >=.
  //   ≥ ≤            → >= <=
  //   "> or ="       → ">="   (case-insensitive on the "or")
  //   "< =" (spaced) → "<="
  s = s.replace(/≥/g, ">=").replace(/≤/g, "<=");
  s = s.replace(/([<>])\s*or\s*=/gi, "$1=");
  s = s.replace(/([<>])\s*=/g, "$1=");

  // Normalize dash variants used in ranges.
  s = s.replace(/[‒–—―]/g, "-");

  // Strip a single trailing unit token (must follow whitespace and start with
  // a letter/%/µ so it can't eat part of a number): "50-180 mcg/dL" → "50-180".
  s = s.replace(/\s+[a-zµμ%][^\s]*$/i, "").trim();

  // Collapse all remaining internal whitespace so "< = 2" → "<=2", "22 - 77"
  // → "22-77". Any prose with embedded numbers still won't match the anchored
  // patterns below.
  return s.replace(/\s+/g, "");
}

/** Parse a SINGLE segment (the strict, anchored core). Returns the numeric
 *  bounds, or null when the whole normalized segment is not one range /
 *  comparator expression. This is the original parseReferenceRange behaviour,
 *  factored out so the multi-segment recovery below can reuse it. */
function matchSingleRange(raw: string): ParsedRange | null {
  const s = normalizeRangeString(raw);
  if (!s) return null;

  let m: RegExpMatchArray | null;

  if ((m = s.match(RANGE_RE))) {
    return { min: Number.parseFloat(m[1]), max: Number.parseFloat(m[2]) };
  }
  if ((m = s.match(LESS_RE))) {
    return { min: null, max: Number.parseFloat(m[2]) };
  }
  if ((m = s.match(GREATER_RE))) {
    return { min: Number.parseFloat(m[2]), max: null };
  }

  return null;
}

/** A numeric identity key for a parsed range, so duplicate segments that mean
 *  the same range ("<90 | <90") collapse to one. */
function rangeKey(r: ParsedRange): string {
  return `${r.min}|${r.max}`;
}

/** Split a raw reference-range string into candidate segments on " | " joins
 *  (how the parser stitches spilled range/comment lines) and newlines. */
function splitSegments(raw: string): string[] {
  if (raw == null) return [];
  return String(raw)
    .split(/\s*\|\s*|[\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Conservative multi-segment recovery: split the raw string, parse each
 *  segment with the strict single-segment matcher, dedup by numeric identity,
 *  and return a range ONLY when every parseable segment agrees on exactly ONE
 *  distinct range. Returns null (caller falls back to hardcoded) when nothing
 *  parses or when segments disagree — so cycle-phase FSH/LH tables and
 *  cortisol's dual 8am|4pm range stay refused instead of being flagged against
 *  one arbitrary segment. `pick` maps the winning segment to the caller's
 *  return shape (bounds for parse, display string for format). */
function recoverFromSegments<T>(
  raw: string,
  pick: (seg: string, parsed: ParsedRange) => T | null,
): T | null {
  const segs = splitSegments(raw);
  if (segs.length < 2) return null;

  const seenKeys = new Set<string>();
  let only: T | null = null;
  for (const seg of segs) {
    const parsed = matchSingleRange(seg);
    if (!parsed) continue;
    const value = pick(seg, parsed);
    if (value == null) continue;
    const key = rangeKey(parsed);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      only = value; // first value seen for this distinct range
    }
  }

  return seenKeys.size === 1 ? only : null;
}

export function parseReferenceRange(raw: string): ParsedRange {
  const whole = matchSingleRange(raw);
  if (whole) return whole;

  const recovered = recoverFromSegments(raw, (_seg, parsed) => parsed);
  return recovered ?? { ...NONE };
}

/** Display form of a printed reference range that PRESERVES the lab's original
 *  digit tokens (so "4.0-8.0" stays "4.0", not "4"), normalizing only the
 *  punctuation: separator → en-dash, comparators → "< " / "≤ " / "> " / "≥ ".
 *  Returns null for anything parseReferenceRange would refuse (prose, tables,
 *  multi-range strings) so the caller can fall back. Examples:
 *    "4.0-8.0" → "4.0–8.0"   "22-77" → "22–77"   "<14" → "< 14"
 *    "< or = 2" → "≤ 2"      ">40" → "> 40"      garbage → null */
/** Single-segment display formatter (anchored core). Returns the normalized
 *  display string, or null when the segment is not one range / comparator. */
function matchSingleFormat(raw: string): string | null {
  const s = normalizeRangeString(raw);
  if (!s) return null;

  let m: RegExpMatchArray | null;

  if ((m = s.match(RANGE_RE))) {
    return `${m[1]}–${m[2]}`;
  }
  if ((m = s.match(LESS_RE))) {
    return `${m[1] === "<=" ? "≤" : "<"} ${m[2]}`;
  }
  if ((m = s.match(GREATER_RE))) {
    return `${m[1] === ">=" ? "≥" : ">"} ${m[2]}`;
  }

  return null;
}

export function formatPrintedRange(raw: string): string | null {
  const whole = matchSingleFormat(raw);
  if (whole) return whole;

  // Mirror parseReferenceRange: recover only when every parseable segment
  // agrees on one distinct range (dedup keyed by numeric identity, so the
  // display string and the parsed bounds make the same accept/refuse call).
  return recoverFromSegments(raw, (seg) => matchSingleFormat(seg));
}
