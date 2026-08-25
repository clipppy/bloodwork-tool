/**
 * Display helpers for reference text that is NOT a single low-high pair.
 *
 * Some labs print a marker's reference as a stratified table rather than a
 * range — leptin's is broken down by sex, BMI, and age. parseReferenceRange
 * correctly refuses to reduce that to one pair, but the report used to then
 * leave the Standard Lab Range cell blank, which reads as "the lab printed
 * nothing" when in fact it printed a great deal.
 *
 * The rule here is: never show blank when the lab printed something. The cell
 * gets a compacted form; the verbatim text stays on the marker
 * (`referenceNoteRaw`) and, when compaction had to truncate, the caller says so
 * rather than silently dropping the rest.
 *
 * Nothing in this file decides a flag. It is presentation only.
 */

/** Longest compacted string a range cell can show without wrapping badly. */
export const REFERENCE_NOTE_MAX = 46;

export interface CompactedReference {
  /** What the range cell should print. Never empty when `note` had content. */
  text: string;
  /** True when `text` is an abridgement, so the caller can point at the full
   *  text rather than implying the cell is the whole reference. */
  truncated: boolean;
}

/** The "Reference Ranges for <marker>:" header a stratified table leads with,
 *  optionally qualified ("Adult", "Pediatric"). Stripped for display: the
 *  column heading already says what this is. */
const HEADER_RE = /^(?:[A-Za-z]+\s+)?Reference Ranges?\s+for\s+[^:]+:\s*/i;

/** "Males: 0.3-13.4 ng/mL" -> "0.3-13.4". Returns null when absent. */
function sexRange(note: string, sex: "male" | "female"): string | null {
  const word = sex === "male" ? "Males?" : "Females?";
  // Females must not be matched by the Males pattern, so anchor on a boundary.
  const re = new RegExp(`(?:^|[^A-Za-z])${word}\\s*:?\\s*([\\d.]+\\s*-\\s*[\\d.]+)`, "i");
  const m = note.match(re);
  return m ? m[1].replace(/\s*-\s*/, "-") : null;
}

/**
 * Reduce a printed reference table to something that fits a table cell.
 *
 * Preference order: the sex-stratified pair the practitioner actually reads,
 * then a plain abridgement of whatever was printed. Never returns an empty
 * string for non-empty input.
 */
export function compactReferenceNote(
  note: string | null | undefined,
  maxLen: number = REFERENCE_NOTE_MAX,
): CompactedReference | null {
  const raw = (note ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;

  const male = sexRange(raw, "male");
  const female = sexRange(raw, "female");
  if (male && female) {
    // "adult lean" is the stratum that applies to most of the practice's
    // patients and is worth naming; anything else stays unqualified rather
    // than asserting a stratum the text does not support.
    const qualifier = /adult lean/i.test(raw) ? " (adult lean)" : "";
    const text = `M ${male} / F ${female}${qualifier}`;
    // The table always carries more strata than the pair shown.
    return { text, truncated: true };
  }

  // Drop the "Adult Reference Ranges for Cortisol, Total:" style header before
  // measuring. The column is already labelled, and spending the cell's budget
  // on the header is what truncated away the numbers underneath it.
  const body = raw.replace(HEADER_RE, "").trim() || raw;
  const droppedHeader = body !== raw;

  if (body.length <= maxLen) return { text: body, truncated: droppedHeader };
  // Trim on a word boundary so the cell never ends mid-token.
  const cut = body.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = (lastSpace > maxLen * 0.5 ? cut.slice(0, lastSpace) : cut).replace(
    /[\s,;:]+$/,
    "",
  );
  return { text: `${trimmed}…`, truncated: true };
}

/**
 * What a range cell should print for a marker with no usable numeric range.
 * Returns null when there is genuinely nothing printed, so callers keep their
 * existing em-dash behaviour for that case.
 */
export function referenceNoteForCell(
  note: string | null | undefined,
  maxLen: number = REFERENCE_NOTE_MAX,
): string | null {
  return compactReferenceNote(note, maxLen)?.text ?? null;
}
