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

// ----- Magnesium RBC: per-lab scales, printed range must drive -----
// Melissa confirmed (2026) RBC magnesium is reported on different scales per
// lab: Functional Health 1.5-2.5 mg/dL, Quest 4.0-6.4 mg/dL. The record carries
// NO hardcoded fallback, so the SAME value must flag differently depending on
// which lab's range the report printed.
function checkPrinted(
  label: string,
  canonicalName: string,
  value: number,
  referenceRangeRaw: string,
  expect: { flagStatus: string; flagDirection: string | null },
) {
  const f = flagMarker({ ...matched(canonicalName, value), referenceRangeRaw });
  try {
    assert.equal(f.flagStatus, expect.flagStatus, "flagStatus");
    assert.equal(f.flagDirection, expect.flagDirection, "flagDirection");
    assert.equal(f.labRangeSource, "printed", "labRangeSource");
    passed++;
  } catch (e) {
    failures.push(
      `  ✗ ${label} — ${canonicalName} @ ${value} vs printed "${referenceRangeRaw}"\n` +
        `      expected status=${expect.flagStatus} dir=${expect.flagDirection}\n` +
        `      got      status=${f.flagStatus} dir=${f.flagDirection} src=${f.labRangeSource} (${(e as Error).message})`,
    );
  }
}
checkPrinted(
  "Magnesium RBC 2.0 on Functional Health scale (1.5-2.5) → OPTIMAL",
  "Magnesium RBC",
  2.0,
  "1.5-2.5",
  { flagStatus: "optimal", flagDirection: null },
);
checkPrinted(
  "Magnesium RBC 2.0 on Quest scale (4.0-6.4) → LOW",
  "Magnesium RBC",
  2.0,
  "4.0-6.4",
  { flagStatus: "low", flagDirection: "low" },
);
// SW1's real value: still high against the range Quest printed on that report.
checkPrinted(
  "Magnesium RBC 7.0 (SW1) vs printed 4.0-6.4 → HIGH",
  "Magnesium RBC",
  7.0,
  "4.0-6.4",
  { flagStatus: "high", flagDirection: "high" },
);
// No printed range → no hardcoded scale may be substituted. The marker goes
// not_flaggable (report says "refer to lab report"), and the lab-flag safety
// net is what surfaces it when the lab itself flagged the value.
(() => {
  const f = flagMarker(matched("Magnesium RBC", 2.0));
  try {
    assert.equal(f.flagStatus, "not_flaggable", "flagStatus");
    assert.equal(f.effectiveLabRange?.min, null, "effectiveLabRange.min");
    assert.equal(f.effectiveLabRange?.max, null, "effectiveLabRange.max");
    passed++;
  } catch (e) {
    failures.push(
      `  ✗ Magnesium RBC with no printed range → not_flaggable (no hardcoded scale)\n` +
        `      got status=${f.flagStatus} eff=${JSON.stringify(f.effectiveLabRange)} (${(e as Error).message})`,
    );
  }
})();
checkSafetyNet(
  "Magnesium RBC lab-flagged with no printed range → surfaced via safety net",
  {
    ...matched("Magnesium RBC", 7),
    labFlagFromPdf: "H",
  },
  "high",
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
