/**
 * POST /api/analysis/prior-preview
 *
 * Extracts and de-identifies a prior report and returns the EXACT text that
 * would be sent to the API, so the practitioner can read it before any call is
 * made. Makes no API call itself and persists nothing.
 *
 * The generate route refuses a re-eval narrative unless the client confirms it
 * showed this, so the review is a gate rather than a courtesy.
 */

import { NextResponse } from "next/server";
import {
  ingestPriorReport,
  PriorReportError,
  priorReportKind,
} from "../../../../lib/analysis/prior-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Could not read the upload." }, { status: 400 });
  }

  const priorFile = form.get("priorReport");
  const patientName = (form.get("patientName") as string | null)?.trim() || "";
  const dob = (form.get("dob") as string | null)?.trim() || "";

  if (!priorFile || typeof priorFile === "string") {
    return NextResponse.json({ error: "No prior report was uploaded." }, { status: 400 });
  }
  if (!priorReportKind(priorFile.name)) {
    return NextResponse.json(
      { error: "The prior report must be a .docx or .pdf file." },
      { status: 400 },
    );
  }
  if (priorFile.size === 0) {
    return NextResponse.json({ error: "The prior report file is empty." }, { status: 400 });
  }

  try {
    const ingested = await ingestPriorReport(
      Buffer.from(await priorFile.arrayBuffer()),
      priorFile.name,
      { patientName, dob },
    );

    return NextResponse.json(
      {
        kind: ingested.kind,
        rawChars: ingested.rawChars,
        redactedChars: ingested.redactedChars,
        redactionCount: ingested.redactionCount,
        truncated: ingested.truncated,
        residualNameCandidates: ingested.residualNameCandidates,
        // The exact string that would be embedded in the prompt.
        redactedText: ingested.redactedText,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof PriorReportError
            ? err.message
            : "Could not read the prior report.",
      },
      { status: 400 },
    );
  }
}
