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
import { parseLabReport } from "../../../../lib/parsers/dispatch";
import type { ParseResult } from "../../../../lib/parsers/types";
import {
  buildDeterministicAnalysis,
  buildMergedComparisonGroups,
  computePriorInterval,
} from "../../../../lib/analysis/deterministic";
import {
  buildPanel,
  mergePanels,
  resolveDrawCycle,
  toISODate,
  unreadableNotice,
  type BloodPanel,
  type PanelNotice,
} from "../../../../lib/analysis/merge-panels";
import {
  applyHormoneOverlay,
  parseHormoneStatus,
  resolveCycleLength,
} from "../../../../lib/analysis/hormone-ranges";
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
  initialNarrativeSchema,
  reevalNarrativeSchema,
  type InitialNarrativeJson,
  type ReevalNarrativeJson,
} from "../../../../lib/analysis/schemas";
import { askClaudeStructured, AnalysisLlmError } from "../../../../lib/analysis/llm";
import { parseSalivaCortisolPdf } from "../../../../lib/parsers/saliva-cortisol";
import {
  flagSalivaCortisol,
  type SalivaCortisolFlags,
} from "../../../../lib/analysis/saliva-cortisol";
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

/** Non-fatal messages for a saliva cortisol upload the tool could not use.
 *  Printed in the document and sent back in the X-Saliva-Cortisol header. */
const SALIVA_NOT_RECOGNISED =
  "The uploaded saliva cortisol file was not recognised as a Quest saliva cortisol report (no CORTISOL, SALIVA sample rows found), so the analysis continued without it.";
const SALIVA_UNREADABLE =
  "The uploaded saliva cortisol file could not be read as a PDF, so the analysis continued without it.";

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

