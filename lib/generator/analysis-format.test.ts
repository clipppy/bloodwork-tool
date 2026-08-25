/**
 * Table-formatting helpers for the analysis chart. Same house pattern as the
 * other tests here: a self-contained tsx script with a local ok(), non-zero
 * exit on failure.
 *
 * These three functions decide what the Marker, Functional/Optimal, and Status
 * columns actually print. They are pure string transforms over what
 * deterministic.ts computed — they never touch a value or re-derive a flag —
 * so they are cheap to pin down and expensive to get wrong silently.
 *
 * Run: npx tsx lib/generator/analysis-format.test.ts  (or: npm run test:analysis-format)
 */

import {
  shortMarkerName,
  displayOptimalRange,
  statusChip,
} from "./analysis-word";
import { OPTIMAL_RANGES } from "../ranges/optimal-ranges";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else failures.push(`  x ${msg}`);
}
const eq = (actual: string, expected: string, label: string) =>
  ok(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

function main() {
  // ----- shortMarkerName: strip a TRAILING expansion only -----
  eq(shortMarkerName("MCV (Mean Corpuscular Volume)"), "MCV", "MCV expansion stripped");
  eq(shortMarkerName("RBC (Red Blood Cell)"), "RBC", "RBC expansion stripped");
  eq(shortMarkerName("TIBC (Total Iron Binding Capacity)"), "TIBC", "TIBC expansion stripped");
  eq(shortMarkerName("sTSH (Serum Thyroid Stimulating Hormone)"), "sTSH", "sTSH expansion stripped");
  eq(shortMarkerName("Estradiol (E2)"), "Estradiol", "two-char qualifier stripped");
  eq(shortMarkerName("Omega-3 Index (EPA+DPA+DHA)"), "Omega-3 Index", "composition note stripped");
  // Guards — the paren is part of the name, or not trailing.
  eq(shortMarkerName("Lipoprotein (a)"), "Lipoprotein (a)", "one-char qualifier KEPT");
  eq(shortMarkerName("Vitamin D 1,25 (OH)2 Total"), "Vitamin D 1,25 (OH)2 Total", "non-trailing paren KEPT");
  eq(shortMarkerName("Alkaline Phosphatase"), "Alkaline Phosphatase", "no paren, unchanged");
  eq(shortMarkerName("eGFR"), "eGFR", "bare name unchanged");
  eq(shortMarkerName("  Hemoglobin  "), "Hemoglobin", "trimmed");

  // Never empties a name, and never collides two dictionary markers onto one label.
  const shorts = new Map<string, string[]>();
  for (const rec of Object.values(OPTIMAL_RANGES)) {
    const s = shortMarkerName(rec.canonicalName);
    ok(s.trim().length > 0, `shortMarkerName never empty (${rec.canonicalName})`);
    const list = shorts.get(s) ?? [];
    list.push(rec.canonicalName);
    shorts.set(s, list);
  }
  const collisions = [...shorts.entries()].filter(([, names]) => names.length > 1);
  ok(
    collisions.length === 0,
    `no two markers share a short name (${collisions
      .map(([s, names]) => `${s} <- ${names.join(" / ")}`)
      .join("; ")})`,
  );

  // ----- displayOptimalRange -----
  eq(displayOptimalRange("65–99", "80–95"), "80–95", "distinct optimal kept");
  eq(displayOptimalRange("< 130", "< 130 (lab range)"), "—", "lab-range echo collapsed");
  eq(displayOptimalRange("0.2–1.2", "0.2–1.2"), "—", "identical range collapsed");
  eq(displayOptimalRange("> 6729", "≥ 6729"), "—", "strict vs inclusive same threshold collapsed");
  eq(displayOptimalRange("< 5.7", "< 5"), "< 5", "different cutoff kept");
  eq(displayOptimalRange("30–100", ""), "—", "empty optimal renders em dash");
  // Three-tier bands compact to their target band.
  eq(
    displayOptimalRange("< 1138", "Optimal: [−∞, 1138)  |  Moderate: [1138, 1409)  |  High: [1409, +∞)"),
    "—",
    "band target equal to lab cutoff collapsed",
  );
  eq(
    displayOptimalRange("— ", "Optimal: [−∞, 215)  |  Moderate: [215, 301)  |  High: [301, +∞)"),
    "< 215",
    "upper-bounded band compacted",
  );
  eq(
    displayOptimalRange("—", "High: [−∞, 5353)  |  Moderate: [5353, 6729)  |  Optimal: [6729, +∞)"),
    "≥ 6729",
    "lower-bounded band compacted",
  );
  eq(
    displayOptimalRange("—", "Negative: [−∞, 18)  |  Equivocal: [18, 22)  |  Positive: [22, +∞)"),
    "< 18",
    "serology band uses the Negative tier",
  );
  eq(
    displayOptimalRange("—", "Moderate: [1, 3)  |  High: [3, +∞)"),
    "Moderate: [1, 3)  |  High: [3, +∞)",
    "no target tier: full string kept rather than inventing one",
  );

  // ----- statusChip: two short lines, colour follows the lab range -----
  const RED = "C00000";
  const AMBER = "B26A00";
  const GREEN = "2E7D32";
  const NEW = "4A5B6E";

  // Outside the lab range -> red, "Out of Lab Range" + direction.
  const high = statusChip("HIGH", false);
  eq(high.label, "Out of Lab Range", "HIGH label");
  eq(high.direction, "(High)", "HIGH direction");
  eq(high.fill, RED, "HIGH is red");
  const low = statusChip("LOW", false);
  eq(low.label, "Out of Lab Range", "LOW label");
  eq(low.direction, "(Low)", "LOW direction");
  eq(low.fill, RED, "LOW is red");

  // Inside the lab range -> amber, "Out of Optimal" + direction.
  const above = statusChip("ABOVE OPTIMAL*", true);
  eq(above.label, "Out of Optimal", "ABOVE OPTIMAL label");
  eq(above.direction, "(High)", "ABOVE OPTIMAL direction");
  eq(above.fill, AMBER, "above-optimal is amber");
  const sub = statusChip("SUBOPTIMAL*", true);
  eq(sub.label, "Out of Optimal", "SUBOPTIMAL label");
  eq(sub.direction, "(Low)", "SUBOPTIMAL direction is Low");
  eq(sub.fill, AMBER, "below-optimal is amber");
  eq(statusChip("BORDERLINE HIGH*", true).direction, "(High)", "borderline high keeps direction");
  eq(statusChip("BORDERLINE LOW*", true).direction, "(Low)", "borderline low keeps direction");
  eq(statusChip("BORDERLINE LOW*", true).label, "Out of Optimal", "borderline low label");

  // Statuses that genuinely carry no direction must not invent one.
  eq(statusChip("MODERATE", false).direction, "", "MODERATE has no direction");
  eq(statusChip("MODERATE", false).fill, RED, "moderate outside lab range is red");
  eq(statusChip("MODERATE*", true).fill, AMBER, "asterisked moderate is amber");
  eq(statusChip("OUT OF RANGE", false).direction, "", "OUT OF RANGE has no direction");
  eq(statusChip("OUT OF RANGE", false).label, "Out of Lab Range", "OUT OF RANGE label");

  // A value with no usable lab range is treated as outside it, as before.
  eq(statusChip("HIGH", null).fill, RED, "null withinLabRange is red");

  // Re-eval vocabulary.
  eq(statusChip("In Range", true).label, "In Range", "re-eval In Range label");
  eq(statusChip("In Range", true).fill, GREEN, "re-eval In Range is green");
  eq(statusChip("Out of Lab Range", false).label, "Out of Lab Range", "re-eval lab-range label");
  eq(statusChip("Out of Lab Range", false).fill, RED, "re-eval lab-range is red");
  eq(statusChip("Out of Optimal", true).label, "Out of Optimal", "re-eval optimal label");
  eq(statusChip("Out of Optimal", true).fill, AMBER, "re-eval optimal is amber");
  eq(statusChip("Not retested", null).label, "Not retested", "not-retested label");
  eq(statusChip("New Finding", null).label, "New Finding", "new-finding label");
  eq(statusChip("New Finding", null).fill, NEW, "new-finding is the neutral blue-gray");

  // Every chip line must fit the status column. The columns are sized for 16
  // characters at 9pt Arial bold; the direction is a separate line, never a wrap.
  const LABEL_MAX = 16;
  const vocabulary = [
    "HIGH", "LOW", "MODERATE", "MODERATE*", "OUT OF RANGE", "OUT OF RANGE*",
    "ABOVE OPTIMAL*", "SUBOPTIMAL*", "BORDERLINE HIGH*", "BORDERLINE LOW*",
    "OPTIMAL", "In Range", "Out of Lab Range", "Out of Optimal", "Not retested",
    "New Finding",
  ];
  for (const v of vocabulary) {
    for (const within of [true, false, null] as const) {
      const chip = statusChip(v, within);
      ok(
        chip.label.length <= LABEL_MAX,
        `chip label "${chip.label}" (from "${v}") is ${chip.label.length} chars, over the ${LABEL_MAX}-char budget`,
      );
      ok(!chip.label.includes("\n"), `chip label "${chip.label}" is single-line`);
      ok(
        chip.direction === "" || chip.direction === "(High)" || chip.direction === "(Low)",
        `chip direction "${chip.direction}" (from "${v}") is one of "", "(High)", "(Low)"`,
      );
      // A direction only ever accompanies an out-of-range verdict.
      ok(
        chip.direction === "" ||
          chip.label === "Out of Lab Range" ||
          chip.label === "Out of Optimal",
        `direction "${chip.direction}" attached to unexpected label "${chip.label}"`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(`\nanalysis-format: ${failures.length} FAILED, ${passed} passed\n`);
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(`analysis-format: all ${passed} assertions passed`);
}

main();
