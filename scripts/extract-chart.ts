/**
 * One-off: extract the doctor's master blood-marker chart from the .docx
 * so we can hand-author lib/ranges/optimal-ranges.ts from it.
 *
 * Output:
 *   scripts/output/master-chart-raw.html  — preserves table structure
 *   scripts/output/master-chart-raw.txt   — plain text fallback
 */
import * as fs from "node:fs";
import * as path from "node:path";
import mammoth from "mammoth";

const CHART = path.resolve(
  "samples/templates/Copy of BW Evaluation Form - google doc.docx",
);
const OUT_DIR = path.resolve("scripts/output");

async function main() {
  if (!fs.existsSync(CHART)) {
    console.error(`Master chart not found at: ${CHART}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const html = await mammoth.convertToHtml({ path: CHART });
  fs.writeFileSync(path.join(OUT_DIR, "master-chart-raw.html"), html.value);

  const text = await mammoth.extractRawText({ path: CHART });
  fs.writeFileSync(path.join(OUT_DIR, "master-chart-raw.txt"), text.value);

  console.log(`HTML : ${html.value.length} chars`);
  console.log(`TEXT : ${text.value.length} chars`);
  if (html.messages.length) console.log("HTML messages:", html.messages.slice(0, 5));
  if (text.messages.length) console.log("TEXT messages:", text.messages.slice(0, 5));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