function docxResponse(
  buf: Buffer,
  filename: string,
  narrated: boolean,
  extraHeaders: Record<string, string> = {},
): Response {
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buf.length),
      "X-Analysis-Narrative": narrated ? "included" : "placeholders",
      ...extraHeaders,
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

  // One or more blood reports, every one appended under the same "file" key.
  const files = form
    .getAll("file")
    .filter((f): f is File => typeof f !== "string" && !!f);
  const patientNameRaw = (form.get("patientName") as string | null)?.trim() || "";
  const patientDateRaw = (form.get("patientDate") as string | null)?.trim() || "";
  const dob = (form.get("dob") as string | null)?.trim() || "";
  const sex = (form.get("sex") as string | null)?.trim() || "";
  // Cycle phase / menopausal status. Clinical context, not an identifier;
  // unrecognised or missing values read as "Not sure" (no phase ranges).
  const hormoneStatus = parseHormoneStatus(form.get("hormoneStatus"));
  // Cycle timing the phase was derived from (female only; blank otherwise).
  // Clinical context for the overlay's patient-facing timing note; the
  // overlay itself validates both (blank / out-of-band length reads as 28).
  const cycleLength = (form.get("cycleLength") as string | null)?.trim() || null;
  const cycleDay = (form.get("cycleDay") as string | null)?.trim() || null;
  // With several reports there is no single draw date, so the LMP count is
  // redone here against the hormone file's own collection date. The LMP is
  // clinical context used only on this machine; it never reaches the model.
  const lmpDate = (form.get("lmpDate") as string | null)?.trim() || null;
  const cycleDayTyped = (form.get("cycleDayTyped") as string | null) === "1";
  const statusDerived = (form.get("statusDerived") as string | null) === "1";
  const intake = (form.get("intake") as string | null) || "";
  const skipNarrative = (form.get("skipNarrative") as string | null) === "1";
  const mode = (form.get("mode") as string | null) === "reeval" ? "reeval" : "initial";
  const priorFile = form.get("priorReport");
  const priorPanelDate = (form.get("priorPanelDate") as string | null)?.trim() || "";
  const priorReviewed = (form.get("priorReviewed") as string | null) === "1";
  // Optional 4-point salivary cortisol report (a separate Quest PDF). Read
  // and reduced to de-identified facts below; never fatal to the blood run.
  const salivaFile = form.get("salivaCortisol");

  const patientName = patientNameRaw || "Patient";
  const patientDate = patientDateRaw || new Date().toISOString().slice(0, 10);

  if (!files.length) {
    return NextResponse.json({ error: "Please upload a valid PDF" }, { status: 400 });
  }
  for (const f of files) {
    const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      return NextResponse.json(
        { error: files.length === 1 ? "Please upload a valid PDF" : `${f.name} is not a PDF` },
        { status: 400 },
      );
    }
    if (f.size === 0) {
      return NextResponse.json(
        {
          error:
            files.length === 1
              ? "Could not read this PDF. Please check the file and try again."
              : `${f.name} is empty. Please check the file and try again.`,
        },
        { status: 400 },
      );
    }
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

  // Sex is collected on the analysis form, so markers whose lab reference is
  // printed per sex (leptin) can be flagged against the right row. The data
  // report has no sex field and deliberately stays display-only for those.
  const flaggingSex =
    sex.toLowerCase() === "male" ? "male" : sex.toLowerCase() === "female" ? "female" : null;

  // ----- Parse every blood report; a file that cannot be read is a notice,
  // never a failure, as long as at least one file parsed. -----
  const panels: BloodPanel[] = [];
  const notices: PanelNotice[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let parsed: ParseResult | null = null;
    try {
      parsed = await parseLabReport(Buffer.from(await f.arrayBuffer()));
    } catch {
      parsed = null;
    }
    if (!parsed) {
      notices.push({ filename: f.name, message: unreadableNotice(f.name) });
      continue;
    }
    // match -> flag -> same-file dedupe, with the file's lab / date / name
    // on every marker. The hormone overlay runs once, over the composite.
    const built = buildPanel(parsed, f.name, i, flaggingSex);
    if (built.panel) panels.push(built.panel);
    else notices.push(built.notice);
  }
  if (!panels.length) {
    return NextResponse.json(
      {
        error:
          files.length === 1
            ? "Could not read this PDF. Please check the file and try again."
            : `None of the uploaded blood reports could be read. ${notices.map((n) => n.message).join(". ")}.`,
      },
      { status: files.length === 1 ? 500 : 400 },
    );
  }
  const composite = mergePanels(panels, notices);
  const sourceHeaders: Record<string, string> = {
    "X-Blood-Sources": String(composite.sources.length),
    // Header values must be ASCII; filenames need not be.
    "X-Source-Notices": encodeURIComponent(notices.map((n) => n.message).join("\n")),
  };

  // ----- Deterministic half (never depends on the API) -----
  let analysis;
  try {
    // Cycle day at the draw: counted against the hormone file's collection
    // date when an LMP was entered (the form could only count against the
    // Patient Date). A typed day, or a deliberately chosen non-cycling
    // status, is left alone.
    const typedDay = cycleDayTyped && cycleDay !== null ? Number(cycleDay) : null;
    const clientDay = cycleDay !== null && Number.isFinite(Number(cycleDay)) ? Number(cycleDay) : null;
    const cycle = resolveDrawCycle({
      lmpDate: flaggingSex === "female" ? lmpDate : null,
      typedCycleDay: Number.isFinite(typedDay as number) ? typedDay : null,
      clientCycleDay: clientDay,
      cycleLength: resolveCycleLength(cycleLength).length,
      status: hormoneStatus,
      statusDerived,
      drawDateISO: toISODate(composite.hormoneDrawDate),
    });
    // Female hormone functional ranges (analysis path only). A no-op unless
    // sex is female; the lab tier the engine decided is never overridden.
    const overlay = applyHormoneOverlay(composite.markers, {
      sex: flaggingSex,
      status: cycle.status,
      cycleLength,
      cycleDay: cycle.cycleDay === null ? null : String(cycle.cycleDay),
    });
    const flagged = overlay.markers;

    // ----- Saliva cortisol (optional; never fatal to the blood analysis) -----
    // Reduced to values / clock times / windows / statuses here; the raw
    // text and any identifier on that PDF never leave this block.
    let salivaCortisol: SalivaCortisolFlags | null = null;
    let salivaCortisolNote: string | null = null;
    if (salivaFile && typeof salivaFile !== "string" && salivaFile.size > 0) {
      try {
        const salivaParsed = await parseSalivaCortisolPdf(
          Buffer.from(await salivaFile.arrayBuffer()),
        );
        if (salivaParsed) salivaCortisol = flagSalivaCortisol(salivaParsed);
        else salivaCortisolNote = SALIVA_NOT_RECOGNISED;
      } catch {
        salivaCortisolNote = SALIVA_UNREADABLE;
      }
    }
    const salivaHeaders: Record<string, string> = {
      ...sourceHeaders,
      "X-Saliva-Cortisol": salivaCortisol
        ? `parsed; ${salivaCortisol.samples.length} samples; ${salivaCortisol.curve.pattern}`
        : salivaCortisolNote
          ? `skipped; ${salivaCortisolNote}`
          : "none",
    };

    analysis = buildDeterministicAnalysis(flagged, {
      patientName,
      patientDate,
      dob,
      sex,
      collectedDate: composite.collectedDate,
      reportedDate: composite.reportedDate,
      hormone: overlay.summary,
      salivaCortisol,
      salivaCortisolNote,
      sources: composite.sources,
      multiSource: composite.multiSource,
      spansYears: composite.spansYears,
      sourceNotices: notices.map((n) => n.message),
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
        ...salivaHeaders,
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
        hormone: analysis.hormone,
        priorPanelInterval: interval,
        priorReportText: ingested.redactedText,
        salivaCortisol,
      });
      const serialized = serializePayload(payload);
      assertNoIdentifiers(serialized, { patientName: patientNameRaw, dob });

      let reeval: ReevalNarrative;
      try {
        const json = await askClaudeStructured<ReevalNarrativeJson>(
          buildReevalPrompt(payload),
          {
            system: REEVAL_SYSTEM_PROMPT,
            schema: reevalNarrativeSchema({ cortisol: !!salivaCortisol }),
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
        comparisonGroups: buildMergedComparisonGroups(flagged, reeval.priorFacts, {
          multiSource: analysis.multiSource,
          withYear: analysis.spansYears,
        }),
      };
      const buf = await generateReevalReport(merged, true, reeval, priorPanelDate);
      return reevalResponse(buf, patientNameRaw, patientDate, true, priorHeaders);
    }

    if (skipNarrative) {
      const buf = await generateAnalysisReport(analysis, null);
      return docxResponse(buf, downloadName(patientNameRaw, patientDate), false, salivaHeaders);
    }

    // ----- De-identified payload -----
    const payload = buildPayload(flagged, {
      age: analysis.age,
      sex: analysis.sex,
      intake,
      // See above: the typed name, never the display fallback.
      patientName: patientNameRaw,
      dob,
      hormone: analysis.hormone,
      salivaCortisol,
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
          schema: initialNarrativeSchema({ cortisol: !!salivaCortisol }),
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
    return docxResponse(buf, downloadName(patientNameRaw, patientDate), true, salivaHeaders);
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
