"use client";

import { useRef, useState } from "react";

// ----- Brand palette (must match the Word generator) -----
const NAVY = "#1B365D";
const TEAL = "#4A90A4";

type Status =
  | { kind: "idle" }
  | { kind: "processing" }
  | { kind: "success" }
  | { kind: "error"; message: string };

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [patientName, setPatientName] = useState("");
  const [patientDate, setPatientDate] = useState(todayISO());
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = status.kind === "processing";

  function acceptFile(f: File | undefined | null) {
    if (!f) return;
    const isPdf =
      f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      setStatus({ kind: "error", message: "Please upload a PDF file" });
      return;
    }
    setFile(f);
    setStatus({ kind: "idle" });
  }

  function clearFile() {
    setFile(null);
    setStatus({ kind: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  }

  async function generate() {
    if (!file || busy) return;
    setStatus({ kind: "processing" });
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("patientName", patientName);
      form.append("patientDate", patientDate);

      const res = await fetch("/api/generate", { method: "POST", body: form });

      if (!res.ok) {
        let message = "Something went wrong";
        try {
          const data = await res.json();
          if (data?.error) message = data.error;
        } catch {
          /* keep generic message */
        }
        setStatus({ kind: "error", message });
        return;
      }

      // Pull the filename from Content-Disposition, fall back to a default.
      const cd = res.headers.get("Content-Disposition") || "";
      const match = cd.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : "lab-report.docx";

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setStatus({ kind: "success" });
    } catch {
      setStatus({ kind: "error", message: "Something went wrong" });
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
          Bloodwork Analysis Tool
        </p>
      </header>

      <div className="mx-auto max-w-2xl px-6 py-10">
        {/* Upload zone */}
        <label
          htmlFor="pdf-input"
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
          className="flex h-[400px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed text-center transition-colors"
          style={{
            borderColor: TEAL,
            backgroundColor: dragOver ? "#F0F6F8" : "transparent",
          }}
        >
          <input
            id="pdf-input"
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
              {/* subtle upload icon */}
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

        {/* Inputs */}
        <div className="mt-6 flex flex-col gap-4 sm:flex-row">
          <div className="flex-1">
            <label
              htmlFor="patient-name"
              className="mb-1 block text-sm font-medium"
              style={{ color: NAVY }}
            >
              Patient Name
            </label>
            <input
              id="patient-name"
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
              htmlFor="patient-date"
              className="mb-1 block text-sm font-medium"
              style={{ color: NAVY }}
            >
              Patient Date
            </label>
            <input
              id="patient-date"
              type="date"
              value={patientDate}
              onChange={(e) => setPatientDate(e.target.value)}
              className="w-full rounded-md border px-3 py-2 outline-none focus:ring-2"
              style={{ borderColor: TEAL }}
            />
          </div>
        </div>

        {/* Generate button */}
        <div className="mt-8 flex justify-center">
          <button
            type="button"
            onClick={generate}
            disabled={!file || busy}
            className="rounded-md border px-8 py-3 font-semibold text-white transition-colors"
            style={{
              backgroundColor: !file || busy ? "#9CA3AF" : TEAL,
              borderColor: !file || busy ? "#9CA3AF" : NAVY,
              cursor: !file || busy ? "not-allowed" : "pointer",
            }}
            onMouseEnter={(e) => {
              if (file && !busy)
                e.currentTarget.style.backgroundColor = "#3C7A8C";
            }}
            onMouseLeave={(e) => {
              if (file && !busy) e.currentTarget.style.backgroundColor = TEAL;
            }}
          >
            Generate Report
          </button>
        </div>

        {/* Status area */}
        <div className="mt-6 min-h-[2rem] text-center">
          {status.kind === "processing" && (
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
              <span>Analyzing your lab report...</span>
            </div>
          )}
          {status.kind === "success" && (
            <div className="flex items-center justify-center gap-2 text-green-700">
              <span aria-hidden="true">✓</span>
              <span>Report generated. Download starting...</span>
            </div>
          )}
          {status.kind === "error" && (
            <div className="text-red-600">
              <span aria-hidden="true">⚠</span> {status.message}{" "}
              <button
                type="button"
                onClick={() => setStatus({ kind: "idle" })}
                className="underline"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
