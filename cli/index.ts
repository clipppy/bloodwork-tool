/**
 * Single-file orchestrator: PDF path → parse → match → JSON.
 *
 * Usage:
 *   npm run cli -- <pdf-path>
 *   npm run cli -- <pdf-path> --summary-only
 *   npm run cli -- <pdf-path> --unmatched-only
 */

import * as fs from "node:fs";
import { parseQuestPdf } from "../lib/parsers/quest";
import { matchMarkers, type MatchedMarker } from "../lib/matcher";

function usage(): never {
  console.error(
    "Usage: npm run cli -- <pdf-path> [--summary-only] [--unmatched-only]",
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

  const summary = {
    pdf: pdfPath,
    totalParsed: parsed.markers.length,
    totalMatched: matched.filter((m) => m.matchStatus === "matched").length,
    totalUnmatched: matched.filter((m) => m.matchStatus === "unmatched").length,
    totalAmbiguous: matched.filter((m) => m.matchStatus === "ambiguous").length,
    totalConfirmationPending: matched.filter((m) => m.confirmationPending).length,
    totalFuzzy: matched.filter((m) => m.matchConfidence === "fuzzy" && m.matchStatus === "matched").length,
  };

  console.error(`parsed=${summary.totalParsed} matched=${summary.totalMatched} unmatched=${summary.totalUnmatched} ambiguous=${summary.totalAmbiguous} confirmation_pending=${summary.totalConfirmationPending} fuzzy=${summary.totalFuzzy}  [${pdfPath}]`);

  if (flags.has("--summary-only")) return;

  let payload: MatchedMarker[];
  if (flags.has("--unmatched-only")) {
    payload = matched.filter((m) => m.matchStatus !== "matched");
  } else {
    payload = matched;
  }
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
