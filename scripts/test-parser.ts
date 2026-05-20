/**
 * Run the Quest PDF parser over every PDF in samples/quest/ and
 * samples/function/, print a summary, and write the full structured
 * output to scripts/output/parsed/{filename}.json for review.
 *
 * Run: npm run test:parser
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseQuestPdf, looksLikeBandRow } from "../lib/parsers/quest";
import type { ParsedMarker } from "../lib/parsers/types";

const FOLDERS = [
  path.resolve("samples/quest"),
  path.resolve("samples/function"),
];
const OUT_DIR = path.resolve("scripts/output/parsed");

/** A marker output is "clean" if it has no duplicate (name/value/unit/range)
 *  tuples and no band-row leakage. Returns the list of violations. */
function checkClean(markers: ParsedMarker[]): string[] {
  const violations: string[] = [];

  const seen = new Set<string>();
  for (const m of markers) {
    const key = `${m.rawName}||${String(m.value)}||${m.unit ?? ""}||${m.referenceRangeRaw ?? ""}`;
    if (seen.has(key)) {
      violations.push(`duplicate tuple: ${m.rawName} = ${m.value} ${m.unit ?? ""} [${m.referenceRangeRaw ?? ""}]`);
    }
    seen.add(key);
  }

  for (const m of markers) {
    if (looksLikeBandRow(m)) {
      violations.push(`band-row leak: ${m.rawName} value=${m.value} range=${m.referenceRangeRaw ?? ""}`);
    }
  }

  return violations;
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let totalDuplicates = 0;
  let totalBandRows = 0;
  const totalDivergent: Array<{ file: string; names: string[] }> = [];
  const totalViolations: Array<{ file: string; violations: string[] }> = [];

  for (const folder of FOLDERS) {
    if (!fs.existsSync(folder)) {
      console.log(`(skip) ${folder} does not exist`);
      continue;
    }
    const pdfs = fs
      .readdirSync(folder)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .sort();

    for (const file of pdfs) {
      const full = path.join(folder, file);
      const buf = fs.readFileSync(full);
      let result;
      try {
        result = await parseQuestPdf(buf);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`\n!!! ${file}: FAILED — ${msg}`);
        continue;
      }

      const baseName = path.basename(file, ".pdf").replace(/\s+/g, "_");
      const outPath = path.join(OUT_DIR, `${baseName}.json`);
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));

      const stats = result.stats;
      const dupRemoved = stats?.duplicatesRemoved ?? 0;
      const bandRejected = stats?.bandRowsRejected ?? 0;
      const divergent = stats?.divergentValueNames ?? [];
      totalDuplicates += dupRemoved;
      totalBandRows += bandRejected;
      if (divergent.length) totalDivergent.push({ file, names: divergent });

      const violations = checkClean(result.markers);
      if (violations.length) totalViolations.push({ file, violations });

      console.log("\n" + "=".repeat(80));
      console.log(`FILE: ${file}`);
      console.log(`Lab source: ${result.patientMeta.labSource}`);
      console.log(`Collected:  ${result.patientMeta.collectedDate ?? "(not found)"}`);
      console.log(`Reported:   ${result.patientMeta.reportedDate ?? "(not found)"}`);
      console.log(`Markers:    ${result.markers.length}`);
      console.log(`Unparsed:   ${result.unparsedLines.length}`);
      console.log(
        `Removed ${dupRemoved} duplicate markers, ${bandRejected} band-row false positives`,
      );
      if (divergent.length) {
        console.log(`Divergent-value warnings: ${divergent.join(", ")}`);
      }
      if (violations.length) {
        console.log(`!!! ${violations.length} clean-check violations:`);
        for (const v of violations.slice(0, 10)) console.log(`    ${v}`);
      } else {
        console.log(`Clean: yes`);
      }

      console.log("\nFirst 5 markers:");
      for (const m of result.markers.slice(0, 5)) {
        const flag = m.labFlagFromPdf ? ` [${m.labFlagFromPdf}]` : "";
        console.log(
          `  ${m.rawName.padEnd(40)} ${String(m.value).padStart(8)}${flag.padEnd(4)} ${m.unit ?? ""}`,
        );
      }
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log(
    `TOTALS: removed ${totalDuplicates} duplicates, ${totalBandRows} band-row false positives across all PDFs`,
  );
  if (totalDivergent.length) {
    console.log(`Divergent-value warnings:`);
    for (const { file, names } of totalDivergent) {
      console.log(`  ${file}: ${names.join(", ")}`);
    }
  } else {
    console.log(`No divergent-value warnings.`);
  }
  if (totalViolations.length) {
    console.log(`\n!!! Clean-check violations across ${totalViolations.length} file(s):`);
    for (const { file, violations } of totalViolations) {
      console.log(`  ${file}: ${violations.length}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`All ${"" /* keep grep-friendly */}PDFs clean.`);
  }
  console.log(`Wrote per-file JSON to ${path.relative(process.cwd(), OUT_DIR)}/`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
