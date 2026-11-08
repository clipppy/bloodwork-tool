/**
 * Repeated-marker dedupe for the analysis chart. Same house pattern: a
 * self-contained tsx script with a local ok(), non-zero exit on failure.
 *
 * The case that motivated it: a merged upload printed Albumin twice (4.2 g/dL
 * from the classic layout, 4.1 from the Lab Services Manager layout) and the
 * chart rendered two Albumin rows.
 *
 * Run: npx tsx lib/analysis/dedupe.test.ts  (or: npm run test:dedupe)
 */

import type { MatchedMarker } from "../matcher";
import { flagMarkers, type FlaggedMarker } from "../flagging";
import {
  dedupeRepeatedMarkers,
  isRepeatMarker,
  materiallyDifferent,
} from "./dedupe";
import {
  buildChartRows,
  buildOptimalRows,
  buildReassuring,
  displayMarkerName,
} from "./deterministic";
import { buildPayload } from "./deidentify";
import { shortMarkerName } from "../generator/analysis-word";
import { systemForMarker } from "./body-systems";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else failures.push(`  x ${msg}`);
}
const eq = (actual: unknown, expected: unknown, label: string) =>
  ok(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

function matched(
  canonicalName: string,
  value: number | string,
  unit: string | null,
  referenceRangeRaw: string | null,
  rawName: string = canonicalName.toUpperCase(),
): MatchedMarker {
  return {
    rawName,
    canonicalName,
    value,
    unit,
    labFlagFromPdf: null,
    referenceRangeRaw,
    referenceNoteRaw: null,
    optimalRange: null,
    matchStatus: "matched",
    matchConfidence: "exact",
    confirmationPending: false,
    confirmationSource: null,
    source: "body",
    notes: [],
    pageNumber: 1,
    rawLine: `${rawName} ${value}`,
  } as unknown as MatchedMarker;
}

function unmatched(rawName: string, value: number): MatchedMarker {
  return {
    ...matched(rawName, value, null, null, rawName),
    canonicalName: rawName,
    matchStatus: "unmatched",
    matchConfidence: "none",
  } as unknown as MatchedMarker;
}

const flag = (ms: MatchedMarker[]): FlaggedMarker[] => flagMarkers(ms, { sex: "female" });
const names = (ms: FlaggedMarker[]) => ms.map(displayMarkerName).join(",");

function main() {
  // ----- The real case: one draw, two layouts, two Albumin rows -----
  {
    const flagged = flag([
      matched("Glucose", 85, "mg/dL", "65-99"),
      matched("Albumin", 4.2, "g/dL", "3.6-5.1"),
      matched("Homocysteine", 7.7, "umol/L", "< or = 11.0"),
      matched("Albumin", 4.1, null, "3.6-5.1 g/dL", "ALBUMIN (1751-7)"),
    ]);
    const out = dedupeRepeatedMarkers(flagged);
    eq(out.length, 3, "one of the two Albumin results is dropped");
    eq(names(out), "Glucose,Albumin,Homocysteine", "order preserved; the remaining Albumin is not tagged");
    const alb = out.find((m) => m.canonicalName === "Albumin")!;
    eq(alb.value, 4.2, "the result carrying a unit is the one kept");
    eq(alb.unit, "g/dL", "...with its unit");
    ok(!out.some(isRepeatMarker), "4.2 vs 4.1 is not a material difference: no repeat row");

    const optimal = buildOptimalRows(out);
    eq(optimal.filter((r) => r.marker.startsWith("Albumin")).length, 1, "the chart prints ONE Albumin row");
    eq(buildChartRows(out).filter((r) => r.marker.startsWith("Albumin")).length, 0, "...and none in the flagged tiers");
    eq(buildReassuring(out).other.filter((s) => s.startsWith("Albumin")).length, 1, "the reassuring list names Albumin once");
    const payload = buildPayload(out, { age: 48, sex: "female", intake: "", patientName: "", dob: "" });
    eq(payload.inRangeMarkers.filter((m) => m.name.startsWith("Albumin")).length, 1, "the payload carries Albumin once");
  }

  // ----- Keeper preference: unit beats document order -----
  {
    const out = dedupeRepeatedMarkers(
      flag([
        matched("Albumin", 4.1, null, "3.6-5.1", "ALBUMIN (1751-7)"),
        matched("Albumin", 4.2, "g/dL", "3.6-5.1"),
      ]),
    );
    eq(out.length, 1, "one row");
    eq(out[0].value, 4.2, "the unit-bearing result wins even when it comes second");
  }

  // ----- Keeper preference: equal otherwise, the first in document order -----
  {
    const out = dedupeRepeatedMarkers(
      flag([matched("Albumin", 4.1, "g/dL", "3.6-5.1"), matched("Albumin", 4.2, "g/dL", "3.6-5.1")]),
    );
    eq(out.length, 1, "one row");
    eq(out[0].value, 4.1, "ties go to the first result printed");
  }

  // ----- Materially different: different tier -> both kept, second tagged -----
  {
    const flagged = flag([
      matched("Albumin", 4.2, "g/dL", "3.6-5.1"),
      matched("Albumin", 3.4, "g/dL", "3.6-5.1"),
    ]);
    ok(materiallyDifferent(flagged[0], flagged[1]), "4.2 (optimal) vs 3.4 (below lab range) is material");
    const out = dedupeRepeatedMarkers(flagged);
    eq(out.length, 2, "both results are kept");
    ok(!isRepeatMarker(out[0]) && isRepeatMarker(out[1]), "the second is the repeat");
    eq(displayMarkerName(out[1]), "Albumin (repeat)", "the repeat is labelled");
    eq(out[1].canonicalName, "Albumin", "canonical name is untouched (lookups still work)");
    eq(buildChartRows(out).map((r) => r.marker).join(","), "Albumin (repeat)", "the repeat charts in the flagged tiers under its label");
    eq(buildOptimalRows(out).map((r) => r.marker).join(","), "Albumin", "the first result stays in the green tier");
    eq(buildChartRows(out)[0].optimalRange, "4–4.9", "the repeat row still finds its optimal range");
    eq(buildChartRows(out)[0].category, "liver", "the repeat row still finds its category");
    eq(shortMarkerName("Albumin (repeat)"), "Albumin (repeat)", "the chart's short name keeps the label");
    eq(shortMarkerName("MCV (Mean Corpuscular Volume) (repeat)"), "MCV (repeat)", "the label survives the expansion strip");
    eq(systemForMarker("Albumin (repeat)"), systemForMarker("Albumin"), "the repeat lands under the same body system");
    const payload = buildPayload(out, { age: 48, sex: "female", intake: "", patientName: "", dob: "" });
    eq(payload.flaggedMarkers.map((m) => m.name).join(","), "Albumin (repeat)", "the payload names the repeat the way the chart does");
  }

  // ----- Materially different: same tier, >5% apart -> both kept -----
  {
    const flagged = flag([
      matched("Glucose", 85, "mg/dL", "65-99"),
      matched("Glucose", 94, "mg/dL", "65-99"),
    ]);
    ok(materiallyDifferent(flagged[0], flagged[1]), "85 vs 94 (10.6%) is material");
    eq(dedupeRepeatedMarkers(flagged).length, 2, "both glucose results kept");
    const close = flag([matched("Glucose", 85, "mg/dL", "65-99"), matched("Glucose", 87, "mg/dL", "65-99")]);
    ok(!materiallyDifferent(close[0], close[1]), "85 vs 87 (2.3%) is not material");
    eq(dedupeRepeatedMarkers(close).length, 1, "near-identical glucose collapses to one row");
  }

  // ----- Categorical / non-numeric: printed value decides -----
  {
    const same = flag([
      matched("LDL Pattern", "Pattern A", null, null),
      matched("LDL Pattern", "Pattern A", null, null),
    ]);
    eq(dedupeRepeatedMarkers(same).length, 1, "identical categorical results collapse");
  }

  // ----- Pass-throughs -----
  {
    const single = flag([matched("Albumin", 4.2, "g/dL", "3.6-5.1"), matched("Glucose", 85, "mg/dL", "65-99")]);
    ok(dedupeRepeatedMarkers(single) === single, "no duplicates: the same array comes back");
    const un = flag([unmatched("SOMETHING ODD", 1), unmatched("SOMETHING ODD", 2)]);
    eq(dedupeRepeatedMarkers(un).length, 2, "unmatched rows are never merged");
  }

  if (failures.length) {
    console.error(`\ndedupe: ${failures.length} FAILED, ${passed} passed\n`);
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(`dedupe: all ${passed} assertions passed`);
}

main();
