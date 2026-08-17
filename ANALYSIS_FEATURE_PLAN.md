# Clinical Analysis & Protocol — Feature Plan

Add an LLM-driven **Clinical Analysis** output to the bloodwork tool that reproduces
Melissa's manual Claude-chat workflow, driven by the tool's *verified* flagging
instead of re-reading the PDF. Two modes, both a separate `.docx` alongside the
existing data report.

Target specs (reproduce structure to a T):
- **Initial** → the `Robidoux_Functional_Medicine_Analysis.docx` layout.
- **Re-eval** → the `Bonnie St. Germain BW Reeval` layout (comparative).

## Non-negotiables (locked with Clay)

1. **Additive & isolated.** New route, new server action, new doc generator, new
   LLM client. Reads `lib/flagging` read-only. The existing report path is not
   touched and must generate byte-identically after this work.
2. **Hybrid, not all-LLM.** Anything numeric is built in code from the tool's
   flags; the LLM only writes prose/reasoning and is *given* the flags as ground
   truth ("do not re-derive values").
3. **Identifiers never sent to the API.** Name/DOB/collection dates are merged
   into the final `.docx` locally. The API payload carries only de-identified
   clinical content (intake text + marker data with values/ranges/flags).
4. **Clinical guardrails.** Every doc carries the decision-support disclaimer from
   the sample docs; the practitioner reviews and owns all output and picks the
   actual products. The LLM proposes nutrient categories/named options at
   "practitioner discretion," matching the sample depth.
5. **API failure can't break the core.** LLM/key/network errors return a clean UI
   error; the deterministic data report is unaffected.

## Inputs

| | Blood work (current) | Intake symptoms | Prior report |
|---|---|---|---|
| Initial | required (upload, as today) | optional paste-in textarea | — |
| Re-eval | required | optional | required (.docx or .pdf upload) |

- Intake box: freeform text (bullets or prose). Feeds the "Clinical Presentation
  Summary" and enriches root-cause correlation. Empty = labs-only (thinner).
- Prior report: `.docx`/`.pdf`; text extracted (mammoth/pdf) and passed to the LLM
  to source the prior-value column and the prior protocol. The tool does NOT
  re-flag old blood work.

## What's deterministic vs LLM

**Deterministic (code, from `FlaggedMarker` data — values guaranteed correct):**
- Header block + disclaimer (identifiers merged locally).
- Initial "Markers Outside Range" chart: Marker | Result | Lab Range | Optimal
  Range | Status.
- Re-eval comparison chart: Marker | **Prior** | Current | Lab Range | Optimal |
  Status — current side + lab/optimal status from the engine; grouped by the
  marker `category`. (Prior value + improved/worsened come from the prior report.)
- "Reassuring markers within range" list.

**LLM (reasoning only, fed the verified flags + intake [+ prior report]):**
- Clinical Presentation Summary (from intake).
- Root-Cause Analysis per marker/pattern.
- Phased Protocol with per-phase Goals (re-eval: adjust the prior protocol —
  taper what improved, intensify/add for what held or worsened).
- Plain-language patient summary.

## Architecture

- Route: `/analysis` (or a mode toggle on the existing page).
- `lib/analysis/llm.ts` — isolated Anthropic client. Key from env
  (`ANTHROPIC_API_KEY`), set once at install like everything else. Timeout +
  clean error surface.
- `lib/analysis/prompt.ts` — hardened prompt(s) built from Melissa's, one per
  mode; receives structured flag JSON as authoritative ground truth.
- `lib/analysis/deidentify.ts` — strips identifiers from the payload; keeps a
  local map to re-insert name/DOB into the final doc.
- `lib/generator/analysis-word.ts` — builds the `.docx` (deterministic
  scaffold + LLM prose), mirroring the sample layouts.
- New server action `generateAnalysis` — parse/flag current labs (reuse existing
  pipeline) → build deterministic pieces → call LLM → assemble `.docx`.

## Build phases

**Phase 0 — Scaffolding.** Route + intake textarea + isolated `llm.ts` (health-
check call behind a temp button) + env key wiring. No report output yet. Confirm
`npm run build` + existing report path unchanged.

**Phase 1 — Initial mode (Robidoux).** Deterministic header + out-of-range chart +
reassuring list from current flags → LLM for presentation/root-cause/protocol/
summary → `analysis-word.ts` renders the Robidoux structure. Validate the doc
against the real Robidoux report (structure to a T; values match the tool's
flags). Verify no identifiers hit the API (log/inspect the payload).

**Phase 2 — Re-eval mode (Bonnie).** Add prior-report upload + text extraction.
LLM sources prior values + prior protocol from it; deterministic comparison chart
(current side from flags, grouped by category, with prior column + improved/
worse status); LLM writes comparative root causes + adjusted phased protocol +
summary. Render the Bonnie comparative structure. Validate against the real
Bonnie doc.

**Phase 3 — Validation & hardening.** Run both modes over the real reports Melissa
is sending. Check: numeric chart values always match the tool's flags (never the
LLM), identifiers never in the payload, disclaimers present, graceful failure on
API error. Regression: existing data report still byte-identical. Keep it behind
its own route until Clay signs off, then merge.

## Risks / mitigations

- **Clinical hallucination** (esp. named supplements/doses in re-eval): Melissa
  reviews and owns; disclaimers; LLM told to stay at category/"practitioner
  discretion" depth and to ground protocol changes in the prior report's plan.
- **LLM invents/alters lab values:** prevented structurally — all numbers are
  code-rendered from flags; the LLM's numeric output is never trusted for the
  chart.
- **Non-determinism run-to-run:** acceptable (practitioner reviews); modest
  temperature.
- **Prior-report parsing variance** (Google-Docs exports differ): the LLM reads
  it as context, not as a strict parse; if a prior value is unclear it should say
  so (as the Bonnie doc does: "exact 2025 value not printed").
- **Cost:** ~pennies/report; isolated so failure never touches the core report.

## Open items for Melissa (non-blocking; tune during Phase 3)
- Exact header/title wording per mode (initial vs follow-up).
- How prescriptive the supplement suggestions should be (her samples show she
  wants specific named options — confirm that's the target).
