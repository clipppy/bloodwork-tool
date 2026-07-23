/**
 * reconcile.ts — cross-check the tool's flags against the LAB's own H/L flags.
 *
 *   npm run reconcile
 *
 * Read-only measurement. Changes no flagging/matching logic. For every report
 * in samples/ it runs parse → match → flag and reads the lab's own H/L flag
 * (labFlagFromPdf) carried through the pipeline onto each flagged marker.
 *
 * Report A — disagreements:
 *   • CRITICAL (permissive): lab said H/L but the tool says in-range
 *     (optimal / not_flaggable / informational). The tool is LESS strict than
 *     the lab — the loud, must-review case.
 *   • DIRECTION: lab H but tool low, or lab L but tool high.
 *   • Quiet count: tool stricter than lab (lab silent, tool flagged) — by
 *     design for two-tier optimal ranges.
 *
 * Report B — coverage census: every marker the parser saw but did NOT match to
 * a canonical record (unmatched / ambiguous), per report.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseQuestPdf } from "../lib/parsers/quest";
import { matchMarkers } from "../lib/matcher";
import { flagMarkers, type FlaggedMarker, type FlagStatus } from "../lib/flagging";

// Tool statuses that mean "the tool did NOT raise a concern" (in-range).
const TOOL_IN_RANGE: ReadonlySet<FlagStatus> = new Set<FlagStatus>([
  "optimal",
  "not_flaggable",
  "informational",
]);
// Tool statuses that mean "the tool flagged an abnormality".
const TOOL_FLAGGED: ReadonlySet<FlagStatus> = new Set<FlagStatus>([
  "moderate",
  "high",
  "low",
  "out_of_range",
]);

/** Recursively collect every *.pdf under samples/. */
function findSamplePdfs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** A value the lab could have flagged H/L: a real number, or a string that
 *  begins with a (optionally comparator-prefixed) digit ("<10", ">600.00"). */
function isNumericish(v: number | string): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  return /^[<>]?=?\s*-?\d/.test(v.trim());
}

/** Tool's implied direction: explicit flagDirection, else inferred from a
 *  high/low status. */
function toolDirection(f: FlaggedMarker): "high" | "low" | null {
  if (f.flagDirection === "high" || f.flagDirection === "low") return f.flagDirection;
  if (f.flagStatus === "high") return "high";
  if (f.flagStatus === "low") return "low";
  return null;
}

interface DisagreeRow {
  report: string;
  raw: string;
  canon: string;
  value: string;
  printed: string;
  labFlag: "H" | "L";
  toolFlag: FlagStatus;
  toolDir: string;
}
interface UnmatchedRow {
  raw: string;
  value: string;
  printed: string;
  status: "unmatched" | "ambiguous";
}

