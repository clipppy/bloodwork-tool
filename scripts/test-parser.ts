/**
 * Run the Quest PDF parser over every PDF in samples/quest/ and
 * samples/function/, print a summary, and write the full structured
 * output to scripts/output/parsed/{filename}.json for review.
 *
 * Run: npm run test:parser
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseQuestPdf } from "../lib/parsers/quest";

const FOLDERS = [
  path.resolve("samples/quest"),
  path.resolve("samples/function"),
];
const OUT_DIR = path.resolve("scripts/output/parsed");

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

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

      console.log("\n" + "=".repeat(80));
      console.log(`FILE: ${file}`);
      console.log(`Lab source: ${result.patientMeta.labSource}`);
      console.log(`Collected:  ${result.patientMeta.collectedDate ?? "(not found)"}`);
      console.log(`Reported:   ${result.patientMeta.reportedDate ?? "(not found)"}`);
      console.log(`Markers:    ${result.markers.length}`);
      console.log(`Unparsed:   ${result.unparsedLines.length}`);

      console.log("\nFirst 5 markers:");
      for (const m of result.markers.slice(0, 5)) {
        const flag = m.labFlagFromPdf ? ` [${m.labFlagFromPdf}]` : "";
        console.log(
          `  ${m.rawName.padEnd(40)} ${String(m.value).padStart(8)}${flag.padEnd(4)} ${m.unit ?? ""}`,
        );
      }

      if (result.unparsedLines.length) {
        console.log("\nUnparsed lines:");
        for (const ul of result.unparsedLines) {
          console.log(`  | ${ul}`);
        }
      }
    }
  }

  console.log("\n" + "=".repeat(80));
  console.log(`Wrote per-file JSON to ${path.relative(process.cwd(), OUT_DIR)}/`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
