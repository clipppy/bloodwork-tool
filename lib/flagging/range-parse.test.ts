/**
 * Unit tests for parseReferenceRange. No test runner is configured in this
 * repo, so this is a self-contained tsx script using node:assert. It exits
 * non-zero on the first failure.
 *
 * Run: npx tsx lib/flagging/range-parse.test.ts   (or: npm run test:range-parse)
 */

import assert from "node:assert/strict";
import { parseReferenceRange, type ParsedRange } from "./range-parse";

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

// ----- Report -----
if (failures.length > 0) {
  console.error(`\nrange-parse: ${failures.length} FAILED, ${passed} passed\n`);
  console.error(failures.join("\n\n"));
  process.exit(1);
}
console.log(`range-parse: all ${passed} assertions passed ✓`);