async function main() {
  const pdfs = findSamplePdfs("samples");
  if (pdfs.length === 0) {
    console.log("No PDFs found under samples/. Nothing to reconcile.");
    return;
  }

  const critical: DisagreeRow[] = [];
  const direction: DisagreeRow[] = [];
  let toolStricterCount = 0;
  const toolStricterByReport = new Map<string, number>();
  const unmatchedByReport: Array<{ report: string; rows: UnmatchedRow[] }> = [];
  const labFlagCountByReport = new Map<string, number>();

  for (const p of pdfs) {
    const report = path.basename(p);
    const parsed = await parseQuestPdf(fs.readFileSync(p));
    const matched = matchMarkers(parsed.markers);
    const flagged = flagMarkers(matched);

    let labFlagCount = 0;
    for (const f of flagged) {
      const labFlag = f.labFlagFromPdf ?? null;
      if (labFlag === "H" || labFlag === "L") labFlagCount++;

      const printed = f.referenceRangeRaw?.trim() || "(none)";

      // --- Tool stricter than lab (lab silent, tool flagged) — quiet count ---
      if (labFlag === null && TOOL_FLAGGED.has(f.flagStatus) && isNumericish(f.value)) {
        toolStricterCount++;
        toolStricterByReport.set(report, (toolStricterByReport.get(report) ?? 0) + 1);
      }

      if ((labFlag !== "H" && labFlag !== "L") || !isNumericish(f.value)) continue;

      const row: DisagreeRow = {
        report,
        raw: f.rawName,
        canon: f.canonicalName || "(unmatched)",
        value: String(f.value),
        printed,
        labFlag,
        toolFlag: f.flagStatus,
        toolDir: toolDirection(f) ?? "—",
      };

      // --- CRITICAL: lab flagged, tool says in-range (permissive) ---
      if (TOOL_IN_RANGE.has(f.flagStatus)) {
        critical.push(row);
        continue;
      }

      // --- DIRECTION: both flagged, opposite direction ---
      const td = toolDirection(f);
      if ((labFlag === "H" && td === "low") || (labFlag === "L" && td === "high")) {
        direction.push(row);
      }
    }
    labFlagCountByReport.set(report, labFlagCount);

    // --- Coverage census: parser saw it, matcher did not resolve it ---
    const unmatched: UnmatchedRow[] = matched
      .filter((m) => m.matchStatus === "unmatched" || m.matchStatus === "ambiguous")
      .map((m) => ({
        raw: m.rawName,
        value: String(m.value),
        printed: m.referenceRangeRaw?.trim() || "(none)",
        status: m.matchStatus as "unmatched" | "ambiguous",
      }));
    unmatchedByReport.push({ report, rows: unmatched });
  }

  // ===================== Report A: disagreements =====================
  console.log("\n=========================================================");
  console.log("Report A — tool vs lab flag reconciliation");
  console.log("=========================================================");
  console.log(
    `\n  ${pdfs.length} report(s). Lab H/L flags seen (on primary rows): ` +
      Array.from(labFlagCountByReport.entries()).map(([r, n]) => `${r}=${n}`).join(", "),
  );

  console.log("\n---------------------------------------------------------");
  console.log(`🚨 CRITICAL — tool MORE PERMISSIVE than lab: ${critical.length} case(s)`);
  console.log("   (lab flagged H/L but tool says optimal / not_flaggable / informational)");
  console.log("---------------------------------------------------------");
  if (critical.length === 0) {
    console.log("  none ✓");
  } else {
    for (const r of critical) {
      console.log(
        `  🚨 ${r.report}\n` +
          `       marker : ${r.raw}${r.canon !== r.raw ? `  → ${r.canon}` : ""}\n` +
          `       value  : ${r.value}   printed range: ${r.printed}\n` +
          `       lab    : ${r.labFlag}        tool: ${r.toolFlag}`,
      );
    }
  }

  console.log("\n---------------------------------------------------------");
  console.log(`↔️  DIRECTION mismatches (lab H↔tool low / lab L↔tool high): ${direction.length} case(s)`);
  console.log("---------------------------------------------------------");
  if (direction.length === 0) {
    console.log("  none ✓");
  } else {
    for (const r of direction) {
      console.log(
        `  ↔️ ${r.report}: ${r.raw} value=${r.value} printed=${r.printed} — lab=${r.labFlag} tool=${r.toolFlag} (dir ${r.toolDir})`,
      );
    }
  }

  console.log("\n---------------------------------------------------------");
  console.log(`ℹ️  tool STRICTER than lab (expected two-tier): ${toolStricterCount} case(s) — by design, count only`);
  console.log("---------------------------------------------------------");
  for (const [r, n] of Array.from(toolStricterByReport)) console.log(`  ${r}: ${n}`);
  if (toolStricterByReport.size === 0) console.log("  none");

  // ===================== Report B: coverage census =====================
  console.log("\n=========================================================");
  console.log("Report B — coverage census (parser saw it, matcher did NOT resolve)");
  console.log("=========================================================");
  let totalUnmatched = 0;
  for (const { report, rows } of unmatchedByReport) {
    console.log(`\n  ${report}  (${rows.length} unmatched/ambiguous)`);
    totalUnmatched += rows.length;
    for (const r of rows) {
      console.log(`    • [${r.status}] ${r.raw}  value=${r.value}  printed=${r.printed}`);
    }
    if (rows.length === 0) console.log("    (all parsed markers matched ✓)");
  }
  console.log(`\n  Total unmatched/ambiguous across all reports: ${totalUnmatched}`);

  console.log("\nReconcile complete.\n");

  // Guard: the tool must NEVER go silent on a marker the lab flagged H/L. If it
  // does, fail loudly so the check flow catches it (the lab-flag safety net in
  // flagging/index.ts should keep this at zero). Direction mismatches and the
  // unmatched census are reported but non-fatal.
  if (critical.length > 0) {
    console.error(
      `SAFETY NET BREACH — ${critical.length} marker(s) the lab flagged H/L are not surfaced by the tool (see CRITICAL above).\n`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
