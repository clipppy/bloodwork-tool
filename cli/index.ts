/**
 * Single-file orchestrator: PDF path → parse → match → flag → JSON.
 *
 * Usage:
 *   npm run cli -- <pdf-path>
 *   npm run cli -- <pdf-path> --summary-only
 *   npm run cli -- <pdf-path> --unmatched-only
 *   npm run cli -- <pdf-path> --flagged-only
 */

import * as fs from "node:fs";
import { parseQuestPdf } from "../lib/parsers/quest";
import { matchMarkers, type MatchedMarker } from "../lib/matcher";
import { flagMarkers, isFlagged, type FlaggedMarker } from "../lib/flagging";

function usage(): never {
  console.error(
    "Usage: npm run cli -- <pdf-path> [--summary-only] [--unmatched-only] [--flagged-only]",
  );
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length !== 1) usage();
  const pdfPath = positional[0];
  if (!fs.existsSync(pdfPath)) {
    console.error(`File not found: ${pdfPath}`);
    process.exit(2);
  }

  const buf = fs.readFileSync(pdfPath);
  const parsed = await parseQuestPdf(buf);
  const matched = matchMarkers(parsed.markers);
  const flagged = flagMarkers(matched);

  const summary = {
    pdf: pdfPath,
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
    `parsed=${summary.totalParsed} matched=${summary.totalMatched} unmatched=${summary.totalUnmatched} ambiguous=${summary.totalAmbiguous} fuzzy=${summary.totalFuzzy} | optimal=${summary.flag.optimal} high=${summary.flag.high} low=${summary.flag.low} moderate=${summary.flag.moderate} out_of_range=${summary.flag.out_of_range} not_flaggable=${summary.flag.not_flaggable} informational=${summary.flag.informational}  [${pdfPath}]`,
  );

  if (flags.has("--summary-only")) return;

  let payload: MatchedMarker[] | FlaggedMarker[];
  if (flags.has("--unmatched-only")) {
    payload = matched.filter((m) => m.matchStatus !== "matched");
  } else if (flags.has("--flagged-only")) {
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
