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
 *
 * Also supports a before/after printed-range diff mode:
 *   npx tsx scripts/validate-flagging.ts --diff   (npm run diff:flagging)
 * which re-flags every sample twice — once forcing the old hardcoded
 * rec.labRange, once with step 1's printed-range logic — and prints only the
 * markers whose flagStatus changed. No-ops cleanly when samples/ is empty.
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

// ===========================================================================
// Before/after diff mode (--diff): does step 1's printed-range logic change
// any flags versus the old hardcoded rec.labRange?
// ===========================================================================

/** Reproduce the OLD (pre-step-1) flagging: blank referenceRangeRaw so the
 *  engine can't read a printed range and falls back to the hardcoded
 *  rec.labRange. This is a faithful "before" because reading referenceRangeRaw
 *  is the ONLY behavioral change step 1 introduced. Both runs consume the same
 *  matched[] (flagMarkers preserves order), so rows align 1:1 by index. */
function flagOld(matched: ReturnType<typeof matchMarkers>): FlaggedMarker[] {
  return flagMarkers(matched.map((m) => ({ ...m, referenceRangeRaw: "" })));
}

interface DiffRow {
  label: string;
  rawName: string;
  value: string;
  printed: string;
  oldLab: string;
  oldStatus: string;
  newStatus: string;
}

