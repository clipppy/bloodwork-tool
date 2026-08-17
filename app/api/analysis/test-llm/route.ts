/**
 * POST /api/analysis/test-llm
 *
 * Temporary Phase 0 health check: proves the Anthropic client, the API key,
 * and the /analysis page are wired together end to end. Sends a fixed trivial
 * prompt — no patient data, no uploaded file, no intake text is transmitted.
 *
 * Delete this route once Phase 1 lands the real generateAnalysis action.
 */

import { NextResponse } from "next/server";
import { askClaude, AnalysisLlmError, ANALYSIS_MODEL } from "../../../../lib/analysis/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEALTH_CHECK_PROMPT =
  'Reply with exactly this and nothing else: "Clinical analysis LLM wiring is working."';

export async function POST(): Promise<Response> {
  try {
    const text = await askClaude(HEALTH_CHECK_PROMPT, { timeoutMs: 60_000 });
    return NextResponse.json(
      { text, model: ANALYSIS_MODEL },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const message =
      err instanceof AnalysisLlmError
        ? err.message
        : "Unexpected error calling the Claude API.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
