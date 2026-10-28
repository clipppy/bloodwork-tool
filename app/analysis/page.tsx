"use client";

/**
 * /analysis — Clinical Analysis (initial mode).
 *
 * Blood-work upload + patient fields + freeform intake, producing the Robidoux-
 * structured .docx: header/chart/in-range list built in code from the tool's
 * flags, narrative sections written by the model from a de-identified payload.
 *
 * The name and DOB entered here are used to render the document header locally
 * and to redact the intake text. They are never part of the API payload — only
 * the computed integer age and the sex are.
 *
 * The existing data report at "/" is untouched.
 */

import { useEffect, useRef, useState } from "react";
import ToolNav from "../tool-nav";
import {
  DEFAULT_CYCLE_LENGTH,
  DEFAULT_HORMONE_STATUS,
  HORMONE_STATUS_OPTIONS,
  MAX_CYCLE_LENGTH,
  MIN_CYCLE_LENGTH,
  computeCycleDay,
  cycleDayToStatus,
  hormoneStatusLabel,
  phaseWindowLabel,
  resolveCycleLength,
  parseHormoneStatus,
} from "../../lib/analysis/hormone-ranges";

/** Statuses the practitioner picks deliberately; the LMP / cycle-day inputs
 *  never override one of these. */
const NON_CYCLING_STATUSES: ReadonlySet<string> = new Set([
  "postmenopausal",
  "postmenopausal_hrt",
  "birth_control",
]);

// ----- Brand palette (matches the existing report page / Word generator) -----
const NAVY = "#1B365D";
const TEAL = "#4A90A4";

type PriorPreview = {
  kind: string;
  rawChars: number;
  redactedChars: number;
  redactionCount: number;
  truncated: boolean;
  residualNameCandidates: { text: string; count: number }[];
  redactedText: string;
};

type GenStatus =
  | { kind: "idle" }
  | { kind: "processing" }
  | { kind: "success"; narrated: boolean; salivaNote?: string | null }
  | { kind: "error"; message: string; deterministicAvailable?: boolean };

/** Parsing, matching and flagging finish in about a second; everything after
 *  that is the model writing. Two coarse phases, no fake granularity. */
