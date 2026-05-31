/**
 * Single-file orchestrator: PDF path → parse → match → flag → JSON / Word.
 *
 * Usage:
 *   npm run cli -- <pdf-path>
 *   npm run cli -- <pdf-path> --summary-only
 *   npm run cli -- <pdf-path> --unmatched-only
 *   npm run cli -- <pdf-path> --flagged-only
 *   npm run cli -- <pdf-path> --generate-word <out.docx> \
 *                 [--patient-name "Test Patient"] [--patient-date 2026-05-31]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseQuestPdf } from "../lib/parsers/quest";
import { matchMarkers, type MatchedMarker } from "../lib/matcher";
import { flagMarkers, isFlagged, type FlaggedMarker } from "../lib/flagging";
import { generateWordReport } from "../lib/generator/word";

function usage(): never {
  console.error(
    "Usage: npm run cli -- <pdf-path> [--summary-only] [--unmatched-only] [--flagged-only] " +
      "[--generate-word <out.docx>] [--patient-name <name>] [--patient-date <date>]",
  );
  process.exit(2);
}

interface ParsedArgs {
  pdfPath: string;
  summaryOnly: boolean;
  unmatchedOnly: boolean;
  flaggedOnly: boolean;
  generateWord: string | null;
  patientName: string;
  patientDate: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let summaryOnly = false;
  let unmatchedOnly = false;
  let flaggedOnly = false;
  let generateWord: string | null = null;
  let patientName = "Patient";
  let patientDate = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--summary-only":
        summaryOnly = true;
        break;
      case "--unmatched-only":
        unmatchedOnly = true;
        break;
      case "--flagged-only":
        flaggedOnly = true;
        break;
      case "--generate-word":
        generateWord = argv[++i];
        if (!generateWord) usage();
        break;
      case "--patient-name":
        patientName = argv[++i];
        if (patientName === undefined) usage();
        break;
      case "--patient-date":
        patientDate = argv[++i];
        if (patientDate === undefined) usage();
        break;
      default:
        if (a.startsWith("--")) usage();
        positional.push(a);
    }
  }
  if (positional.length !== 1) usage();
  return {
    pdfPath: positional[0],
    summaryOnly,
    unmatchedOnly,
    flaggedOnly,
    generateWord,
    patientName,
    patientDate,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.pdfPath)) {
    console.error(`File not found: ${args.pdfPath}`);
    process.exit(2);
  }

  const buf = fs.readFileSync(args.pdfPath);
  const parsed = await parseQuestPdf(buf);
  const matched = matchMarkers(parsed.markers);
  const flagged = flagMarkers(matched);

  const summary = {
    pdf: args.pdfPath,
    totalParsed: parsed.markers.length,
    totalMatched: matched.filter((m) => m.matchStatus === "matched").length,
    totalUnmatched: matched.filter((m) => m.matchStatus === "unmatched").length,
    totalAmbiguous: matched.filter((m) => m.matchStatus === "ambiguous").length,
    totalConfirmationPending: matched.filter((m) => m.confirmationPending).length,
    totalFuzzy: matched.filter(
      (m) => m.matchConfidence === "fuzzy" && m.matchStatus === "matched",
    ).length,
    flag: {
      optimal: flagged.filter((f) => f.flagStatus === "optimal").length,
      high: flagged.filter((f) => f.flagStatus === "high").length,
      low: flagged.filter((f) => f.flagStatus === "low").length,
      moderate: flagged.filter((f) => f.flagStatus === "moderate").length,
      out_of_range: flagged.filter((f) => f.flagStatus === "out_of_range").length,
      not_flaggable: flagged.filter((f) => f.flagStatus === "not_flaggable").length,
      informational: flagged.filter((f) => f.flagStatus === "informational").length,
    },
  };

  console.error(
    `parsed=${summary.totalParsed} matched=${summary.totalMatched} unmatched=${summary.totalUnmatched} ambiguous=${summary.totalAmbiguous} fuzzy=${summary.totalFuzzy} | optimal=${summary.flag.optimal} high=${summary.flag.high} low=${summary.flag.low} moderate=${summary.flag.moderate} out_of_range=${summary.flag.out_of_range} not_flaggable=${summary.flag.not_flaggable} informational=${summary.flag.informational}  [${args.pdfPath}]`,
  );

  if (args.generateWord) {
    const docBuf = await generateWordReport(flagged, {
      patientName: args.patientName,
      patientDate: args.patientDate,
    });
    const outPath = path.resolve(args.generateWord);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, docBuf);
    console.error(`wrote ${docBuf.length} bytes → ${outPath}`);
    return;
  }

  if (args.summaryOnly) return;

  let payload: MatchedMarker[] | FlaggedMarker[];
  if (args.unmatchedOnly) {
    payload = matched.filter((m) => m.matchStatus !== "matched");
  } else if (args.flaggedOnly) {
    payload = flagged.filter(isFlagged);
  } else {
    payload = flagged;
  }
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
