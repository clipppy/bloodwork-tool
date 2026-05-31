/**
 * Per-marker clinical narrative extracted from Melissa's eval-form template
 * (samples/templates/Copy of BW Evaluation Form - USE THIS '26 - google doc.docx).
 *
 * The Word generator joins these on canonicalName from optimal-ranges.ts and
 * renders them in PART I of the report. The clinical language is Melissa's;
 * the tool only inserts patient results into her structure.
 */

export interface MarkerNarrative {
  /** Display name as it appears in the eval-form template (may differ from
   *  the OPTIMAL_RANGES canonicalName — e.g. "Apoliopoprotein B" vs
   *  "Apolipoprotein B"). The generator uses this for the section header. */
  canonicalName: string;
  /** One or more paragraphs of clinical context that go ABOVE the Increase/
   *  Decrease bullets. Empty string when the eval form had nothing. */
  description: string;
  /** Bulleted causes of an elevated result. */
  increaseCauses: string[];
  /** Bulleted causes of a low result. */
  decreaseCauses: string[];
  /** Free-form prose that goes AFTER the bullets (treatment plans, extended
   *  commentary). Null when none was present. */
  additionalProse: string | null;
}

/** Group-level narrative when the eval form treats a panel as one section
 *  (e.g. EBV panel shares one explanation across 4 antibody markers). */
export interface GroupNarrative {
  /** Group display name from the eval form (e.g. "Epstein-Barr"). */
  groupName: string;
  /** Optimal-ranges canonical names that belong to this group. */
  members: string[];
  /** Shared prose for the group. */
  description: string;
  additionalProse: string | null;
}
