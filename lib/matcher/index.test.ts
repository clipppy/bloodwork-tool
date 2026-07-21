/**
 * Unit tests for the matcher. No test runner is configured in this repo, so
 * this is a self-contained tsx script using node:assert. Exits non-zero on the
 * first failure.
 *
 * Run: npx tsx lib/matcher/index.test.ts   (or: npm run test:matcher)
 */

import assert from "node:assert/strict";
import { matchMarkers } from "./index";
import type { ParsedMarker } from "../parsers/types";

let passed = 0;
const failures: string[] = [];

/** Minimal ParsedMarker for name-resolution tests. */
function mk(rawName: string): ParsedMarker {
  return {
    rawName,
    value: 8.0,
    unit: "ug/dL",
    labFlagFromPdf: null,
    referenceRangeRaw: "4.5-12.0",
    pageNumber: 1,
    rawLine: rawName,
  };
}

function expectMatch(rawName: string, canonical: string) {
  const [m] = matchMarkers([mk(rawName)]);
  try {
    assert.equal(m.matchStatus, "matched");
    assert.equal(m.canonicalName, canonical);
    passed++;
  } catch {
    failures.push(
      `  ✗ ${JSON.stringify(rawName)}\n` +
        `      expected matched → ${JSON.stringify(canonical)}\n` +
        `      got      ${m.matchStatus} → ${JSON.stringify(m.canonicalName)}`,
    );
  }
}

// ----- Total T4 alias resolution (plan step 3) -----
// The printed name Quest/Health Gorilla uses, plus the added variants, plus an
// existing alias as a regression guard.
expectMatch("T4 (Thyroxine), Total", "T4 Total");
expectMatch("T4 (THYROXINE), TOTAL", "T4 Total");
expectMatch("T4 (Thyroxine)", "T4 Total");
expectMatch("T4, Total", "T4 Total");

// ----- Report -----
if (failures.length > 0) {
  console.error(`\nmatcher: ${failures.length} FAILED, ${passed} passed\n`);
  console.error(failures.join("\n\n"));
  process.exit(1);
}
console.log(`matcher: all ${passed} assertions passed ✓`);
