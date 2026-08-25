/**
 * POST /api/analysis/generate
 *
 * Full initial-mode Clinical Analysis:
 *   existing pipeline (parse -> match -> flag, unmodified)
 *     -> deterministic header/chart/in-range list   (lib/analysis/deterministic)
 *     -> de-identified payload                      (lib/analysis/deidentify)
 *     -> askClaudeStructured()                      (lib/analysis/llm)
 *     -> validated structured narrative             (lib/analysis/schemas + prompt)
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
import {
  buildDeterministicAnalysis,
  buildMergedComparisonGroups,
  computePriorInterval,
} from "../../../../lib/analysis/deterministic";
import {
  assertNoIdentifiers,
  buildPayload,
  buildReevalPayload,
  serializePayload,
} from "../../../../lib/analysis/deidentify";
import {
  buildInitialAnalysisPrompt,
  buildReevalPrompt,
  toAnalysisNarrative,
  toReevalNarrative,
  REEVAL_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  NarrativeParseError,
  type AnalysisNarrative,
  type ReevalNarrative,
} from "../../../../lib/analysis/prompt";
import {
  INITIAL_NARRATIVE_SCHEMA,
  REEVAL_NARRATIVE_SCHEMA,
  type InitialNarrativeJson,
  type ReevalNarrativeJson,
} from "../../../../lib/analysis/schemas";
import { askClaudeStructured, AnalysisLlmError } from "../../../../lib/analysis/llm";
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

function reevalResponse(
  buf: Buffer,
  patientNameRaw: string,
  patientDate: string,
  narrated: boolean,
  extraHeaders: Record<string, string>,
): Response {
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${reevalDownloadName(patientNameRaw, patientDate)}"`,
      "Content-Length": String(buf.length),
      "X-Analysis-Narrative": narrated ? "included" : "placeholders",
      ...extraHeaders,
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
  const priorPanelDate = (form.get("priorPanelDate") as string | null)?.trim() || "";
  const priorReviewed = (form.get("priorReviewed") as string | null) === "1";

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

    // ----- Re-evaluation -----
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

      const priorHeaders = {
        "X-Prior-Report": `${ingested.kind}; ${ingested.rawChars} chars; ${ingested.redactionCount} redactions`,
        "X-Prior-Residual-Names": String(ingested.residualNameCandidates.length),
      };

      // Deterministic scaffold only — the 2a document, on request or as the
      // recovery path after an API failure.
      if (skipNarrative) {
        const buf = await generateReevalReport(analysis, true, null, priorPanelDate);
        return reevalResponse(buf, patientNameRaw, patientDate, false, priorHeaders);
      }

      // The de-identified prior text is about to be sent. Refuse unless the
      // client confirms the practitioner reviewed exactly what goes out.
      if (!priorReviewed) {
        return NextResponse.json(
          {
            error:
              "Review the de-identified prior-report text and confirm it before generating the comparative analysis.",
            needsPriorReview: true,
            deterministicAvailable: true,
          },
          { status: 428 },
        );
      }

      const interval = computePriorInterval(priorPanelDate, analysis.header.collected);
      const payload = buildReevalPayload(flagged, {
        age: analysis.age,
        sex: analysis.sex,
        intake,
        // The TYPED name, not the "Patient" display fallback: the fallback is
        // not an identifier and collides with the payload's own `patient` key.
        patientName: patientNameRaw,
        dob,
        priorPanelInterval: interval,
        priorReportText: ingested.redactedText,
      });
      const serialized = serializePayload(payload);
      assertNoIdentifiers(serialized, { patientName: patientNameRaw, dob });

      let reeval: ReevalNarrative;
      try {
        const json = await askClaudeStructured<ReevalNarrativeJson>(
          buildReevalPrompt(payload),
          {
            system: REEVAL_SYSTEM_PROMPT,
            schema: REEVAL_NARRATIVE_SCHEMA as unknown as Record<string, unknown>,
            timeoutMs: ANALYSIS_CALL_TIMEOUT_MS,
          },
        );
        reeval = toReevalNarrative(json);
      } catch (err) {
        const message =
          err instanceof AnalysisLlmError || err instanceof NarrativeParseError
            ? err.message
            : "Unexpected error generating the comparative narrative.";
        return NextResponse.json(
          { error: message, deterministicAvailable: true },
          { status: 502 },
        );
      }

      // Prior values are the model's only numeric contribution; the trend is
      // recomputed here from prior vs current.
      const merged = {
        ...analysis,
        comparisonGroups: buildMergedComparisonGroups(flagged, reeval.priorFacts),
      };
      const buf = await generateReevalReport(merged, true, reeval, priorPanelDate);
      return reevalResponse(buf, patientNameRaw, patientDate, true, priorHeaders);
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
      // See above: the typed name, never the display fallback.
      patientName: patientNameRaw,
      dob,
    });
    const serialized = serializePayload(payload);
    assertNoIdentifiers(serialized, { patientName: patientNameRaw, dob });

    // ----- Reasoning layer -----
    let narrative: AnalysisNarrative;
    try {
      const json = await askClaudeStructured<InitialNarrativeJson>(
        buildInitialAnalysisPrompt(payload),
        {
          system: SYSTEM_PROMPT,
          schema: INITIAL_NARRATIVE_SCHEMA as unknown as Record<string, unknown>,
          timeoutMs: ANALYSIS_CALL_TIMEOUT_MS,
        },
      );
      narrative = toAnalysisNarrative(json);
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
  } catch (err) {
    // Without this, an unexpected failure reaches the practitioner as a bare
    // "Something went wrong" with nothing in the log to diagnose it.
    console.error("[analysis/generate] unexpected failure:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error && err.message
            ? `Could not build the analysis: ${err.message}`
            : "Something went wrong",
        deterministicAvailable: true,
      },
      { status: 500 },
    );
  }
}
