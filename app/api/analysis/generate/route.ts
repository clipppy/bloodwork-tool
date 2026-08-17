/**
 * POST /api/analysis/generate
 *
 * Phase 1a: deterministic Clinical Analysis document. No LLM call.
 *
 * Accepts multipart/form-data { file: PDF, patientName?, patientDate?, intake? }
 * and reuses the EXISTING pipeline unmodified — parseQuestPdf → matchMarkers →
 * flagMarkers, the same functions /api/generate and the CLI call — then builds
 * the deterministic sections and renders the .docx.
 *
 * `intake` is accepted and deliberately unused this phase: it is read off the
 * form so the field round-trips, but it is not stored, not logged, and not sent
 * anywhere. It starts feeding the LLM sections in Phase 1b.
 *
 * No patient data is persisted: the PDF stays in a Buffer and the document is
 * streamed back.
 */

import { NextResponse } from "next/server";
import { parseQuestPdf } from "../../../../lib/parsers/quest";
import { matchMarkers } from "../../../../lib/matcher";
import { flagMarkers } from "../../../../lib/flagging";
import { buildDeterministicAnalysis } from "../../../../lib/analysis/deterministic";
import { generateAnalysisReport } from "../../../../lib/generator/analysis-word";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function downloadName(patientName: string, patientDate: string): string {
  const slug = slugify(patientName);
  if (!slug) return "clinical-analysis.docx";
  return `clinical-analysis-${slug}-${patientDate}.docx`;
}

export async function POST(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Please upload a valid PDF" }, { status: 400 });
  }

  const file = form.get("file");
  const patientNameRaw = (form.get("patientName") as string | null)?.trim() || "";
  const patientDateRaw = (form.get("patientDate") as string | null)?.trim() || "";

  const patientName = patientNameRaw || "Patient";
  const patientDate = patientDateRaw || new Date().toISOString().slice(0, 10);

  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "Please upload a valid PDF" }, { status: 400 });
  }
  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return NextResponse.json({ error: "Please upload a valid PDF" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json(
      { error: "Could not read this PDF. Please check the file and try again." },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let parsed;
  try {
    parsed = await parseQuestPdf(buffer);
  } catch {
    return NextResponse.json(
      { error: "Could not read this PDF. Please check the file and try again." },
      { status: 500 },
    );
  }

  try {
    const flagged = flagMarkers(matchMarkers(parsed.markers));
    const analysis = buildDeterministicAnalysis(flagged, {
      patientName,
      patientDate,
      collectedDate: parsed.patientMeta.collectedDate,
      reportedDate: parsed.patientMeta.reportedDate,
    });
    const docBuf = await generateAnalysisReport(analysis);

    return new NextResponse(new Uint8Array(docBuf), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${downloadName(patientNameRaw, patientDate)}"`,
        "Content-Length": String(docBuf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
