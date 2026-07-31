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

// ----- Post-match de-dupe (AMH renders twice on Function reports) -----
// The body and appendix print the wrapped name differently, so the rawName-keyed
// body/appendix collapse misses them and both map to canonical AMH.

/** ParsedMarker with explicit value/unit/range, for the de-dupe tests. */
function row(
  rawName: string,
  value: number | string,
  opts: { unit?: string; range?: string; flag?: "H" | "L" | null } = {},
): ParsedMarker {
  return {
    rawName,
    value,
    unit: opts.unit ?? "ng/mL",
    labFlagFromPdf: opts.flag ?? null,
    referenceRangeRaw: opts.range ?? "0.36-10.07",
    pageNumber: 1,
    rawLine: rawName,
  };
}

function checkDedupe(
  label: string,
  parsed: ParsedMarker[],
  expect: { canonical: string; count: number },
) {
  const matched = matchMarkers(parsed);
  const rows = matched.filter(
    (m) => m.matchStatus === "matched" && m.canonicalName === expect.canonical,
  );
  try {
    assert.equal(rows.length, expect.count, `rows for ${expect.canonical}`);
    passed++;
  } catch (e) {
    failures.push(
      `  ✗ ${label}\n` +
        `      expected ${expect.count} row(s) for ${expect.canonical}, got ${rows.length}\n` +
        `      rows: ${rows.map((r) => `["${r.rawName}"=${JSON.stringify(r.value)}]`).join(" ")}\n` +
        `      (${(e as Error).message})`,
    );
  }
}

// (1) Same canonical, SAME value, differently-printed names → ONE row.
checkDedupe(
  "AMH printed two ways with the same value collapses to one row",
  [row("ANTI-MULLERIAN HORMONE", 2.57), row("(AMH), FEMALE", 2.57)],
  { canonical: "AMH (Anti-Mullerian Hormone)", count: 1 },
);
// The real TM.pdf pair (body keeps the full wrapped name, appendix the tail).
checkDedupe(
  "AMH real TM.pdf wrap pair collapses to one row",
  [row("ANTI-MULLERIAN HORMONE (AMH), FEMALE", 2.57), row("(AMH), FEMALE", 2.57)],
  { canonical: "AMH (Anti-Mullerian Hormone)", count: 1 },
);

// (2) Same canonical, DIFFERENT values → BOTH kept. Collapsing these would
// merge legitimately distinct results.
checkDedupe(
  "same canonical with different values keeps both rows",
  [row("ANTI-MULLERIAN HORMONE", 2.57), row("(AMH), FEMALE", 4.12)],
  { canonical: "AMH (Anti-Mullerian Hormone)", count: 2 },
);
// MTHFR's two variants resolve to one shared record and often report the SAME
// genotype string — they must survive regardless of value.
checkDedupe(
  "MTHFR C677T / A1298C with different genotypes keeps both rows",
  [
    row("MTHFR C677T", "Heterozygous", { unit: "", range: "" }),
    row("MTHFR A1298C", "Not Detected", { unit: "", range: "" }),
  ],
  { canonical: "MTHFR", count: 2 },
);
checkDedupe(
  "MTHFR C677T / A1298C with the SAME genotype still keeps both rows",
  [
    row("MTHFR C677T", "Heterozygous", { unit: "", range: "" }),
    row("MTHFR A1298C", "Heterozygous", { unit: "", range: "" }),
  ],
  { canonical: "MTHFR", count: 2 },
);

// Different non-blank units mean different measurements — never collapse.
checkDedupe(
  "same canonical and value but different units keeps both rows",
  [
    row("ANTI-MULLERIAN HORMONE", 2.57, { unit: "ng/mL" }),
    row("(AMH), FEMALE", 2.57, { unit: "pmol/L" }),
  ],
  { canonical: "AMH (Anti-Mullerian Hormone)", count: 2 },
);

// The surviving row must not lose data the dropped row carried: a parseable
// printed range, the unit, or the lab's own H/L flag.
(() => {
  const [m] = matchMarkers([
    row("ANTI-MULLERIAN HORMONE", 2.57, { unit: "", range: "", flag: null }),
    row("(AMH), FEMALE", 2.57, { unit: "ng/mL", range: "0.36-10.07", flag: "H" }),
  ]).filter((r) => r.canonicalName === "AMH (Anti-Mullerian Hormone)");
  try {
    assert.equal(m.referenceRangeRaw, "0.36-10.07", "referenceRangeRaw backfilled");
    assert.equal(m.unit, "ng/mL", "unit backfilled");
    assert.equal(m.labFlagFromPdf, "H", "labFlagFromPdf preserved");
    assert.ok(
      m.notes.some((n) => n.includes("duplicate row collapsed")),
      "collapse recorded in notes",
    );
    passed++;
  } catch (e) {
    failures.push(
      `  ✗ collapsed AMH row backfills range/unit/lab flag from the dropped row\n` +
        `      got range="${m.referenceRangeRaw}" unit="${m.unit}" flag=${m.labFlagFromPdf}\n` +
        `      (${(e as Error).message})`,
    );
  }
})();

// ----- Report -----
if (failures.length > 0) {
  console.error(`\nmatcher: ${failures.length} FAILED, ${passed} passed\n`);
  console.error(failures.join("\n\n"));
  process.exit(1);
}
console.log(`matcher: all ${passed} assertions passed ✓`);
