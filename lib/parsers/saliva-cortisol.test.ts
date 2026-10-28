/**
 * Saliva cortisol parser test. House pattern: a self-contained tsx script
 * with a local ok() helper, non-zero exit on failure.
 *
 * The text fixture mirrors the Quest "CORTISOL, LC/MS, SALIVA, 4 SAMPLES"
 * report line for line (title, four sample blocks with draw date / draw time
 * / result row, and the Note 1 reference windows), with made-up values and
 * a made-up header. The real blood-panel sample PDF in samples/quest doubles
 * as the "not a saliva report" case for the PDF entry point.
 *
 * Run: npx tsx lib/parsers/saliva-cortisol.test.ts   (or: npm run test:saliva-parser)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  STANDARD_SALIVA_WINDOWS,
  extractNoteWindows,
  formatSalivaWindow,
  looksLikeSalivaCortisol,
  parseSalivaCortisolPdf,
  parseSalivaCortisolText,
  parseWindowText,
} from "./saliva-cortisol";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else failures.push(`  x ${msg}`);
}

// ----- Fixture: the Quest format, verbatim shape -----

const HEADER = [
  "Report Status: Final",
  "DOE, JANE",
  "Patient Information Specimen Information Client Information",
  "DOE, JANE",
  "DOB: 01/02/1980 AGE: 46",
  "Gender: F Fasting: N",
  "Patient ID: 01021980JD",
  "Specimen: WC999999X",
  "Collected: 04/10/2026 / 08:18 EDT",
  "Reported: 04/16/2026 / 20:30 EDT",
  "Test Name In Range Out Of Range Reference Range Lab",
];

function sampleBlock(n: number, date: string, time: string, value: string): string[] {
  return [
    `CORTISOL, LC/MS, SALIVA, SAMPLE ${n}`,
    `DRAW DATE ${n} ${date}`,
    `DRAW TIME ${n} ${time}`,
    `CORTISOL, SALIVA SAMPLE ${n} ${value} mcg/dL See Note 1`,
  ];
}

const NOTE = [
  "Note 1",
  "Reference ranges for salivary cortisol (LC/MS):",
  "8-10 AM: 0.04-0.56 mcg/dL",
  "noon-2 PM: < or = 0.21 mcg/dL",
  "4-6 PM: < or = 0.15 mcg/dL",
  "10 PM-1 AM: < or = 0.09 mcg/dL",
];

const FIXTURE = [
  ...HEADER,
  "CORTISOL, LC/MS, SALIVA, 4 SAMPLES",
  ...sampleBlock(1, "04/10/2026", "8:18AM", "0.32"),
  ...sampleBlock(2, "04/10/2026", "12:45PM", "0.14"),
  ...sampleBlock(3, "04/10/2026", "5:05PM", "0.09"),
  ...sampleBlock(4, "04/10/2026", "9:20PM", "0.04"),
  ...NOTE,
  "PAGE 1 OF 1",
].join("\n");

// ----- 1. Detection -----

ok(looksLikeSalivaCortisol(FIXTURE), "fixture is recognised as a saliva cortisol report");
ok(looksLikeSalivaCortisol("CORTISOL, SALIVA SAMPLE 1 0.3 mcg/dL"), "bare sample row is recognised");
ok(!looksLikeSalivaCortisol("CORTISOL, TOTAL 12.1 mcg/dL 4.0-22.0"), "serum cortisol is not a saliva report");
ok(parseSalivaCortisolText("") === null, "empty text -> null");
ok(parseSalivaCortisolText(HEADER.join("\n") + "\nTESTOSTERONE, TOTAL, MS 17 2-45 ng/dL") === null, "blood panel text -> null");
ok(
  parseSalivaCortisolText("CORTISOL, LC/MS, SALIVA, 4 SAMPLES\nNote 1\n8-10 AM: 0.04-0.56 mcg/dL") === null,
  "saliva title with no readable sample rows -> null",
);

// ----- 2. The four samples -----

const parsed = parseSalivaCortisolText(FIXTURE);
ok(parsed !== null, "fixture parses");
if (parsed) {
  ok(parsed.samples.length === 4, `4 samples (got ${parsed.samples.length})`);
  const expect: Array<[number, string, number]> = [
    [1, "8:18 AM", 0.32],
    [2, "12:45 PM", 0.14],
    [3, "5:05 PM", 0.09],
    [4, "9:20 PM", 0.04],
  ];
  expect.forEach(([no, time, value], i) => {
    const s = parsed.samples[i];
    ok(s?.sampleNo === no, `sample ${no} in order`);
    ok(s?.drawTime === time, `sample ${no} draw time ${time} (got ${s?.drawTime})`);
    ok(s?.value === value, `sample ${no} value ${value} (got ${s?.value})`);
    ok(s?.unit === "mcg/dL", `sample ${no} unit mcg/dL`);
    ok(s?.qualifier === null, `sample ${no} no qualifier`);
  });
  // The 9:20 PM fourth sample is sample 4 and therefore the night window,
  // even though 9:20 PM is before the printed 10 PM-1 AM clock window.
  ok(parsed.samples[3].sampleNo === 4 && parsed.samples[3].drawTime === "9:20 PM", "9:20 PM sample stays sample 4 (night slot by order)");

  // ----- 3. Note 1 windows, including the <= comparator -----
  ok(parsed.windowsSource === "printed", "windows read from Note 1");
  ok(parsed.windows.morning.min === 0.04 && parsed.windows.morning.max === 0.56, "morning window 0.04-0.56");
  ok(parsed.windows.noon.min === null && parsed.windows.noon.max === 0.21, "noon window <= 0.21");
  ok(parsed.windows.afternoon.min === null && parsed.windows.afternoon.max === 0.15, "afternoon window <= 0.15");
  ok(parsed.windows.night.min === null && parsed.windows.night.max === 0.09, "night window <= 0.09");
  ok(formatSalivaWindow(parsed.windows.morning) === "0.04-0.56 mcg/dL", "morning window formats as a span");
  ok(formatSalivaWindow(parsed.windows.night) === "<= 0.09 mcg/dL", "night window formats with <=");

  // ----- 4. Collection date is the first draw date; nothing else is kept -----
  ok(parsed.collectedDate === "04/10/2026", `collected date from DRAW DATE 1 (got ${parsed.collectedDate})`);
  const serialized = JSON.stringify(parsed);
  for (const id of ["DOE", "JANE", "01/02/1980", "01021980JD", "WC999999X", "Patient", "DOB", "Specimen"]) {
    ok(!serialized.includes(id), `parse output carries no "${id}"`);
  }
  ok(Object.keys(parsed).sort().join(",") === "collectedDate,samples,windows,windowsSource", "parse output has only the four documented keys");
}

// ----- 5. Window text parsing variants -----

ok(JSON.stringify(parseWindowText("0.04-0.56")) === JSON.stringify({ min: 0.04, max: 0.56 }), "a-b");
ok(JSON.stringify(parseWindowText("< or = 0.21")) === JSON.stringify({ min: null, max: 0.21 }), "< or = b");
ok(JSON.stringify(parseWindowText("<= 0.15")) === JSON.stringify({ min: null, max: 0.15 }), "<= b");
ok(JSON.stringify(parseWindowText("<0.09")) === JSON.stringify({ min: null, max: 0.09 }), "<b");
ok(JSON.stringify(parseWindowText("≤ 0.09")) === JSON.stringify({ min: null, max: 0.09 }), "unicode <= b");
ok(JSON.stringify(parseWindowText("> or = 0.04")) === JSON.stringify({ min: 0.04, max: null }), "> or = a");
ok(parseWindowText("see note") === null, "prose -> null");

// Spec spelling of the comparator ("<=") and "12 PM" for noon both read.
const altNote = [
  "CORTISOL, LC/MS, SALIVA, 4 SAMPLES",
  "CORTISOL, SALIVA SAMPLE 1 0.20 mcg/dL See Note 1",
  "Note 1",
  "8-10 AM: 0.04-0.56 mcg/dL",
  "12 PM-2 PM: <= 0.21 mcg/dL",
  "4-6 PM: <= 0.15 mcg/dL",
  "10 PM-1 AM: <= 0.09 mcg/dL",
].join("\n");
const alt = extractNoteWindows(altNote);
ok(alt !== null && alt.noon.max === 0.21 && alt.night.max === 0.09, "<= spelling and '12 PM' noon label parse");

// ----- 6. Fallback to the standard windows when Note 1 is unreadable -----

const noNote = [
  "CORTISOL, LC/MS, SALIVA, 4 SAMPLES",
  ...sampleBlock(1, "04/10/2026", "8:18AM", "0.32"),
  ...sampleBlock(2, "04/10/2026", "12:45PM", "0.14"),
  "Note 1",
  "8-10 AM: see laboratory",
].join("\n");
const fb = parseSalivaCortisolText(noNote);
ok(fb !== null && fb.windowsSource === "standard", "unreadable Note 1 -> standard windows");
ok(fb !== null && JSON.stringify(fb.windows) === JSON.stringify(STANDARD_SALIVA_WINDOWS), "standard windows are Quest's published set");
ok(fb !== null && fb.samples.length === 2, "partial report still returns the samples it has");

// A half-readable note never mixes printed and assumed bounds.
const halfNote = [
  "CORTISOL, LC/MS, SALIVA, 4 SAMPLES",
  "CORTISOL, SALIVA SAMPLE 1 0.32 mcg/dL See Note 1",
  "Note 1",
  "8-10 AM: 0.05-0.60 mcg/dL",
  "noon-2 PM: < or = 0.25 mcg/dL",
].join("\n");
const half = parseSalivaCortisolText(halfNote);
ok(half !== null && half.windowsSource === "standard" && half.windows.morning.max === 0.56, "two of four windows -> whole standard set, not a mix");

// ----- 7. Row variants: censored value, lab H flag, wrapped line, 24h time -----

const variants = [
  "CORTISOL, LC/MS, SALIVA, 4 SAMPLES",
  "DRAW TIME 1 0818",
  "CORTISOL, SALIVA SAMPLE 1 0.70 H mcg/dL See Note 1",
  "DRAW TIME 2 12:45 P.M.",
  "CORTISOL, SALIVA SAMPLE 2",
  "<0.02 mcg/dL See Note 1",
  "DRAW TIME 3 1705",
  "CORTISOL, SALIVA SAMPLE 3: 0.10 ug/dL",
  "CORTISOL, SALIVA SAMPLE 3: 0.99 ug/dL",
  ...NOTE,
].join("\n");
const v = parseSalivaCortisolText(variants);
ok(v !== null && v.samples.length === 3, `variant rows: 3 samples (got ${v?.samples.length})`);
if (v) {
  ok(v.samples[0].value === 0.7 && v.samples[0].drawTime === "8:18 AM", "lab H flag and 0818 time read");
  ok(v.samples[1].value === 0.02 && v.samples[1].qualifier === "<" && v.samples[1].drawTime === "12:45 PM", "wrapped censored value <0.02 read with qualifier");
  ok(v.samples[2].value === 0.1 && v.samples[2].drawTime === "5:05 PM", "ug/dL row and 1705 time read; duplicate sample 3 ignored (first wins)");
}

// ----- 8. PDF entry point: a real non-cortisol Quest PDF returns null -----

const bloodPdf = path.resolve("samples/quest/Quanum Lab Services Manager.pdf");
(async () => {
  if (fs.existsSync(bloodPdf)) {
    const res = await parseSalivaCortisolPdf(fs.readFileSync(bloodPdf));
    ok(res === null, "real blood-panel PDF -> null (not a saliva report)");
  } else {
    ok(true, "blood-panel sample PDF absent; PDF null-path skipped");
  }
  let threw = false;
  try {
    await parseSalivaCortisolPdf(Buffer.from("not a pdf"));
  } catch {
    threw = true;
  }
  ok(threw, "garbage bytes throw (the route turns this into a non-fatal note)");

  // ----- Report -----
  if (failures.length) {
    console.error(`saliva-cortisol parser: ${failures.length} failed, ${passed} passed`);
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log(`saliva-cortisol parser: ${passed} assertions passed`);
})();
