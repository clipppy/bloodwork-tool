/**
 * Validation harness for the flagging engine.
 *
 * Walks all six sample PDFs, runs parse → match → flag, and prints a report:
 *   - per-PDF counts
 *   - three_tier_band flags surfaced with band + threshold
 *   - categorical flags with expected vs actual
 *   - 4 sentinel markers' confirmationSource as observed via the matcher
 *   - Soy/Corn presence + pending-confirmation note
 *   - not_flaggable reasons grouped per PDF
 *
 * Run via: npx tsx scripts/validate-flagging.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseQuestPdf } from "../lib/parsers/quest";
import { matchMarkers } from "../lib/matcher";
import { flagMarkers, type FlaggedMarker } from "../lib/flagging";
import { OPTIMAL_RANGES, findMarker } from "../lib/ranges/optimal-ranges";

const SAMPLES = [
  "samples/function/Lab Results of Record GC.pdf",
  "samples/function/Lab Results of Record SW1.pdf",
  "samples/function/Lab Results of Record SW2.pdf",
  "samples/function/Lab Results of Record TM.pdf",
  "samples/function/Lab Results of Record TM2.pdf",
  "samples/quest/Quanum Lab Services Manager.pdf",
];

const SENTINELS = ["ANA (Anti-nuclear Antibodies)", "Uric Acid", "Cortisol", "Estrogens"];

interface PdfResult {
  label: string;
  flagged: FlaggedMarker[];
}

async function runOne(p: string): Promise<PdfResult> {
  const buf = fs.readFileSync(p);
  const parsed = await parseQuestPdf(buf);
  const matched = matchMarkers(parsed.markers);
  const flagged = flagMarkers(matched);
  return { label: path.basename(p), flagged };
}

function fmtCounts(flagged: FlaggedMarker[]): string {
  const c = {
    total: flagged.length,
    matched: flagged.filter((f) => f.matchStatus === "matched").length,
    high: flagged.filter((f) => f.flagStatus === "high").length,
    low: flagged.filter((f) => f.flagStatus === "low").length,
    moderate: flagged.filter((f) => f.flagStatus === "moderate").length,
    out_of_range: flagged.filter((f) => f.flagStatus === "out_of_range").length,
    optimal: flagged.filter((f) => f.flagStatus === "optimal").length,
    not_flaggable: flagged.filter((f) => f.flagStatus === "not_flaggable").length,
    informational: flagged.filter((f) => f.flagStatus === "informational").length,
  };
  return `total=${c.total} matched=${c.matched} | optimal=${c.optimal} high=${c.high} low=${c.low} moderate=${c.moderate} out_of_range=${c.out_of_range} not_flaggable=${c.not_flaggable} informational=${c.informational}`;
}

async function main() {
  const results: PdfResult[] = [];
  for (const p of SAMPLES) {
    results.push(await runOne(p));
  }

  // ----- Section 1: per-PDF counts -----
  console.log("\n=========================================================");
  console.log("Section 1 — Per-PDF flag counts");
  console.log("=========================================================");
  for (const r of results) {
    console.log(`\n${r.label}`);
    console.log("  " + fmtCounts(r.flagged));
  }

  // ----- Section 2: three_tier_band flags -----
  console.log("\n=========================================================");
  console.log("Section 2 — three_tier_band flags (marker / value / band / thresholds)");
  console.log("=========================================================");
  for (const r of results) {
    const tt = r.flagged.filter((f) => f.flagType === "three_tier_band");
    if (tt.length === 0) continue;
    console.log(`\n${r.label}`);
    for (const f of tt) {
      const rec = findMarker(f.canonicalName);
      const bands = rec?.interpretationBands ?? [];
      const bandStr = bands
        .map((b) => `${b.label}[${b.min ?? "−∞"}, ${b.max ?? "+∞"})`)
        .join(" | ");
      console.log(
        `  ${f.canonicalName.padEnd(38)} value=${String(f.value).padStart(8)}  status=${f.flagStatus.padEnd(7)} severity=${f.flagSeverity}  bands=${bandStr}`,
      );
    }
  }

  // ----- Section 3: categorical flags -----
  console.log("\n=========================================================");
  console.log("Section 3 — categorical flags (expected vs actual)");
  console.log("=========================================================");
  for (const r of results) {
    const cats = r.flagged.filter((f) => f.flagType === "categorical");
    if (cats.length === 0) continue;
    console.log(`\n${r.label}`);
    for (const f of cats) {
      const rec = findMarker(f.canonicalName);
      const expected = rec?.expectedValue ?? "(none — informational)";
      console.log(
        `  ${f.canonicalName.padEnd(34)} expected=${String(expected).padEnd(10)} actual=${String(f.value).padEnd(20)} status=${f.flagStatus}`,
      );
    }
  }

  // ----- Section 4: sentinel confirmationSource -----
  console.log("\n=========================================================");
  console.log("Section 4 — Sentinel confirmationSource");
  console.log("=========================================================");
  for (const canonical of SENTINELS) {
    const rec = findMarker(canonical);
    if (!rec) {
      console.log(`  ${canonical}: NOT FOUND in ranges`);
      continue;
    }
    console.log(
      `  ${canonical.padEnd(34)} flagType=${rec.flagType.padEnd(16)} source=${rec.confirmationSource ?? "(null)"}`,
    );
  }

  // ----- Section 5: Soy/Corn check -----
  console.log("\n=========================================================");
  console.log("Section 5 — Soy/Corn pending-confirmation check");
  console.log("=========================================================");
  for (const k of ["soy", "corn"] as const) {
    const rec = OPTIMAL_RANGES[k];
    if (!rec) {
      console.log(`  ${k}: NOT FOUND`);
      continue;
    }
    console.log(`  ${rec.canonicalName.padEnd(8)} flagType=${rec.flagType} labRange.max=${rec.labRange.max}`);
    console.log(`            notes: ${rec.notes ?? "(none)"}`);
  }

  // ----- Section 6: not_flaggable reasons -----
  console.log("\n=========================================================");
  console.log("Section 6 — not_flaggable markers (sample per PDF, grouped)");
  console.log("=========================================================");
  for (const r of results) {
    const nf = r.flagged.filter((f) => f.flagStatus === "not_flaggable");
    if (nf.length === 0) continue;
    console.log(`\n${r.label}  (${nf.length} markers)`);
    // group by reason
    const reasons = new Map<string, string[]>();
    for (const f of nf) {
      const reason = (f.flagNotes ?? []).join("; ") || "(no reason)";
      const arr = reasons.get(reason) ?? [];
      arr.push(f.rawName || f.canonicalName || "(unknown)");
      reasons.set(reason, arr);
    }
    for (const [reason, names] of reasons) {
      console.log(`    [${names.length}] ${reason}`);
      for (const n of names) console.log(`         • ${n}`);
    }
  }

  // ----- Section 7: unmatched markers (parser/dictionary coverage) -----
  console.log("\n=========================================================");
  console.log("Section 7 — unmatched markers per PDF (still missing from dictionary)");
  console.log("=========================================================");
  for (const r of results) {
    const um = r.flagged.filter(
      (f) => f.matchStatus === "unmatched" || f.matchStatus === "ambiguous",
    );
    if (um.length === 0) continue;
    console.log(`\n${r.label}  (${um.length} markers)`);
    for (const f of um) {
      console.log(`    • ${f.rawName}  (status=${f.matchStatus})`);
    }
  }

  // ----- Section 8: Schema integrity check -----
  console.log("\n=========================================================");
  console.log("Section 8 — Schema integrity (every record has a flagType)");
  console.log("=========================================================");
  const byType = new Map<string, number>();
  let missing = 0;
  for (const rec of Object.values(OPTIMAL_RANGES)) {
    if (!rec.flagType) {
      missing++;
      console.log(`  MISSING flagType: ${rec.canonicalName}`);
      continue;
    }
    byType.set(rec.flagType, (byType.get(rec.flagType) ?? 0) + 1);
  }
  for (const [t, n] of byType) console.log(`  ${t.padEnd(20)} ${n}`);
  console.log(`  TOTAL records: ${Object.keys(OPTIMAL_RANGES).length}`);
  if (missing > 0) console.log(`  ⚠ ${missing} records missing flagType`);

  console.log("\nValidation complete.\n");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
