/**
 * Guard: the Windows scripts must be pure ASCII.
 *
 * Windows PowerShell 5.1 reads .ps1 files as ANSI, not UTF-8. A non-ASCII
 * character (an em-dash, a curly quote, an ellipsis) inside a double-quoted
 * string gets misread and breaks parsing, so the update .cmd dies with errors
 * like "Unexpected token", "The '<' operator is reserved", or "Try statement is
 * missing its Catch or Finally block". Prose in the .md files is fine; only the
 * scripts that PowerShell actually parses are checked here.
 *
 * Run: npm run check:ascii
 */
import * as fs from "node:fs";
import * as path from "node:path";

const DIR = path.resolve("scripts/install");
const EXTS = [".ps1", ".cmd"];

type Offense = { line: number; column: number; text: string; bytes: string };

/** Scan raw bytes so a file in any encoding is reported, not silently mangled
 *  by a UTF-8 decode. Returns one entry per run of consecutive non-ASCII bytes. */
function scan(buf: Buffer): Offense[] {
  const offenses: Offense[] = [];
  let line = 1;
  let lineStart = 0;
  let runStart = -1;

  const flushRun = (end: number) => {
    if (runStart < 0) return;
    const slice = buf.subarray(runStart, end);
    offenses.push({
      line,
      column: runStart - lineStart + 1,
      text: slice.toString("utf8"),
      bytes: [...slice].map((b) => b.toString(16).padStart(2, "0")).join(" "),
    });
    runStart = -1;
  };

  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b > 0x7f) {
      if (runStart < 0) runStart = i;
      continue;
    }
    flushRun(i);
    if (b === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  flushRun(buf.length);

  return offenses;
}

function run() {
  if (!fs.existsSync(DIR)) {
    console.error(`FAIL: ${path.relative(process.cwd(), DIR)} does not exist.`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(DIR)
    .filter((f) => EXTS.includes(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(DIR, f));

  // No matches means the guard would pass vacuously (files renamed or moved),
  // which is worse than a real failure because it looks green.
  if (files.length === 0) {
    console.error(
      `FAIL: no ${EXTS.join("/")} files found in ${path.relative(process.cwd(), DIR)}.`,
    );
    process.exit(1);
  }

  let total = 0;

  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    const offenses = scan(fs.readFileSync(file));
    total += offenses.length;

    for (const o of offenses) {
      const codePoints = [...o.text]
        .map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
        .join(" ");
      console.error(
        `${rel}:${o.line}: non-ASCII "${o.text}" (${codePoints}, bytes ${o.bytes}) at byte column ${o.column}`,
      );
    }
  }

  if (total > 0) {
    console.error(
      `\nFAIL: ${total} non-ASCII character run(s) in ${EXTS.join("/")} scripts. ` +
        `Replace them with ASCII (em-dash -> "-", curly quotes -> straight, ellipsis -> "...").`,
    );
    process.exit(1);
  }

  console.log(`OK: ${files.length} file(s) in ${path.relative(process.cwd(), DIR)} are pure ASCII.`);
}

run();
