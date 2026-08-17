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

import { useRef, useState } from "react";

// ----- Brand palette (matches the existing report page / Word generator) -----
const NAVY = "#1B365D";
const TEAL = "#4A90A4";

type GenStatus =
  | { kind: "idle" }
  | { kind: "processing" }
  | { kind: "success"; narrated: boolean }
  | { kind: "error"; message: string; deterministicAvailable?: boolean };

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function AnalysisPage() {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [patientName, setPatientName] = useState("");
  const [patientDate, setPatientDate] = useState(todayISO());
  const [dob, setDob] = useState("");
  const [sex, setSex] = useState("");
  const [intake, setIntake] = useState("");
  const [gen, setGen] = useState<GenStatus>({ kind: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const generating = gen.kind === "processing";

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

  async function generateAnalysis(skipNarrative = false) {
    if (!file || generating) return;
    setGen({ kind: "processing" });
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("patientName", patientName);
      form.append("patientDate", patientDate);
      form.append("dob", dob);
      form.append("sex", sex);
      form.append("intake", intake);
      if (skipNarrative) form.append("skipNarrative", "1");

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
      const filename = match ? match[1] : "clinical-analysis.docx";
      const narrated = res.headers.get("X-Analysis-Narrative") === "included";

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setGen({ kind: "success", narrated });
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

      <div className="mx-auto max-w-2xl px-6 py-10">
        <a href="/" className="text-sm underline" style={{ color: TEAL }}>
          &larr; Back to the data report
        </a>

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
            Generate Clinical Analysis
          </button>
        </div>

        <div className="mt-4 min-h-[2rem] text-center">
          {gen.kind === "processing" && (
            <div
              className="flex items-center justify-center gap-2"
              style={{ color: NAVY }}
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
              <span>Building the analysis...</span>
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
          The header, marker chart, and in-range list are built in code from the
          tool&apos;s flags. The narrative sections are written by the model from
          a de-identified payload and reviewed by the practitioner.
        </p>
      </div>
    </main>
  );
}
