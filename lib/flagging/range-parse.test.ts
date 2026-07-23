/**
 * Unit tests for parseReferenceRange. No test runner is configured in this
 * repo, so this is a self-contained tsx script using node:assert. It exits
 * non-zero on the first failure.
 *
 * Run: npx tsx lib/flagging/range-parse.test.ts   (or: npm run test:range-parse)
 */

import assert from "node:assert/strict";
import {
  parseReferenceRange,
  formatPrintedRange,
  type ParsedRange,
} from "./range-parse";

let passed = 0;
const failures: string[] = [];

function check(input: string, expected: ParsedRange) {
  const got = parseReferenceRange(input);
  try {
    assert.deepEqual(got, expected);
    passed++;
  } catch {
    failures.push(
      `  ✗ parseReferenceRange(${JSON.stringify(input)})\n` +
        `      expected ${JSON.stringify(expected)}\n` +
        `      got      ${JSON.stringify(got)}`,
    );
  }
}

// ----- Format table from MULTILAB_FIX_PLAN.md §1 -----

// Row: "22-77", "0.8-1.8", "50-180"  → {min, max}
check("22-77", { min: 22, max: 77 });
check("0.8-1.8", { min: 0.8, max: 1.8 });
check("50-180", { min: 50, max: 180 });

// Row: "<14", "<200", "<9"  → {null, max}
check("<14", { min: null, max: 14 });
check("<200", { min: null, max: 200 });
check("<9", { min: null, max: 9 });

// Row: "< or = 2", "<= 2", "< OR = 25"  → {null, max}
check("< or = 2", { min: null, max: 2 });
check("<= 2", { min: null, max: 2 });
check("< OR = 25", { min: null, max: 25 });

// Row: ">5.0", "> or = 40", "> OR = 60"  → {min, null}
check(">5.0", { min: 5.0, max: null });
check("> or = 40", { min: 40, max: null });
check("> OR = 60", { min: 60, max: null });

// Row: anything else (table text, prose)  → {null, null}

// ----- Trailing unit / (calc) stripping -----
check("50-180 mcg/dL", { min: 50, max: 180 });
check("22-77 nmol/L", { min: 22, max: 77 });
check(">40 IU/mL", { min: 40, max: null });
check("<14 IU/mL", { min: null, max: 14 });
check("0.8-1.8 (calc)", { min: 0.8, max: 1.8 });
check("50-180 mcg/dL (calc)", { min: 50, max: 180 });

// ----- Unicode / spacing comparator variants -----
check("≤ 2", { min: null, max: 2 });
check("≥ 40", { min: 40, max: null });
check("< = 2", { min: null, max: 2 });
check("22 - 77", { min: 22, max: 77 });
check("22–77", { min: 22, max: 77 }); // en-dash

// ----- Garbage / prose cases (must all be {null,null}) -----
check("s for Leptin:", { min: null, max: null });
check("For 8 a.m. 4.0-22.0 | 4 p.m. 3.0-17.0", { min: null, max: null });
check("8 a.m. 4.0-22.0", { min: null, max: null }); // range embedded in prose
check("See note", { min: null, max: null });
check("", { min: null, max: null });
check("   ", { min: null, max: null });
check("Not Established", { min: null, max: null });
check("40", { min: null, max: null }); // bare number, no comparator → not a range

// ----- Multi-segment " | " recovery: exactly ONE distinct range across the
// parseable segments → recover it; ZERO or 2+ distinct → still {null,null}.
// Recovers real ranges buried by the parser's spill-join of duplicate/comment
// fragments (Apolipoprotein B, Linoleic Acid, Estradiol). -----
check("<90 | <90", { min: null, max: 90 }); // duplicate join → one distinct
check("18.6-29.5 | /Comments", { min: 18.6, max: 29.5 }); // range + comment junk
check("< OR = 39 | established on post-pubertal patient", { min: null, max: 39 });
check("18.6-29.5\n/Comments", { min: 18.6, max: 29.5 }); // newline split too

// Two-or-more DISTINCT ranges must stay refused (do NOT pick one arbitrarily):
check("2.5-10.2 | 3.1-17.7 | 1.5-9.1 | 23.0-116.3", { min: null, max: null }); // cycle table
check("8 a.m. 4.0-22.0 | 4 p.m. 3.0-17.0", { min: null, max: null }); // cortisol dual (prose)
check("4.0-22.0 | 3.0-17.0", { min: null, max: null }); // cortisol dual (clean, 2 distinct)

// ----- formatPrintedRange: preserve original digit tokens, normalize only
// punctuation (separator → en-dash, comparators → < / ≤ / ≥) -----
function checkFmt(input: string, expected: string | null) {
  const got = formatPrintedRange(input);
  try {
    assert.equal(got, expected);
    passed++;
  } catch {
    failures.push(
      `  ✗ formatPrintedRange(${JSON.stringify(input)})\n` +
        `      expected ${JSON.stringify(expected)}\n` +
        `      got      ${JSON.stringify(got)}`,
    );
  }
}

checkFmt("4.0-8.0", "4.0–8.0"); // decimals preserved, en-dash separator
checkFmt("22-77", "22–77");
checkFmt("<14", "< 14");
checkFmt("< or = 2", "≤ 2");
checkFmt("<= 2", "≤ 2");
checkFmt(">40", "> 40");
checkFmt("> or = 40", "≥ 40");
checkFmt("50-180 mcg/dL", "50–180"); // trailing unit stripped
checkFmt("0.8-1.8 (calc)", "0.8–1.8");
checkFmt("s for Leptin:", null); // garbage → null
checkFmt("8 a.m. 4.0-22.0 | 4 p.m. 3.0-17.0", null); // dual/prose → null
checkFmt("", null);
checkFmt("40", null); // bare number → null

// Multi-segment recovery mirrors parseReferenceRange (one distinct → recover):
checkFmt("<90 | <90", "< 90");
checkFmt("18.6-29.5 | /Comments", "18.6–29.5");
checkFmt("< OR = 39 | established on post-pubertal patient", "≤ 39");
checkFmt("4.0-22.0 | 3.0-17.0", null); // 2 distinct → still refused

// ----- Report -----
if (failures.length > 0) {
  console.error(`\nrange-parse: ${failures.length} FAILED, ${passed} passed\n`);
  console.error(failures.join("\n\n"));
  process.exit(1);
}
console.log(`range-parse: all ${passed} assertions passed ✓`);
