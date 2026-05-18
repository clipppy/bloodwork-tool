/**
 * Read every PDF in samples/quest/ and samples/function/, dump the raw text
 * extracted by pdf-parse to console and to disk for inspection.
 *
 * This is exploration only — no parsing, no value extraction. The goal is to
 * see what pdf-parse hands us so we can design the real parser this weekend.
 *
 * Outputs:
 *   scripts/output/quest-raw.txt
 *   scripts/output/function-raw.txt
 *
 * Each file contains every PDF in that lab's folder, with a header banner
 * showing the source filename and page count, then the raw text dump.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PDFParse } from "pdf-parse";

const QUEST_DIR = path.resolve("samples/quest");
const FUNCTION_DIR = path.resolve("samples/function");
const OUT_DIR = path.resolve("scripts/output");

async function dumpFolder(label: string, dir: string, outFile: string) {
  if (!fs.existsSync(dir)) {
    console.log(`[${label}] folder missing: ${dir}`);
    return;
  }
  const pdfs = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .sort();

  if (!pdfs.length) {
    console.log(`[${label}] no PDFs found in ${dir}`);
    fs.writeFileSync(outFile, `No PDFs in ${dir}\n`);
    return;
  }

  const chunks: string[] = [];

  for (const file of pdfs) {
    const full = path.join(dir, file);
    const buf = fs.readFileSync(full);
    try {
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      const parsed = await parser.getText();
      const text = parsed.text ?? "";
      const pages = parsed.total ?? parsed.pages?.length ?? 0;
      const banner =
        "\n" +
        "=".repeat(80) +
        `\nFILE: ${file}\nPAGES: ${pages}\nCHARS: ${text.length}\n` +
        "=".repeat(80) +
        "\n";
      chunks.push(banner + text + "\n");
      console.log(
        `[${label}] ${file.padEnd(40)} ${String(pages).padStart(3)} pages, ${text.length} chars`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      chunks.push(`\n\n!!! FAILED to parse ${file}: ${msg}\n\n`);
      console.log(`[${label}] FAILED ${file}: ${msg}`);
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outFile, chunks.join("\n"));
  console.log(`[${label}] → ${path.relative(process.cwd(), outFile)}`);
}

async function main() {
  await dumpFolder("quest", QUEST_DIR, path.join(OUT_DIR, "quest-raw.txt"));
  console.log();
  await dumpFolder("function", FUNCTION_DIR, path.join(OUT_DIR, "function-raw.txt"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
