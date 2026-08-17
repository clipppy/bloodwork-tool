/**
 * POST /api/analysis/generate
 *
 * Full initial-mode Clinical Analysis:
 *   existing pipeline (parse -> match -> flag, unmodified)
 *     -> deterministic header/chart/in-range list   (lib/analysis/deterministic)
 *     -> de-identified payload                      (lib/analysis/deidentify)
 *     -> askClaude()                                (lib/analysis/llm)
 *     -> parsed narrative sections                  (lib/analysis/prompt)
 *     -> .docx                                      (lib/generator/analysis-word)
 *
 * Identifiers: the patient name and DOB are used only to render the header
 * locally and to redact the intake text. The payload that leaves this process is
 * built from an allow-list and re-scanned by assertNoIdentifiers() before the
 * network call.
 *
 * LLM failure never loses the deterministic work: the response carries
 * `deterministicAvailable: true`, and a retry with skipNarrative=1 returns the
 * same document with labelled placeholders where the narrative would sit.
 *
 * Nothing is persisted: the PDF stays in a Buffer, the document is streamed back.
 */

import { NextResponse } from "next/server";
import { parseQuestPdf } from "../../../../lib/parsers/quest";
import { matchMarkers } from "../../../../lib/matcher";
import { flagMarkers } from "../../../../lib/flagging";
import { buildDeterministicAnalysis } from "../../../../lib/analysis/deterministic";
import {
  assertNoIdentifiers,
  buildPayload,
  serializePayload,
} from "../../../../lib/analysis/deidentify";
import {
  buildInitialAnalysisPrompt,
  parseNarrative,
  SYSTEM_PROMPT,
  NarrativeParseError,
  type AnalysisNarrative,
} from "../../../../lib/analysis/prompt";
import { askClaude, AnalysisLlmError } from "../../../../lib/analysis/llm";
import {
  ingestPriorReport,
  PriorReportError,
  priorReportKind,
} from "../../../../lib/analysis/prior-report";
import {
  generateAnalysisReport,
  generateReevalReport,
} from "../../../../lib/generator/analysis-word";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The analysis is a long generation; give it more room than the default. */
const ANALYSIS_CALL_TIMEOUT_MS = 300_000;

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

function reevalDownloadName(patientName: string, patientDate: string): string {
  const slug = slugify(patientName);
  if (!slug) return "clinical-analysis-reeval.docx";
  return `clinical-analysis-reeval-${slug}-${patientDate}.docx`;
}

function docxResponse(buf: Buffer, filename: string, narrated: boolean): Response {
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buf.length),
      "X-Analysis-Narrative": narrated ? "included" : "placeholders",
      "Cache-Control": "no-store",
    },
  });
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
  const dob = (form.get("dob") as string | null)?.trim() || "";
  const sex = (form.get("sex") as string | null)?.trim() || "";
  const intake = (form.get("intake") as string | null) || "";
  const skipNarrative = (form.get("skipNarrative") as string | null) === "1";
  const mode = (form.get("mode") as string | null) === "reeval" ? "reeval" : "initial";
  const priorFile = form.get("priorReport");

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

  // ----- Re-eval mode requires a readable prior report -----
  if (mode === "reeval") {
    if (!priorFile || typeof priorFile === "string") {
      return NextResponse.json(
        { error: "Re-evaluation mode needs the prior report (.docx or .pdf)." },
        { status: 400 },
      );
    }
    if (!priorReportKind(priorFile.name)) {
      return NextResponse.json(
        { error: "The prior report must be a .docx or .pdf file." },
        { status: 400 },
      );
    }
    if (priorFile.size === 0) {
      return NextResponse.json(
        { error: "The prior report file is empty." },
        { status: 400 },
      );
    }
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

  // ----- Deterministic half (never depends on the API) -----
  let analysis;
  try {
    const flagged = flagMarkers(matchMarkers(parsed.markers));
    analysis = buildDeterministicAnalysis(flagged, {
      patientName,
      patientDate,
      dob,
      sex,
      collectedDate: parsed.patientMeta.collectedDate,
      reportedDate: parsed.patientMeta.reportedDate,
    });

    // ----- Re-evaluation (Phase 2a): deterministic scaffold, no LLM call -----
    if (mode === "reeval") {
      const pf = priorFile as File;
      let ingested;
      try {
        ingested = await ingestPriorReport(
          Buffer.from(await pf.arrayBuffer()),
          pf.name,
          { patientName, dob },
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

      // The redacted text is carried no further this phase: the comparative
      // pass (2b) is what sends it. Sizes only, never content.
      const buf = await generateReevalReport(analysis, true);
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="${reevalDownloadName(patientNameRaw, patientDate)}"`,
          "Content-Length": String(buf.length),
          "X-Analysis-Narrative": "placeholders",
          "X-Prior-Report": `${ingested.kind}; ${ingested.rawChars} chars; ${ingested.redactionCount} redactions`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (skipNarrative) {
      const buf = await generateAnalysisReport(analysis, null);
      return docxResponse(buf, downloadName(patientNameRaw, patientDate), false);
    }

    // ----- De-identified payload -----
    const payload = buildPayload(flagged, {
      age: analysis.age,
      sex: analysis.sex,
      intake,
      patientName,
      dob,
    });
    const serialized = serializePayload(payload);
    assertNoIdentifiers(serialized, { patientName, dob });

    // ----- Reasoning layer -----
    let narrative: AnalysisNarrative;
    try {
      const response = await askClaude(buildInitialAnalysisPrompt(payload), {
        system: SYSTEM_PROMPT,
        timeoutMs: ANALYSIS_CALL_TIMEOUT_MS,
      });
      narrative = parseNarrative(response);
    } catch (err) {
      const message =
        err instanceof AnalysisLlmError || err instanceof NarrativeParseError
          ? err.message
          : "Unexpected error generating the clinical narrative.";
      // The deterministic document is still fully available — tell the UI so it
      // can offer it rather than losing the run.
      return NextResponse.json(
        { error: message, deterministicAvailable: true },
        { status: 502 },
      );
    }

    const buf = await generateAnalysisReport(analysis, narrative);
    return docxResponse(buf, downloadName(patientNameRaw, patientDate), true);
  } catch {
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
