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
const LESS_RE = new RegExp(`^<=?(${NUM})$`); // "<14" | "<=2"
const GREATER_RE = new RegExp(`^>=?(${NUM})$`); // ">40" | ">=40"

export function parseReferenceRange(raw: string): ParsedRange {
  if (raw == null) return { ...NONE };
  let s = String(raw).trim();
  if (!s) return { ...NONE };

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
  s = s.replace(/\s+/g, "");
  if (!s) return { ...NONE };

  let m: RegExpMatchArray | null;

  if ((m = s.match(RANGE_RE))) {
    return { min: Number.parseFloat(m[1]), max: Number.parseFloat(m[2]) };
  }
  if ((m = s.match(LESS_RE))) {
    return { min: null, max: Number.parseFloat(m[1]) };
  }
  if ((m = s.match(GREATER_RE))) {
    return { min: Number.parseFloat(m[1]), max: null };
  }

  return { ...NONE };
}
