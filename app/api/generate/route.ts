/**
 * POST /api/generate
 *
 * Accepts multipart/form-data { file: PDF, patientName?: string, patientDate?: string }
 * and runs the existing CLI pipeline (parse → match → flag → Word generator)
 * entirely in memory. Returns the generated .docx as a binary download.
 *
 * No patient data is persisted: the uploaded PDF stays in a Buffer, the
 * generated document is returned and never written to disk. The route does
 * NOT reimplement any pipeline logic — it imports the same functions the CLI
 * uses from lib/.
 */

import { NextResponse } from "next/server";
import { parseQuestPdf } from "../../../lib/parsers/quest";
import { matchMarkers } from "../../../lib/matcher";
import { flagMarkers } from "../../../lib/flagging";
import { generateWordReport } from "../../../lib/generator/word";

// pdf parsing needs the Node runtime (not Edge). Never cache.
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
  if (!slug) return "lab-report.docx";
  return `lab-report-${slug}-${patientDate}.docx`;
}

export async function POST(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Please upload a valid PDF" },
      { status: 400 },
    );
  }

  const file = form.get("file");
  const patientNameRaw = (form.get("patientName") as string | null)?.trim() || "";
  const patientDateRaw = (form.get("patientDate") as string | null)?.trim() || "";

  // Generator requires non-empty values; mirror the CLI defaults.
  const patientName = patientNameRaw || "Patient";
  const patientDate = patientDateRaw || new Date().toISOString().slice(0, 10);

  // ----- Validate the upload is a non-empty PDF -----
  if (!file || typeof file === "string") {
    return NextResponse.json(
      { error: "Please upload a valid PDF" },
      { status: 400 },
    );
  }
  const isPdf =
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    return NextResponse.json(
      { error: "Please upload a valid PDF" },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json(
      { error: "Could not read this PDF. Please check the file and try again." },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // ----- Parse (isolate parser failures for a friendly message) -----
  let parsed;
  try {
    parsed = await parseQuestPdf(buffer);
  } catch {
    return NextResponse.json(
      { error: "Could not read this PDF. Please check the file and try again." },
      { status: 500 },
    );
  }

  // ----- Match → flag → generate -----
  try {
    const matched = matchMarkers(parsed.markers);
    const flagged = flagMarkers(matched);
    const docBuf = await generateWordReport(flagged, { patientName, patientDate });

    return new NextResponse(new Uint8Array(docBuf), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        // Filename slug uses the raw (user-typed) name so a blank name falls
        // back to "lab-report.docx" — even though the doc's patient line
        // still shows the generator default ("Patient").
        "Content-Disposition": `attachment; filename="${downloadName(patientNameRaw, patientDate)}"`,
        "Content-Length": String(docBuf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 },
    );
  }
}
