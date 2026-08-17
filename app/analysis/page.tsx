"use client";

/**
 * /analysis — Clinical Analysis (Phase 0 scaffolding).
 *
 * Blood-work upload + freeform intake textarea + a temporary "Test LLM" button
 * that proves the Anthropic wiring. No report is generated yet; the existing
 * data report at "/" is untouched.
 */

import { useRef, useState } from "react";

// ----- Brand palette (matches the existing report page / Word generator) -----
const NAVY = "#1B365D";
const TEAL = "#4A90A4";

type LlmStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; text: string }
  | { kind: "error"; message: string };

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function AnalysisPage() {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [patientName, setPatientName] = useState("");
  const [patientDate, setPatientDate] = useState(todayISO());
  const [intake, setIntake] = useState("");
  const [llm, setLlm] = useState<LlmStatus>({ kind: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const testing = llm.kind === "testing";

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
    if (inputRef.current) inputRef.current.value = "";
  }

  async function testLlm() {
    if (testing) return;
    setLlm({ kind: "testing" });
    try {
      const res = await fetch("/api/analysis/test-llm", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setLlm({ kind: "error", message: data?.error || "Something went wrong" });
        return;
      }
      setLlm({ kind: "ok", text: data.text });
    } catch {
      setLlm({ kind: "error", message: "Could not reach the server" });
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
            Leave blank for a labs-only analysis. Identifiers are never sent to
            the API.
          </p>
        </div>

        {/* Temporary Phase 0 wiring check */}
        <div className="mt-10 rounded-md border border-dashed p-4" style={{ borderColor: TEAL }}>
          <p className="text-sm font-medium" style={{ color: NAVY }}>
            Phase 0 — wiring check
          </p>
          <p className="mt-1 text-xs opacity-70">
            Temporary. Sends a fixed test prompt to Claude (no patient data) to
            confirm the API key and client are working.
          </p>
          <button
            type="button"
            onClick={testLlm}
            disabled={testing}
            className="mt-3 rounded-md border px-5 py-2 font-semibold text-white transition-colors"
            style={{
              backgroundColor: testing ? "#9CA3AF" : TEAL,
              borderColor: testing ? "#9CA3AF" : NAVY,
              cursor: testing ? "not-allowed" : "pointer",
            }}
          >
            {testing ? "Testing..." : "Test LLM"}
          </button>

          <div className="mt-3 min-h-[1.5rem] text-sm">
            {llm.kind === "ok" && (
              <p className="text-green-700">✓ {llm.text}</p>
            )}
            {llm.kind === "error" && (
              <p className="text-red-600">⚠ {llm.message}</p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