interface SampleRun {
  label: string;
  matched: ReturnType<typeof matchMarkers>;
  newFlags: FlaggedMarker[];
  oldFlags: FlaggedMarker[];
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** Human-readable form of a hardcoded {min,max} labRange for the review file. */
function fmtLabRange(r: { min: number | null; max: number | null } | undefined): string {
  if (!r || (r.min === null && r.max === null)) return "(none)";
  if (r.min !== null && r.max !== null) return `${r.min}-${r.max}`;
  if (r.max !== null) return `<${r.max}`;
  return `>${r.min}`;
}

const MD_OUT = path.join(__dirname, "output", "flag-diff.md");

function mdTable(rows: DiffRow[]): string {
  if (rows.length === 0) return "_None._\n";
  const lines = [
    "| Sample | Raw name | Value | Printed range | Old hardcoded labRange | Old flag → New flag |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const cell = (s: string) => s.replace(/\|/g, "\\|");
    lines.push(
      `| ${cell(r.label)} | ${cell(r.rawName)} | ${cell(r.value)} | ${cell(r.printed)} | ${cell(r.oldLab)} | ${r.oldStatus} → ${r.newStatus} |`,
    );
  }
  return lines.join("\n") + "\n";
}

function writeDiffMarkdown(rows: DiffRow[], sampleCount: number, markersCompared: number) {
  const toOptimal = (r: DiffRow) => r.newStatus === "optimal";
  const notFlaggableToOptimal = rows.filter(
    (r) => r.oldStatus === "not_flaggable" && toOptimal(r),
  );
  const highLowToOptimal = rows.filter(
    (r) => (r.oldStatus === "high" || r.oldStatus === "low") && toOptimal(r),
  );
  const covered = new Set([...notFlaggableToOptimal, ...highLowToOptimal]);
  const everythingElse = rows.filter((r) => !covered.has(r));

  const body =
    `# Flagging before/after — printed range vs hardcoded labRange\n\n` +
    `> ⚠️ Contains patient values. This file lives in the gitignored \`scripts/output/\`.\n\n` +
    `Generated by \`npm run diff:flagging\`. "Before" forces the old hardcoded ` +
    `\`rec.labRange\`; "after" uses the printed range parsed off each report ` +
    `(step 1). ${sampleCount} sample(s), ${markersCompared} markers compared, ` +
    `${rows.length} flag change(s).\n\n` +
    `## not_flaggable → optimal (${notFlaggableToOptimal.length})\n\n` +
    `Markers that had no hardcoded range (\`labRange {null,null}\`) and are now ` +
    `evaluated against the range printed on the report.\n\n` +
    mdTable(notFlaggableToOptimal) +
    `\n## high / low → optimal (${highLowToOptimal.length}) — CLINICAL REVIEW\n\n` +
    `Previously flagged out-of-optimal, now in range because the printed lab ` +
    `range differs from (and corrects) the hardcoded one. Review each: a wrong ` +
    `hardcoded range being fixed is good; a too-wide printed range masking a real ` +
    `flag is not.\n\n` +
    mdTable(highLowToOptimal) +
    `\n## everything else (${everythingElse.length})\n\n` +
    mdTable(everythingElse);

  fs.mkdirSync(path.dirname(MD_OUT), { recursive: true });
  fs.writeFileSync(MD_OUT, body, "utf8");
}

// ---------------------------------------------------------------------------
// Clinical assertions (plan §Validation step 2).
//
// Dormant until the specific reports are present: each is keyed to a report by
// filename hint. If no present sample's basename matches the hints, the check
// is SKIPPED (not failed). Once the report lands, an unmet assertion FAILS the
// process (exit 1).
//
// NOTE: the "T4 Total → matched" check depends on the alias fix in step 3 of
// the plan — it will FAIL when Chris's report is added until step 3 lands.
// That's intentional: it documents the required end state.
//
// If the real reports are named differently, update `hints` below.
// ---------------------------------------------------------------------------
interface Assertion {
  canonical: string;
  expect: (f: FlaggedMarker) => boolean;
  expectation: string;
}
interface ReportCheck {
  report: string;
  hints: string[];
  assertions: Assertion[];
}

const CLINICAL_CHECKS: ReportCheck[] = [
  {
    report: "Roberto (Functional Health via Health Gorilla)",
    hints: ["roberto"],
    assertions: [
      {
        canonical: "Rheumatoid Factor",
        expect: (f) => f.matchStatus === "matched" && f.flagStatus === "optimal",
        expectation: "matched & in range (optimal)",
      },
      {
        canonical: "SHBG (Sex Hormone Binding Globulin)",
        expect: (f) => f.matchStatus === "matched" && f.flagStatus === "high",
        expectation: "matched & high",
      },
    ],
  },
  {
    report: "Chris Vasser (Quest)",
    hints: ["chris", "vasser"],
    assertions: [
      {
        canonical: "SHBG (Sex Hormone Binding Globulin)",
        expect: (f) => f.matchStatus === "matched" && f.flagStatus === "high",
        expectation: "matched & high",
      },
      {
        canonical: "T4 Total",
        expect: (f) => f.matchStatus === "matched",
        expectation: "matched (depends on step 3 alias fix)",
      },
    ],
  },
];

/** Returns true if any assertion failed. */
function runClinicalAssertions(runs: SampleRun[]): boolean {
  console.log("\n=========================================================");
  console.log("Clinical assertions (plan §Validation step 2)");
  console.log("=========================================================");

  let anyFailed = false;
  for (const check of CLINICAL_CHECKS) {
    const run = runs.find((r) =>
      check.hints.some((h) => r.label.toLowerCase().includes(h)),
    );
    if (!run) {
      console.log(`\n  ${check.report}`);
      console.log(`    ⏭  SKIP — report not present (looked for: ${check.hints.join(", ")})`);
      continue;
    }
    console.log(`\n  ${check.report}  [${run.label}]`);
    for (const a of check.assertions) {
      const marker = run.newFlags.find((f) => f.canonicalName === a.canonical);
      if (!marker) {
        anyFailed = true;
        console.log(
          `    ✗ FAIL — ${a.canonical}: expected ${a.expectation}, but marker not found in this report`,
        );
        continue;
      }
      if (a.expect(marker)) {
        console.log(
          `    ✓ PASS — ${a.canonical}: ${a.expectation} (value=${String(marker.value)}, printed="${marker.referenceRangeRaw?.trim() || "(none)"}")`,
        );
      } else {
        anyFailed = true;
        console.log(
          `    ✗ FAIL — ${a.canonical}: expected ${a.expectation}, got matchStatus=${marker.matchStatus} flagStatus=${marker.flagStatus} (value=${String(marker.value)})`,
        );
      }
    }
  }
  return anyFailed;
}

async function diffMain() {
  console.log("\n=========================================================");
  console.log("Before/after flag diff — old hardcoded labRange vs printed range");
  console.log("=========================================================");

  const present = SAMPLES.filter((p) => fs.existsSync(p));
  if (present.length === 0) {
    console.log("\n  no samples present (samples/ is empty) — nothing to compare.\n");
    return;
  }

  const runs: SampleRun[] = [];
  const rows: DiffRow[] = [];
  let markersCompared = 0;
  for (const p of present) {
    const buf = fs.readFileSync(p);
    const parsed = await parseQuestPdf(buf);
    const matched = matchMarkers(parsed.markers);
    const newFlags = flagMarkers(matched);
    const oldFlags = flagOld(matched);
    runs.push({ label: path.basename(p), matched, newFlags, oldFlags });
    markersCompared += matched.length;

    for (let i = 0; i < matched.length; i++) {
      const oldF = oldFlags[i];
      const newF = newFlags[i];
      if (oldF.flagStatus === newF.flagStatus) continue;
      rows.push({
        label: path.basename(p),
        rawName: newF.rawName || newF.canonicalName || "(unknown)",
        value: String(newF.value),
        printed: newF.referenceRangeRaw?.trim() || "(none)",
        oldLab: fmtLabRange(findMarker(newF.canonicalName)?.labRange),
        oldStatus: oldF.flagStatus,
        newStatus: newF.flagStatus,
      });
    }
  }

  console.log(
    `\n  ${present.length} sample(s), ${markersCompared} markers compared, ${rows.length} flag change(s).`,
  );

  if (rows.length > 0) {
    // Column widths (bounded so the console table stays readable; the full,
    // untruncated list goes to the markdown file).
    const W = { pdf: 26, name: 26, value: 10, printed: 22, old: 14, new: 14 };
    const head =
      "  " +
      "PDF".padEnd(W.pdf) +
      "RAW NAME".padEnd(W.name) +
      "VALUE".padEnd(W.value) +
      "PRINTED RANGE".padEnd(W.printed) +
      "OLD".padEnd(W.old) +
      "→ NEW";
    console.log("\n" + head);
    console.log("  " + "-".repeat(head.length - 2));
    for (const r of rows) {
      console.log(
        "  " +
          truncate(r.label, W.pdf - 1).padEnd(W.pdf) +
          truncate(r.rawName, W.name - 1).padEnd(W.name) +
          truncate(r.value, W.value - 1).padEnd(W.value) +
          truncate(r.printed, W.printed - 1).padEnd(W.printed) +
          r.oldStatus.padEnd(W.old) +
          "→ " +
          r.newStatus,
      );
    }
  } else {
    console.log(
      "\n  No flagStatus changed — every printed range agreed with the hardcoded\n" +
        "  labRange (or parsed to nothing).",
    );
  }

  writeDiffMarkdown(rows, present.length, markersCompared);
  console.log(`\n  Full grouped change list written to ${path.relative(process.cwd(), MD_OUT)}`);

  const failed = runClinicalAssertions(runs);
  console.log("");
  if (failed) {
    console.error("Clinical assertions FAILED — see above.\n");
    process.exit(1);
  }
}

const DIFF_MODE = process.argv.slice(2).includes("--diff");

(DIFF_MODE ? diffMain() : main()).catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
