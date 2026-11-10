/**
 * Multi-PDF composite panel (lib/analysis/merge-panels). Same house pattern:
 * a self-contained tsx script with a local ok(), non-zero exit on failure.
 *
 * Two small Quest reports (verbatim Quest classic layout, synthetic values)
 * with overlapping markers are parsed from text, built into panels and
 * merged; the composite is then run through the deterministic layer, the
 * payload guard and the Word generator.
 *
 * Run: npx tsx lib/analysis/merge-panels.test.ts  (or: npm run test:merge-panels)
 */

import JSZip from "jszip";
import { parseQuestText } from "../parsers/quest";
import { matchMarkers } from "../matcher";
import { flagMarkers } from "../flagging";
import {
  buildPanel,
  formatSourcesLine,
  mergePanels,
  resolveDrawCycle,
  sourceOf,
  earlierReadingsOf,
  toISODate,
  unreadableNotice,
  MIN_MARKERS_PER_FILE,
} from "./merge-panels";
import { dedupeRepeatedMarkers } from "./dedupe";
import { buildDeterministicAnalysis } from "./deterministic";
import { applyHormoneOverlay, computeCycleDay } from "./hormone-ranges";
import { assertNoIdentifiers, buildPayload, serializePayload } from "./deidentify";
import { generateAnalysisReport } from "../generator/analysis-word";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else failures.push(`  x ${msg}`);
}
const eq = (actual: unknown, expected: unknown, label: string) =>
  ok(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

/** A minimal Quest classic-layout report: the header lines the parser reads
 *  the lab and dates from, then one marker row per line. */
function questReport(collected: string, reported: string, rows: string[]): string {
  return [
    "Report Status: Final",
    "Patient Information",
    `Collected: ${collected} / 08:10 EDT`,
    `Reported: ${reported} / 16:55 EDT`,
    "Test Name In Range Out Of Range Reference Range Lab",
    ...rows,
    "Quest, Quest Diagnostics, the associated logo, Nichols Institute, Interactive Insights and all associated Quest Diagnostics marks are the registered trademarks of Quest Diagnostics.",
  ].join("\n");
}

// The older draw carries the hormone panel; the newer one re-tests glucose
// and albumin and adds ferritin.
const OLDER = questReport("06/02/2026", "06/04/2026", [
  "GLUCOSE 92 65-99 mg/dL NL1",
  "ALBUMIN 4.1 3.6-5.1 g/dL NL1",
  "HEMOGLOBIN 13.8 11.1-15.9 g/dL NL1",
  "ESTRADIOL 48 pg/mL EZ",
  "TESTOSTERONE, TOTAL, MS 22 2-45 ng/dL AMD",
]);
const NEWER = questReport("06/14/2026", "06/16/2026", [
  "GLUCOSE 85 65-99 mg/dL NL1",
  "ALBUMIN 4.3 3.6-5.1 g/dL NL1",
  "FERRITIN 30 16-232 ng/mL NL1",
  "PLATELETS 250 140-400 Thousand/uL NL1",
]);
const NOT_A_LAB_REPORT = [
  "Thank you for your order.",
  "Your receipt total is 42.00 and your order number is 7.",
  "No laboratory results are printed on this page.",
].join("\n");

const INPUTS = {
  patientName: "Jane Q Doe",
  patientDate: "2026-06-20",
  dob: "1980-01-02",
  sex: "female",
};

async function documentXml(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  return (await zip.file("word/document.xml")!.async("string"))
    // docx stamps a creation time into the package; the body is what matters.
    .replace(/<w:document[^>]*>/, "<w:document>");
}

function twoReportsMostRecentWins() {
  const older = buildPanel(parseQuestText(OLDER), "june-02.pdf", 0, "female");
  const newer = buildPanel(parseQuestText(NEWER), "june-14.pdf", 1, "female");
  ok(!!older.panel && !!newer.panel, "both reports parse into panels");
  if (!older.panel || !newer.panel) return;

  eq(older.panel.source.lab, "Quest", "lab read from the report");
  eq(older.panel.source.collectedDate, "06/02/2026", "collection date read from the report");
  eq(newer.panel.source.collectedDate, "06/14/2026", "second collection date");
  ok(older.panel.hasHormonePanel, "the older file carries the hormone panel");
  ok(!newer.panel.hasHormonePanel, "the newer file does not");
  ok(older.panel.markers.every((m) => sourceOf(m)?.filename === "june-02.pdf"), "every marker carries its file");

  // Upload order is newer-first to prove the DATE decides, not the order.
  const composite = mergePanels([newer.panel, older.panel]);
  const byName = new Map(composite.markers.map((m) => [m.canonicalName, m]));

  const glucose = byName.get("Glucose")!;
  eq(glucose.value, 85, "Glucose: the most recent draw's value is current");
  eq(sourceOf(glucose)?.collectedDate, "06/14/2026", "...tagged with the newer source");
  eq(earlierReadingsOf(glucose).length, 1, "...with the older reading attached");
  eq(earlierReadingsOf(glucose)[0]?.value, 92, "...the older reading is 92");
  eq(earlierReadingsOf(glucose)[0]?.source.collectedDate, "06/02/2026", "...from the older draw");
  eq(byName.get("Albumin")?.value, 4.3, "Albumin: most recent wins");
  eq(byName.get("Hemoglobin")?.value, 13.8, "a marker only in the older file is kept");
  eq(byName.get("Ferritin")?.value, 30, "a marker only in the newer file is kept");
  eq(composite.markers.filter((m) => m.canonicalName === "Glucose").length, 1, "one Glucose row");
  eq(composite.markers.filter((m) => m.canonicalName === "Albumin").length, 1, "one Albumin row");
  ok(composite.multiSource, "two dates -> multi-source composite");
  eq(composite.collectedDate, "06/14/2026", "composite collection date is the most recent");
  eq(composite.reportedDate, "06/16/2026 / 16:55 EDT", "reported date follows the most recent file");
  eq(composite.hormoneDrawDate, "06/02/2026", "the hormone file's date anchors the cycle day");
  eq(composite.sources.length, 2, "both sources listed");
  eq(formatSourcesLine([older.panel.source, newer.panel.source]), "Quest 06/02/2026 · Quest 06/14/2026", "header line lists both");
  eq(
    formatSourcesLine([older.panel.source, { ...older.panel.source, index: 2, filename: "dup.pdf" }]),
    "Quest 06/02/2026 (2 reports)",
    "same lab and date collapse with a count",
  );

  // Through the overlay and the deterministic layer: tags on every row.
  const overlay = applyHormoneOverlay(composite.markers, {
    sex: "female",
    status: "early_follicular",
    cycleLength: null,
    cycleDay: null,
  });
  const analysis = buildDeterministicAnalysis(overlay.markers, {
    ...INPUTS,
    collectedDate: composite.collectedDate,
    reportedDate: composite.reportedDate,
    hormone: overlay.summary,
    sources: composite.sources,
    multiSource: composite.multiSource,
    spansYears: composite.spansYears,
    sourceNotices: [],
  });
  eq(analysis.header.collected, "Blood: Quest 06/14/2026 · Quest 06/02/2026", "header lists every source in upload order");
  const rows = [...analysis.rows, ...analysis.optimalRows];
  ok(rows.length > 0 && rows.every((r) => r.sourceTag !== null), "every chart row carries a source tag");
  const glucoseRow = rows.find((r) => r.marker === "Glucose")!;
  eq(glucoseRow.sourceTag, "Quest · 06/14", "compact tag: lab · MM/DD");
  eq(glucoseRow.earlier, "earlier 92 mg/dL · Quest · 06/02", "earlier reading shown as a secondary note");
  eq(rows.find((r) => r.marker === "Hemoglobin")?.sourceTag, "Quest · 06/02", "older-only marker tagged with its own date");
  eq(rows.find((r) => r.marker === "Hemoglobin")?.earlier, null, "no earlier note without an earlier reading");
  ok(analysis.multiSource, "analysis records the multi-source state");

  // Tiering uses the current value only: Glucose 85 is inside 80-95 (green).
  ok(analysis.optimalRows.some((r) => r.marker === "Glucose"), "Glucose 85 tiers on the current value (optimal)");

  // De-identification: lab names and dates are context, not identifiers, and
  // the payload shape is unchanged — the guard still passes.
  const payload = buildPayload(overlay.markers, {
    age: analysis.age,
    sex: analysis.sex,
    intake: "",
    patientName: INPUTS.patientName,
    dob: INPUTS.dob,
    hormone: analysis.hormone,
  });
  let guardThrew = false;
  try {
    assertNoIdentifiers(serializePayload(payload), { patientName: INPUTS.patientName, dob: INPUTS.dob });
  } catch {
    guardThrew = true;
  }
  ok(!guardThrew, "payload guard passes with multi-file input");
  ok(!JSON.stringify(payload).includes("june-02.pdf"), "filenames never reach the payload");

  // The document prints the tags and the earlier reading, and the header line.
  return generateAnalysisReport(analysis, null)
    .then(documentXml)
    .then((xml) => {
      ok(xml.includes("Quest · 06/14"), "document prints the newer source tag");
      ok(xml.includes("Quest · 06/02"), "document prints the older source tag");
      ok(xml.includes("earlier 92 mg/dL · Quest · 06/02"), "document prints the earlier reading");
      ok(xml.includes("Blood: Quest 06/14/2026 · Quest 06/02/2026"), "document header lists both sources");
    });
}

async function singleFileRendersAsBefore() {
  const parsed = parseQuestText(NEWER);
  // The direct (pre-feature) path: parse -> match -> flag -> dedupe.
  const direct = dedupeRepeatedMarkers(flagMarkers(matchMarkers(parsed.markers), { sex: "female" }));
  const directAnalysis = buildDeterministicAnalysis(direct, {
    ...INPUTS,
    collectedDate: parsed.patientMeta.collectedDate,
    reportedDate: parsed.patientMeta.reportedDate,
  });

  // The composite path with one file.
  const built = buildPanel(parsed, "june-14.pdf", 0, "female");
  ok(!!built.panel, "single file builds a panel");
  if (!built.panel) return;
  const composite = mergePanels([built.panel]);
  ok(!composite.multiSource, "one file -> not multi-source");
  eq(composite.markers.length, built.panel.markers.length, "one file -> its own marker list");
  const compositeAnalysis = buildDeterministicAnalysis(composite.markers, {
    ...INPUTS,
    collectedDate: composite.collectedDate,
    reportedDate: composite.reportedDate,
    sources: composite.sources,
    multiSource: composite.multiSource,
    spansYears: composite.spansYears,
    sourceNotices: [],
  });
  eq(compositeAnalysis.header.collected, "06/14/2026", "single file: header prints the draw date as before");
  eq(compositeAnalysis.header.collected, directAnalysis.header.collected, "single file: header identical to the direct path");
  ok(
    [...compositeAnalysis.rows, ...compositeAnalysis.optimalRows].every((r) => r.sourceTag === null && r.earlier === null),
    "single file: no row carries a source tag",
  );

  const [directXml, compositeXml] = await Promise.all([
    generateAnalysisReport(directAnalysis, null).then(documentXml),
    generateAnalysisReport(compositeAnalysis, null).then(documentXml),
  ]);
  ok(directXml === compositeXml, "single file: document body is byte-identical to the direct path");
}

async function unreadableFileIsANoticeNotAFailure() {
  const bad = buildPanel(parseQuestText(NOT_A_LAB_REPORT), "receipt.pdf", 1, "female");
  ok(!bad.panel && !!bad.notice, "a file with no markers yields a notice, not a panel");
  eq(bad.notice?.message, unreadableNotice("receipt.pdf"), "notice wording");
  ok(/Couldn't read receipt\.pdf/.test(bad.notice?.message ?? ""), "notice names the file");
  ok(MIN_MARKERS_PER_FILE >= 1, "threshold is at least one marker");

  const good = buildPanel(parseQuestText(NEWER), "june-14.pdf", 0, "female");
  if (!good.panel || !bad.notice) return;
  const composite = mergePanels([good.panel], [bad.notice]);
  eq(composite.markers.length, good.panel.markers.length, "the run continues with the readable file");
  eq(composite.notices.length, 1, "the notice is carried on the composite");

  const analysis = buildDeterministicAnalysis(composite.markers, {
    ...INPUTS,
    collectedDate: composite.collectedDate,
    reportedDate: composite.reportedDate,
    sources: composite.sources,
    multiSource: composite.multiSource,
    spansYears: composite.spansYears,
    sourceNotices: composite.notices.map((n) => n.message),
  });
  eq(analysis.sourceNotices.length, 1, "the analysis carries the notice");
  const xml = await generateAnalysisReport(analysis, null).then(documentXml);
  ok(xml.includes("Couldn&apos;t read receipt.pdf") || xml.includes("Couldn't read receipt.pdf"), "the document prints the notice");
  ok(xml.includes("continued with the reports that could be read"), "...and says the run continued");
}

function cycleDayUsesTheHormoneFilesDate() {
  const lmp = "2026-05-20";
  const hormoneDraw = "06/02/2026";
  const newestDraw = "06/14/2026";
  const expected = computeCycleDay(lmp, toISODate(hormoneDraw)!)!;
  const clientDay = computeCycleDay(lmp, toISODate(newestDraw)!)!;
  ok(expected !== clientDay, "fixture: the two draw dates give different cycle days");

  const r = resolveDrawCycle({
    lmpDate: lmp,
    typedCycleDay: null,
    clientCycleDay: clientDay,
    cycleLength: 28,
    status: "luteal", // what the form derived from the newer date
    statusDerived: true,
    drawDateISO: toISODate(hormoneDraw),
  });
  eq(r.cycleDay, expected, "cycle day is counted against the hormone file's draw date");
  ok(r.recomputed, "...and reported as recomputed");
  eq(r.status, "ovulatory", "a derived status follows the recomputed day (day 14 of 28)");

  // A typed cycle day always wins.
  const typed = resolveDrawCycle({ lmpDate: lmp, typedCycleDay: 5, clientCycleDay: 5, cycleLength: 28, status: "early_follicular", statusDerived: true, drawDateISO: toISODate(hormoneDraw) });
  eq(typed.cycleDay, 5, "typed cycle day wins");
  eq(typed.status, "early_follicular", "typed: status untouched");
  // A hand-picked status is never overridden.
  const manual = resolveDrawCycle({ lmpDate: lmp, typedCycleDay: null, clientCycleDay: clientDay, cycleLength: 28, status: "luteal", statusDerived: false, drawDateISO: toISODate(hormoneDraw) });
  eq(manual.cycleDay, expected, "manual status: the day is still recounted");
  eq(manual.status, "luteal", "manual status: the status is kept");
  const post = resolveDrawCycle({ lmpDate: lmp, typedCycleDay: null, clientCycleDay: clientDay, cycleLength: 28, status: "postmenopausal", statusDerived: true, drawDateISO: toISODate(hormoneDraw) });
  eq(post.status, "postmenopausal", "a non-cycling status is never overridden");
  // No LMP, or no draw date: the form's values stand.
  eq(resolveDrawCycle({ lmpDate: null, typedCycleDay: null, clientCycleDay: 9, cycleLength: 28, status: "mid_follicular", statusDerived: true, drawDateISO: toISODate(hormoneDraw) }).cycleDay, 9, "no LMP: form's day stands");
  eq(resolveDrawCycle({ lmpDate: lmp, typedCycleDay: null, clientCycleDay: 9, cycleLength: 28, status: "mid_follicular", statusDerived: true, drawDateISO: null }).cycleDay, 9, "no draw date: form's day stands");
}

async function main() {
  await twoReportsMostRecentWins();
  await singleFileRendersAsBefore();
  await unreadableFileIsANoticeNotAFailure();
  cycleDayUsesTheHormoneFilesDate();

  if (failures.length) {
    console.error(`\nmerge-panels: ${failures.length} FAILED, ${passed} passed\n`);
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(`merge-panels: all ${passed} assertions passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
