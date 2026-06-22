/**
 * Normalization helpers used by the matcher. Exported so tests / debugging
 * scripts can verify each step independently. Pure functions, no I/O.
 */

/** Strip a single trailing parenthesized group from a name — used to drop
 *  qualifier suffixes like "GLUCOSE (FASTING)" → "GLUCOSE". Leaves
 *  parentheses in the middle alone (e.g. "WBC (White Blood Cell)" still
 *  matches via aliases — we only strip a TRAILING group). */
export function stripTrailingParen(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** Trailing comma-separated qualifier tokens that Quest tacks onto a marker
 *  name to indicate methodology / specimen / disambiguation. Intentionally
 *  conservative — does NOT include "free" because "Cortisol, Free" is a
 *  distinct alias from "Cortisol", and stripping "free" would collapse
 *  clinically different markers. */
const TRAILING_QUALIFIERS = new Set([
  "total",
  "ms",
  "lc/ms",
  "lc/ms/ms",
  "ia",
  "serum",
  "fasting",
  "plasma",
]);

/** Strip trailing comma-separated qualifier tokens until the first
 *  non-qualifier is reached. "CORTISOL, TOTAL, LC/MS" → "CORTISOL";
 *  "VITAMIN D,25-OH,TOTAL,IA" → "VITAMIN D,25-OH"; "TESTOSTERONE, FREE"
 *  stays "TESTOSTERONE, FREE". */
export function stripTrailingQualifiers(name: string): string {
  const parts = name.split(/\s*,\s*/);
  while (
    parts.length > 1 &&
    TRAILING_QUALIFIERS.has(parts[parts.length - 1].toLowerCase().trim())
  ) {
    parts.pop();
  }
  return parts.join(", ").trim();
}

/** Canonical normalization for alias lookup:
 *  - lowercase
 *  - commas and semicolons → space (insert space first so adjacent tokens
 *    don't fuse: "TESTOSTERONE,BIOAVAILABLE" → "testosterone bioavailable")
 *  - collapse runs of whitespace to a single space
 *  - strip trailing punctuation (. , ; : !)
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[,;]+/g, " ")
    .replace(/[.!:;]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** LDL Pattern column-alignment artifact: the body row sometimes prints
 *  "A A" where the second "A" is column padding. Collapse to "A". Returns
 *  the cleaned value and a flag indicating whether a change was made (so
 *  the matcher can record it in notes[]). */
export function normalizeLdlPatternArtifact(raw: string): {
  cleaned: string;
  changed: boolean;
} {
  const trimmed = raw.trim();
  if (/^([AB])\s+\1$/i.test(trimmed)) {
    return { cleaned: trimmed.charAt(0).toUpperCase(), changed: true };
  }
  return { cleaned: trimmed, changed: false };
}

/** Standard iterative Levenshtein distance. Returns the minimum number of
 *  insertions / deletions / substitutions to turn `a` into `b`. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Fuzzy-match threshold scaled by name length: ≤1 edit on short names
 *  (<8 chars normalized), ≤2 edits on longer names. Keeps "RDW" / "MCH"
 *  from matching unrelated 3-letter strings. */
export function fuzzyThreshold(normalizedLen: number): number {
  return normalizedLen >= 8 ? 2 : 1;
}
