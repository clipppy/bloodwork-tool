/**
 * Unit tests for the three_tier_band polarity logic in flagMarker. No test
 * runner is configured, so this is a self-contained tsx script using
 * node:assert. It exits non-zero on the first failure.
 *
 * Run: npx tsx lib/flagging/index.test.ts   (or: npm run test:flagging)
 */

import assert from "node:assert/strict";
import { flagMarker } from "./index";
import type { MatchedMarker } from "../matcher";

let passed = 0;
const failures: string[] = [];

/** Build a matched marker for a real canonical record at a given value. */
function matched(canonicalName: string, value: number): MatchedMarker {
  return {
    rawName: canonicalName,
    canonicalName,
    value,
    unit: "",
    labFlagFromPdf: null,
    referenceRangeRaw: "",
    optimalRange: null,
    matchStatus: "matched",
    matchConfidence: "exact",
    confirmationPending: false,
    confirmationSource: null,
    source: "body",
    notes: [],
  };
}

function check(
  label: string,
  canonicalName: string,
  value: number,
  expect: { flagStatus: string; flagDirection: string | null },
) {
  const f = flagMarker(matched(canonicalName, value));
  try {
    assert.equal(f.flagStatus, expect.flagStatus, "flagStatus");
    assert.equal(f.flagDirection, expect.flagDirection, "flagDirection");
    passed++;
  } catch (e) {
    failures.push(
      `  ✗ ${label} — ${canonicalName} @ ${value}\n` +
        `      expected status=${expect.flagStatus} dir=${expect.flagDirection}\n` +
        `      got      status=${f.flagStatus} dir=${f.flagDirection} (${(e as Error).message})`,
    );
  }
}

/** Assert the lab-flag safety net surfaces `value` as `dir` with a note that
 *  contains `noteIncludes` and NOT `noteExcludes`. */
function checkSafetyNet(
  label: string,
  m: MatchedMarker,
  dir: "high" | "low",
  noteIncludes: string,
  noteExcludes: string,
) {
  const f = flagMarker(m);
  const joined = f.flagNotes.join(" ");
  try {
    assert.equal(f.labFlagFallback, true, "labFlagFallback");
    assert.equal(f.flagStatus, dir, "flagStatus");
    assert.equal(f.flagDirection, dir, "flagDirection");
    assert.ok(joined.includes(noteIncludes), `note should include "${noteIncludes}"`);
    assert.ok(!joined.includes(noteExcludes), `note should NOT include "${noteExcludes}"`);
    passed++;
  } catch (e) {
    failures.push(`  ✗ ${label}\n      ${(e as Error).message}\n      notes: ${joined}`);
  }
}

// ----- Lab-flag safety net note is conditional -----
// Boundary case: a MATCHED lab_range_only marker that ties at the lab's cutoff
// (Chol/HDL 5.0 vs "<5.0") — tool DID have the range, so the note must NOT say
// "no reference range".
checkSafetyNet(
  "safety net boundary tie → 'at the lab's reference cutoff' note",
  {
    ...matched("Cholesterol/HDL Ratio", 5),
    labFlagFromPdf: "H",
    referenceRangeRaw: "<5.0",
  },
  "high",
  "at the lab's reference cutoff",
  "no reference range",
);
// Genuinely unmatched marker: keep the original "no reference range" wording.
checkSafetyNet(
  "safety net unmatched marker → 'no reference range' note",
  {
    ...matched("", 999),
    rawName: "SOME UNKNOWN ANALYTE",
    labFlagFromPdf: "L",
    matchStatus: "unmatched",
  },
  "low",
  "no reference range",
  "at the lab's reference cutoff",
);

// ----- higher_is_better (HDL Large: bands High<5353 / Moderate 5353-6729 /
// Optimal>=6729). A below-threshold value is LOW, not high. -----
check("higher_is_better below-threshold (abnormal band) → LOW", "HDL Large", 5042, {
  flagStatus: "low",
  flagDirection: "low",
});
check("higher_is_better borderline band → MODERATE, direction low", "HDL Large", 6138, {
  flagStatus: "moderate",
  flagDirection: "low",
});
check("higher_is_better at/above optimal threshold → OPTIMAL", "HDL Large", 7537, {
  flagStatus: "optimal",
  flagDirection: null,
});

// Severity of the abnormal below-threshold band must stay severe even though
// the status was remapped high→low.
(() => {
  const f = flagMarker(matched("HDL Large", 5042));
  try {
    assert.equal(f.flagSeverity, "severe");
    passed++;
  } catch {
    failures.push(`  ✗ higher_is_better abnormal band severity — expected severe, got ${f.flagSeverity}`);
  }
})();

// ----- higher_is_worse (Apoliopoprotein B: Optimal<90 / Moderate 90-120 /
// High>=120) must be UNCHANGED: non-optimal band is HIGH. -----
check("higher_is_worse abnormal band → HIGH", "Apoliopoprotein B", 163, {
  flagStatus: "high",
  flagDirection: "high",
});
check("higher_is_worse borderline band → MODERATE, direction high", "Apoliopoprotein B", 101, {
  flagStatus: "moderate",
  flagDirection: "high",
});
check("higher_is_worse below threshold → OPTIMAL", "Apoliopoprotein B", 80, {
  flagStatus: "optimal",
  flagDirection: null,
});

// ----- Report -----
if (failures.length > 0) {
  console.error(`\nflagging: ${failures.length} FAILED, ${passed} passed\n`);
  console.error(failures.join("\n\n"));
  process.exit(1);
}
console.log(`flagging: all ${passed} assertions passed ✓`);
