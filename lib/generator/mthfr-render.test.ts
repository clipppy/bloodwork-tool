/**
 * MTHFR render-path test (plan step 5). No test runner is configured, so this
 * is a self-contained tsx script using node:assert; exits non-zero on failure.
 *
 * Proves — WITHOUT a real PDF — that the two MTHFR variant rows that real
 * reports list (MTHFR C677T / MTHFR A1298C) now:
 *   (a) match canonical "MTHFR" as an informational categorical marker, and
 *   (b) actually render the MTHFR narrative in the main report (not dropped to
 *       the "Markers Not Analyzed" appendix, which is what suppressed it).
 *
 * Run: npx tsx lib/generator/mthfr-render.test.ts   (or: npm run test:mthfr)
 */

import assert from "node:assert/strict";
import { matchMarkers } from "../matcher";
import { flagMarkers } from "../flagging";
import { generateWordReport } from "./word";
import type { ParsedMarker } from "../parsers/types";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mammoth = require("mammoth");

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else failures.push(`  ✗ ${msg}`);
}

function mk(rawName: string, value: string): ParsedMarker {
  return {
    rawName,
    value,
    unit: null,
    labFlagFromPdf: null,
    referenceRangeRaw: null,
    pageNumber: 1,
    rawLine: `${rawName}  ${value}`,
  };
}

async function main() {
  const parsed: ParsedMarker[] = [
    mk("MTHFR C677T", "Heterozygous"),
    mk("MTHFR A1298C", "Homozygous"),
  ];

  // ----- (a) matcher + flagging -----
  const matched = matchMarkers(parsed);
  for (const raw of ["MTHFR C677T", "MTHFR A1298C"]) {
    const m = matched.find((x) => x.rawName === raw)!;
    ok(m.matchStatus === "matched", `${raw} matchStatus === "matched" (got ${m?.matchStatus})`);
    ok(m.canonicalName === "MTHFR", `${raw} canonicalName === "MTHFR" (got ${JSON.stringify(m?.canonicalName)})`);
  }

  const flagged = flagMarkers(matched);
  for (const raw of ["MTHFR C677T", "MTHFR A1298C"]) {
    const f = flagged.find((x) => x.rawName === raw)!;
    ok(f.flagStatus === "informational", `${raw} flagStatus === "informational" (got ${f?.flagStatus})`);
  }

  // ----- (b) render path -----
  const buf = await generateWordReport(flagged, {
    patientName: "SYNTHETIC (MTHFR test)",
    patientDate: "2026-07-21",
  });
  const { value: text } = await mammoth.extractRawText({ buffer: buf });
  const lines: string[] = text.split(/\r?\n/).map((l: string) => l.trim());

  // The distinctive first bullet of the MTHFR narrative must appear.
  const narrativeMarker = "methylenetetrahydrofolate reductase";
  ok(text.includes(narrativeMarker), `rendered doc contains the MTHFR narrative ("${narrativeMarker}")`);
  ok(text.includes("Recommended Treatment for MTHFR Mutation"), `rendered doc contains the MTHFR treatment block`);

  // Must NOT be dropped to the appendix.
  const apIdx = lines.findIndex((l) => /Markers Not Analyzed/.test(l));
  const appendix = apIdx >= 0 ? lines.slice(apIdx + 1) : [];
  ok(!appendix.some((l) => /mthfr/i.test(l)), `MTHFR not listed in the "Markers Not Analyzed" appendix`);

  if (failures.length > 0) {
    console.error(`\nmthfr-render: ${failures.length} FAILED, ${passed} passed\n`);
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(`mthfr-render: all ${passed} assertions passed ✓`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