const READING_LABS_SECONDS = 5;

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function AnalysisPage() {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [patientName, setPatientName] = useState("");
  const [patientDate, setPatientDate] = useState(todayISO());
  const [mode, setMode] = useState<"initial" | "reeval">("initial");
  const [priorFile, setPriorFile] = useState<File | null>(null);
  const [priorError, setPriorError] = useState<string | null>(null);
  const [priorPanelDate, setPriorPanelDate] = useState("");
  const [priorPreview, setPriorPreview] = useState<PriorPreview | null>(null);
  const [priorPreviewLoading, setPriorPreviewLoading] = useState(false);
  const [priorReviewed, setPriorReviewed] = useState(false);
  const [salivaFile, setSalivaFile] = useState<File | null>(null);
  const [salivaError, setSalivaError] = useState<string | null>(null);
  const [dob, setDob] = useState("");
  const [sex, setSex] = useState("");
  const [hormoneStatus, setHormoneStatus] = useState<string>(DEFAULT_HORMONE_STATUS);
  const [lmpDate, setLmpDate] = useState("");
  const [cycleDayInput, setCycleDayInput] = useState("");
  const [cycleLengthInput, setCycleLengthInput] = useState("");
  const [intake, setIntake] = useState("");
  const [gen, setGen] = useState<GenStatus>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  // Cycle day at draw: a typed day wins; otherwise LMP + the Patient Date
  // (the draw date) when both are present. Null when nothing usable is entered.
  const typedCycleDay = cycleDayInput.trim() === "" ? null : Number(cycleDayInput);
  const cycleDay: number | null =
    typedCycleDay !== null
      ? Number.isFinite(typedCycleDay)
        ? typedCycleDay
        : null
      : lmpDate && patientDate
        ? computeCycleDay(lmpDate, patientDate)
        : null;
  const cycleInputsPresent = typedCycleDay !== null || lmpDate !== "";
  // Average cycle length: blank means the standard 28 days; a typed length
  // outside 21-45 also falls back to 28 and is called out on the line below.
  const { length: cycleLength, fellBack: cycleLengthFellBack } = resolveCycleLength(cycleLengthInput);
  const cycleIsStandard = cycleLength === DEFAULT_CYCLE_LENGTH;
  const derivedStatus = cycleDay === null ? null : cycleDayToStatus(cycleDay, cycleLength);

  // Auto-select the phase from the cycle inputs. A deliberately chosen
  // non-cycling status is never overridden, and because this only runs when
  // the cycle inputs (or draw date) change, a later manual dropdown choice
  // stands until those inputs change again.
  useEffect(() => {
    if (sex !== "female" || derivedStatus === null) return;
    setHormoneStatus((prev) => (NON_CYCLING_STATUSES.has(prev) ? prev : derivedStatus));
  }, [sex, derivedStatus]);
  const inputRef = useRef<HTMLInputElement>(null);
  const priorInputRef = useRef<HTMLInputElement>(null);
  const salivaInputRef = useRef<HTMLInputElement>(null);

  const generating = gen.kind === "processing";

  // Live elapsed counter for the long generate call, so an indeterminate
  // spinner is visibly progressing rather than apparently stuck.
  useEffect(() => {
    if (!generating) return;
    const started = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [generating]);

  function acceptFile(f: File | undefined | null) {
    if (!f) return;
    const isPdf =
      f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setFileError("Please upload a PDF file");
      return;
    }
    setFile(f);
    setFileError(null);
  }

  function clearFile() {
    setFile(null);
    setFileError(null);
    setGen({ kind: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  }

  function resetPriorReview() {
    setPriorPreview(null);
    setPriorReviewed(false);
  }

  function acceptPriorFile(f: File | undefined | null) {
    if (!f) return;
    const name = f.name.toLowerCase();
    if (!name.endsWith(".docx") && !name.endsWith(".pdf")) {
      setPriorError("The prior report must be a .docx or .pdf file");
      return;
    }
    setPriorFile(f);
    setPriorError(null);
    setGen({ kind: "idle" });
    resetPriorReview();
  }

  function clearPriorFile() {
    setPriorFile(null);
    setPriorError(null);
    resetPriorReview();
    if (priorInputRef.current) priorInputRef.current.value = "";
  }

  function acceptSalivaFile(f: File | undefined | null) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".pdf") && f.type !== "application/pdf") {
      setSalivaError("The saliva cortisol report must be a PDF");
      return;
    }
    setSalivaFile(f);
    setSalivaError(null);
    setGen({ kind: "idle" });
  }

  function clearSalivaFile() {
    setSalivaFile(null);
    setSalivaError(null);
    if (salivaInputRef.current) salivaInputRef.current.value = "";
  }

  async function loadPriorPreview() {
    if (!priorFile || priorPreviewLoading) return;
    setPriorPreviewLoading(true);
    setPriorError(null);
    try {
      const form = new FormData();
      form.append("priorReport", priorFile);
      form.append("patientName", patientName);
      form.append("dob", dob);
      const res = await fetch("/api/analysis/prior-preview", {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        setPriorError(data?.error || "Could not read the prior report");
        return;
      }
      setPriorPreview(data as PriorPreview);
      setPriorReviewed(false);
    } catch {
      setPriorError("Could not reach the server");
    } finally {
      setPriorPreviewLoading(false);
    }
  }

  async function generateAnalysis(skipNarrative = false) {
    if (!file || generating) return;
    if (mode === "reeval" && !priorFile) {
      setPriorError("Re-evaluation mode needs the prior report");
      return;
    }
    if (mode === "reeval" && !skipNarrative && !priorReviewed) {
      setPriorError(
        "Review the de-identified prior-report text and tick the confirmation before generating",
      );
      return;
    }
    setGen({ kind: "processing" });
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("patientName", patientName);
      form.append("patientDate", patientDate);
      form.append("dob", dob);
      form.append("sex", sex);
      // Only meaningful for a female patient; the server ignores it otherwise.
      form.append("hormoneStatus", sex === "female" ? hormoneStatus : "");
      // Cycle timing the phase was derived from, as clinical context for the
      // report's timing note. Resolved values: blank length = 28 days.
      form.append("cycleLength", sex === "female" ? String(cycleLength) : "");
      form.append("cycleDay", sex === "female" && cycleDay !== null ? String(cycleDay) : "");
      form.append("intake", intake);
      form.append("mode", mode);
      if (mode === "reeval" && priorFile) {
        form.append("priorReport", priorFile);
        form.append("priorPanelDate", priorPanelDate);
        if (priorReviewed) form.append("priorReviewed", "1");
      }
      if (skipNarrative) form.append("skipNarrative", "1");
      // Optional 4-point saliva cortisol PDF; the server reduces it to values,
      // clock times, windows and statuses before anything reaches the model.
      if (salivaFile) form.append("salivaCortisol", salivaFile);

      const res = await fetch("/api/analysis/generate", {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        let message = "Something went wrong";
        let deterministicAvailable = false;
        try {
          const data = await res.json();
          if (data?.error) message = data.error;
          deterministicAvailable = !!data?.deterministicAvailable;
        } catch {
          /* keep generic message */
        }
        setGen({ kind: "error", message, deterministicAvailable });
        return;
      }

      const cd = res.headers.get("Content-Disposition") || "";
      const match = cd.match(/filename="([^"]+)"/);
      const filename =
        match?.[1] ??
        (mode === "reeval" ? "clinical-analysis-reeval.docx" : "clinical-analysis.docx");
      const narrated = res.headers.get("X-Analysis-Narrative") === "included";
      // "skipped; <reason>" when a saliva report was uploaded but unusable;
      // the blood analysis still completed, so this is a notice, not an error.
      const salivaHeader = res.headers.get("X-Saliva-Cortisol") || "";
      const salivaNote = salivaHeader.startsWith("skipped;")
        ? salivaHeader.slice("skipped;".length).trim()
        : null;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setGen({ kind: "success", narrated, salivaNote });
    } catch {
      setGen({ kind: "error", message: "Something went wrong" });
    }
  }

  return (
    <main className="min-h-screen bg-white text-[#1B365D]">
      {/* Header strip */}
      <header className="w-full px-6 py-4" style={{ backgroundColor: NAVY }}>
        <h1 className="text-xl font-bold text-white leading-tight">
          Carbone Chiropractic Center, LLC
        </h1>
        <p className="text-sm text-white/80 leading-tight">
          Clinical Analysis &amp; Protocol
        </p>
      </header>

      <ToolNav active="analysis" />

      <div className="mx-auto max-w-2xl px-6 py-10">

        {/* Mode toggle */}
        <div className="mt-5">
          <span className="mb-2 block text-sm font-medium" style={{ color: NAVY }}>
            Report type
          </span>
          <div
            className="inline-flex overflow-hidden rounded-md border"
            style={{ borderColor: TEAL }}
            role="group"
          >
            {(
              [
                ["initial", "Initial"],
                ["reeval", "Re-evaluation"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  setGen({ kind: "idle" });
                }}
                className="px-5 py-2 text-sm font-semibold transition-colors"
                style={{
                  backgroundColor: mode === value ? TEAL : "transparent",
                  color: mode === value ? "#FFFFFF" : NAVY,
                }}
                aria-pressed={mode === value}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs opacity-70">
            {mode === "initial"
              ? "First functional-medicine panel for this patient."
              : "Compares this panel against the patient's previous report. The prior report is required."}
          </p>
        </div>

        {/* Upload zone */}
        <label
          htmlFor="analysis-pdf-input"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            acceptFile(e.dataTransfer.files?.[0]);
          }}
          className="mt-4 flex h-[280px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed text-center transition-colors"
          style={{
            borderColor: TEAL,
            backgroundColor: dragOver ? "#F0F6F8" : "transparent",
          }}
        >
          <input
            id="analysis-pdf-input"
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => acceptFile(e.target.files?.[0])}
          />
          {file ? (
            <div className="px-6">
              <p className="text-lg font-medium" style={{ color: NAVY }}>
                {file.name}
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  clearFile();
                }}
                className="mt-2 text-sm underline"
                style={{ color: TEAL }}
              >
                × Remove
              </button>
            </div>
          ) : (
            <div className="px-6">
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke={TEAL}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mx-auto mb-4 opacity-80"
                aria-hidden="true"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <p className="text-base" style={{ color: NAVY }}>
                Drop a lab PDF here, or click to browse
              </p>
            </div>
          )}
        </label>
        {fileError && (
          <p className="mt-2 text-center text-red-600">⚠ {fileError}</p>
        )}

        {/* Optional 4-point saliva cortisol report (separate Quest PDF) */}
        <div className="mt-6 rounded-md border p-4" style={{ borderColor: TEAL }}>
          <label
            htmlFor="analysis-saliva"
            className="mb-1 block text-sm font-medium"
            style={{ color: NAVY }}
          >
            Saliva cortisol report{" "}
            <span className="font-normal opacity-70">(optional, .pdf)</span>
          </label>
          <input
            id="analysis-saliva"
            ref={salivaInputRef}
            type="file"
            accept=".pdf,application/pdf"
            onChange={(e) => acceptSalivaFile(e.target.files?.[0])}
            className="block w-full text-sm"
          />
          {salivaFile && (
            <p className="mt-2 text-sm" style={{ color: NAVY }}>
              {salivaFile.name}{" "}
              <button
                type="button"
                onClick={clearSalivaFile}
                className="ml-2 underline"
                style={{ color: TEAL }}
              >
                × Remove
              </button>
            </p>
          )}
          {salivaError && <p className="mt-2 text-red-600">⚠ {salivaError}</p>}
          <p className="mt-2 text-xs opacity-70">
            The Quest &ldquo;Cortisol, LC/MS, Saliva, 4 Samples&rdquo; report. Only
            the four values, their clock times, the reference windows and the
            computed curve shape are used; no name, date of birth or specimen ID
            is read from it. The report gets a cortisol table and a diurnal
            interpretation alongside the hormone findings.
          </p>
        </div>

        {mode === "reeval" && (
          <div className="mt-6 rounded-md border p-4" style={{ borderColor: TEAL }}>
            <label
              htmlFor="analysis-prior"
              className="mb-1 block text-sm font-medium"
              style={{ color: NAVY }}
            >
              Prior report <span className="text-red-600">*</span>{" "}
              <span className="font-normal opacity-70">(.docx or .pdf)</span>
            </label>
            <input
              id="analysis-prior"
              ref={priorInputRef}
              type="file"
              accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(e) => acceptPriorFile(e.target.files?.[0])}
              className="block w-full text-sm"
            />
            {priorFile && (
              <p className="mt-2 text-sm" style={{ color: NAVY }}>
                {priorFile.name}{" "}
                <button
                  type="button"
                  onClick={clearPriorFile}
                  className="ml-2 underline"
                  style={{ color: TEAL }}
                >
                  × Remove
                </button>
              </p>
            )}
            {priorError && <p className="mt-2 text-red-600">⚠ {priorError}</p>}
            <p className="mt-2 text-xs opacity-70">
              Text is extracted locally and de-identified — the patient name, date
              of birth, and any dates are stripped before the text is used.
            </p>

            {priorFile && (
              <div
                className="mt-4 rounded-md border p-3"
                style={{ borderColor: priorReviewed ? "#2E7D32" : TEAL }}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={loadPriorPreview}
                    disabled={priorPreviewLoading}
                    className="rounded-md border px-4 py-2 text-sm font-semibold text-white"
                    style={{
                      backgroundColor: priorPreviewLoading ? "#9CA3AF" : NAVY,
                      borderColor: priorPreviewLoading ? "#9CA3AF" : NAVY,
                      cursor: priorPreviewLoading ? "not-allowed" : "pointer",
                    }}
                  >
                    {priorPreviewLoading
                      ? "Preparing..."
                      : priorPreview
                        ? "Refresh redacted text"
                        : "Review redacted prior text"}
                  </button>
                  <span className="text-xs opacity-70">
                    Required before the comparative analysis can run.
                  </span>
                </div>

                {priorPreview && (
                  <div className="mt-3">
                    <p className="text-xs" style={{ color: NAVY }}>
                      This is the <strong>exact text</strong> that will be sent.{" "}
                      {priorPreview.redactionCount} identifier
                      {priorPreview.redactionCount === 1 ? "" : "s"} removed from{" "}
                      {priorPreview.rawChars.toLocaleString()} characters of{" "}
                      {priorPreview.kind.toUpperCase()}.
                      {priorPreview.truncated ? " Text was truncated for length." : ""}
                    </p>

                    {priorPreview.residualNameCandidates.length > 0 && (
                      <div className="mt-2 rounded border border-amber-400 bg-amber-50 p-2 text-xs">
                        <p className="font-semibold text-amber-900">
                          Still present and shaped like a name — check these before
                          confirming:
                        </p>
                        <p className="mt-1 text-amber-900">
                          {priorPreview.residualNameCandidates
                            .map((c) => `${c.text}${c.count > 1 ? ` (x${c.count})` : ""}`)
                            .join(" · ")}
                        </p>
                        <p className="mt-1 text-amber-800 opacity-80">
                          Clinical phrases are expected here. If any of these is a
                          person, do not confirm — remove it from the file first.
                        </p>
                      </div>
                    )}

                    <textarea
                      readOnly
                      value={priorPreview.redactedText}
                      rows={14}
                      className="mt-2 w-full rounded-md border px-3 py-2 font-mono text-xs"
                      style={{ borderColor: TEAL }}
                    />

                    <label className="mt-2 flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={priorReviewed}
                        onChange={(e) => {
                          setPriorReviewed(e.target.checked);
                          setPriorError(null);
                        }}
                        className="mt-1"
                      />
                      <span style={{ color: NAVY }}>
                        I have reviewed this text and confirm it contains no patient
                        identifiers.
                      </span>
                    </label>
                  </div>
                )}
              </div>
            )}

            <div className="mt-4 sm:max-w-xs">
              <label
                htmlFor="analysis-prior-date"
                className="mb-1 block text-sm font-medium"
                style={{ color: NAVY }}
              >
                Prior panel date{" "}
                <span className="font-normal opacity-70">(optional)</span>
              </label>
              <input
                id="analysis-prior-date"
                type="date"
                value={priorPanelDate}
                onChange={(e) => setPriorPanelDate(e.target.value)}
                className="w-full rounded-md border px-3 py-2 outline-none focus:ring-2"
                style={{ borderColor: TEAL }}
              />
              <p className="mt-1 text-xs opacity-70">
                Used for timing in the Overview. Only the interval (e.g. &ldquo;~8
                months&rdquo;) is sent — never the date.
              </p>
            </div>
          </div>
        )}

        {/* Patient fields */}
        <div className="mt-6 flex flex-col gap-4 sm:flex-row">
          <div className="flex-1">
            <label
              htmlFor="analysis-patient-name"
              className="mb-1 block text-sm font-medium"
              style={{ color: NAVY }}
            >
              Patient Name
            </label>
            <input
              id="analysis-patient-name"
              type="text"
              placeholder="Patient"
              value={patientName}
              onChange={(e) => setPatientName(e.target.value)}
              className="w-full rounded-md border px-3 py-2 outline-none focus:ring-2"
              style={{ borderColor: TEAL }}
            />
          </div>
          <div className="flex-1">
            <label
              htmlFor="analysis-patient-date"
              className="mb-1 block text-sm font-medium"
              style={{ color: NAVY }}
            >
              Patient Date
            </label>
            <input
              id="analysis-patient-date"
              type="date"
              value={patientDate}
              onChange={(e) => setPatientDate(e.target.value)}
              className="w-full rounded-md border px-3 py-2 outline-none focus:ring-2"
              style={{ borderColor: TEAL }}
            />
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-4 sm:flex-row">
          <div className="flex-1">
            <label
              htmlFor="analysis-dob"
              className="mb-1 block text-sm font-medium"
              style={{ color: NAVY }}
            >
              Date of birth{" "}
              <span className="font-normal opacity-70">(optional)</span>
            </label>
            <input
              id="analysis-dob"
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              className="w-full rounded-md border px-3 py-2 outline-none focus:ring-2"
              style={{ borderColor: TEAL }}
            />
            <p className="mt-1 text-xs opacity-70">
              Printed on the report header. Only the computed age is sent to the
              API.
            </p>
          </div>
          <div className="flex-1">
            <label
              htmlFor="analysis-sex"
              className="mb-1 block text-sm font-medium"
              style={{ color: NAVY }}
            >
              Sex <span className="font-normal opacity-70">(optional)</span>
            </label>
            <select
              id="analysis-sex"
              value={sex}
              onChange={(e) => setSex(e.target.value)}
              className="w-full rounded-md border bg-white px-3 py-2 outline-none focus:ring-2"
              style={{ borderColor: TEAL }}
            >
              <option value="">Not specified</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
            <p className="mt-1 text-xs opacity-70">
              Used for sex-specific clinical context in the narrative.
            </p>
          </div>
        </div>

        {/* LMP / cycle day -> auto-selects the phase below — female only */}
        {sex === "female" && (
          <div className="mt-4">
            <div className="flex flex-col gap-4 sm:flex-row">
              <div className="flex-1">
                <label
                  htmlFor="analysis-lmp"
                  className="mb-1 block text-sm font-medium"
                  style={{ color: NAVY }}
                >
                  Last period start date (LMP){" "}
                  <span className="font-normal opacity-70">(optional)</span>
                </label>
                <input
                  id="analysis-lmp"
                  type="date"
                  value={lmpDate}
                  onChange={(e) => setLmpDate(e.target.value)}
                  className="w-full rounded-md border px-3 py-2 outline-none focus:ring-2"
                  style={{ borderColor: TEAL }}
                />
                <p className="mt-1 text-xs opacity-70">
                  Counted against the Patient Date above to find the cycle day at
                  the draw. Stays on this page; never sent.
                </p>
              </div>
              <div className="flex-1">
                <label
                  htmlFor="analysis-cycle-day"
                  className="mb-1 block text-sm font-medium"
                  style={{ color: NAVY }}
                >
                  Cycle day at draw{" "}
                  <span className="font-normal opacity-70">(optional)</span>
                </label>
                <input
                  id="analysis-cycle-day"
                  type="number"
                  min={1}
                  max={MAX_CYCLE_LENGTH + 2}
                  step={1}
                  inputMode="numeric"
                  placeholder="e.g. 18"
                  value={cycleDayInput}
                  onChange={(e) => setCycleDayInput(e.target.value)}
                  className="w-full rounded-md border px-3 py-2 outline-none focus:ring-2"
                  style={{ borderColor: TEAL }}
                />
                <p className="mt-1 text-xs opacity-70">
                  If known, this wins over the LMP calculation.
                </p>
              </div>
              <div className="flex-1">
                <label
                  htmlFor="analysis-cycle-length"
                  className="mb-1 block text-sm font-medium"
                  style={{ color: NAVY }}
                >
                  Average cycle length (days){" "}
                  <span className="font-normal opacity-70">(optional)</span>
                </label>
                <input
                  id="analysis-cycle-length"
                  type="number"
                  min={MIN_CYCLE_LENGTH}
                  max={MAX_CYCLE_LENGTH}
                  step={1}
                  inputMode="numeric"
                  placeholder={`e.g. ${DEFAULT_CYCLE_LENGTH}`}
                  value={cycleLengthInput}
                  onChange={(e) => setCycleLengthInput(e.target.value)}
                  className="w-full rounded-md border px-3 py-2 outline-none focus:ring-2"
                  style={{ borderColor: TEAL }}
                />
                <p className="mt-1 text-xs opacity-70">
                  Blank = standard {DEFAULT_CYCLE_LENGTH} days. Shifts the phase windows
                  around the estimated ovulation day (cycle length minus 14).
                </p>
              </div>
            </div>
            {cycleInputsPresent && (
              <p
                className="mt-2 text-sm"
                style={{ color: NAVY }}
                aria-live="polite"
              >
                {derivedStatus !== null && cycleDay !== null ? (
                  NON_CYCLING_STATUSES.has(hormoneStatus) ? (
                    <>
                      Cycle day {cycleDay} of a {cycleLength}-day cycle &rarr;{" "}
                      {hormoneStatusLabel(derivedStatus)} — not applied because &ldquo;
                      {hormoneStatusLabel(parseHormoneStatus(hormoneStatus))}&rdquo; is
                      selected below.
                    </>
                  ) : (
                    <>
                      Cycle day {cycleDay} of a {cycleLength}-day cycle &rarr;{" "}
                      {hormoneStatusLabel(derivedStatus).replace(/\s*\(.*\)$/, "")} (
                      {phaseWindowLabel(derivedStatus, cycleLength, cycleDay)})
                      {cycleIsStandard
                        ? "."
                        : `; timing adjusted from the standard ${DEFAULT_CYCLE_LENGTH}-day cycle.`}
                    </>
                  )
                ) : cycleDay !== null ? (
                  <>
                    Cycle day {cycleDay} is outside the 1&ndash;{cycleLength + 2} window a{" "}
                    {cycleLength}-day cycle covers, so the phase below was left as is.
                    Choose it manually.
                  </>
                ) : typedCycleDay !== null ? (
                  <>Enter a whole cycle day between 1 and {cycleLength + 2}.</>
                ) : !patientDate ? (
                  <>Enter the Patient Date (draw date) to count the cycle day from the LMP.</>
                ) : (
                  <>
                    The LMP is after the Patient Date, so no cycle day could be counted.
                    Check the dates or choose the phase manually.
                  </>
                )}
              </p>
            )}
            {cycleLengthFellBack && (
              <p className="mt-1 text-sm" style={{ color: NAVY }} aria-live="polite">
                Average cycle length must be between {MIN_CYCLE_LENGTH} and {MAX_CYCLE_LENGTH}{" "}
                days; the standard {DEFAULT_CYCLE_LENGTH}-day timing is being used instead.
              </p>
            )}
          </div>
        )}

        {/* Cycle phase / menopausal status — female only */}
        {sex === "female" && (
          <div className="mt-4">
            <label
              htmlFor="analysis-hormone-status"
              className="mb-1 block text-sm font-medium"
              style={{ color: NAVY }}
            >
              Cycle phase / menopausal status{" "}
              <span className="font-normal opacity-70">(optional)</span>
            </label>
            <select
              id="analysis-hormone-status"
              value={hormoneStatus}
              onChange={(e) => setHormoneStatus(e.target.value)}
              className="w-full rounded-md border bg-white px-3 py-2 outline-none focus:ring-2"
              style={{ borderColor: TEAL }}
            >
              {HORMONE_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs opacity-70">
              Selects the functional optimal ranges for the hormone panel.
              With &ldquo;Not sure&rdquo;, phase-dependent hormones (estradiol,
              progesterone, FSH, LH) are judged against the lab range only.
              Hormonal birth control or HRT turns the hormone optimals off.
              Printed on the report header; sent to the model as clinical
              context.
            </p>
          </div>
        )}

        {/* Intake / symptoms */}
        <div className="mt-6">
          <label
            htmlFor="analysis-intake"
            className="mb-1 block text-sm font-medium"
            style={{ color: NAVY }}
          >
            Patient intake / symptoms{" "}
            <span className="font-normal opacity-70">(optional)</span>
          </label>
          <textarea
            id="analysis-intake"
            rows={10}
            value={intake}
            onChange={(e) => setIntake(e.target.value)}
            placeholder={
              "Paste the intake notes here — bullets or prose. For example:\n" +
              "- Fatigue, worse mid-afternoon\n" +
              "- Cold hands and feet\n" +
              "- Trouble falling asleep"
            }
            className="w-full rounded-md border px-3 py-2 outline-none focus:ring-2"
            style={{ borderColor: TEAL }}
          />
          <p className="mt-1 text-xs opacity-70">
            Leave blank for a labs-only analysis. The patient name, date of
            birth, and any dates are stripped from this text before it is sent;
            avoid pasting other identifiers.
          </p>
        </div>

        {/* Generate */}
        <div className="mt-8 flex justify-center">
          <button
            type="button"
            onClick={() => generateAnalysis(false)}
            disabled={!file || generating}
            className="rounded-md border px-8 py-3 font-semibold text-white transition-colors"
            style={{
              backgroundColor: !file || generating ? "#9CA3AF" : TEAL,
              borderColor: !file || generating ? "#9CA3AF" : NAVY,
              cursor: !file || generating ? "not-allowed" : "pointer",
            }}
          >
            {mode === "reeval"
              ? "Generate Re-evaluation Analysis"
              : "Generate Clinical Analysis"}
          </button>
        </div>

        <div className="mt-4 min-h-[2rem] text-center">
          {gen.kind === "processing" && (
            <div style={{ color: NAVY }}>
              <div
                className="flex items-center justify-center gap-2"
                aria-live="polite"
              >
                <svg
                  className="animate-spin"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" stroke="#E5E7EB" strokeWidth="4" />
                  <path
                    d="M22 12a10 10 0 0 1-10 10"
                    stroke={TEAL}
                    strokeWidth="4"
                    strokeLinecap="round"
                  />
                </svg>
                <span>
                  {elapsed < READING_LABS_SECONDS
                    ? "Reading labs..."
                    : "Writing the analysis..."}
                </span>
                <span className="font-mono tabular-nums opacity-70">
                  {formatElapsed(elapsed)}
                </span>
              </div>
              <p className="mt-1 text-xs opacity-70">
                This usually takes 2-3 minutes &mdash; you can leave this tab open.
              </p>
            </div>
          )}
          {gen.kind === "success" && (
            <div className="flex items-center justify-center gap-2 text-green-700">
              <span aria-hidden="true">✓</span>
              <span>
                {gen.narrated
                  ? "Analysis generated. Download starting..."
                  : "Data-only analysis generated (narrative sections left as placeholders). Download starting..."}
              </span>
            </div>
          )}
          {gen.kind === "success" && gen.salivaNote && (
            <p className="mt-2 text-sm" style={{ color: "#B26A00" }} role="status">
              <span aria-hidden="true">⚠</span> Saliva cortisol skipped: {gen.salivaNote}
            </p>
          )}
          {gen.kind === "error" && (
            <div className="text-red-600">
              <div>
                <span aria-hidden="true">⚠</span> {gen.message}
              </div>
              <div className="mt-2 flex items-center justify-center gap-4">
                <button
                  type="button"
                  onClick={() => generateAnalysis(false)}
                  className="underline"
                >
                  Try again
                </button>
                {gen.deterministicAvailable && (
                  <button
                    type="button"
                    onClick={() => generateAnalysis(true)}
                    className="underline"
                    style={{ color: NAVY }}
                  >
                    Download without the narrative
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <p className="mt-2 text-center text-xs opacity-70">
          {mode === "initial"
            ? "The header, marker chart, and in-range list are built in code from the tool's flags. The narrative sections are written by the model from a de-identified payload and reviewed by the practitioner."
            : "The current side of the comparison chart and the improved/held/worsened trend are computed in code. Prior-panel values are read from the prior report by the model — spot-check them against that report."}
        </p>
      </div>
    </main>
  );
}
