/**
 * Isolated Anthropic client for the Clinical Analysis feature.
 *
 * Nothing else in the tool imports this file, and this file imports nothing
 * from the tool. The existing report path (parser → matcher → flagging →
 * generator/word) must never depend on the API being reachable: every failure
 * here surfaces as an `AnalysisLlmError` with a message safe to show the user.
 *
 * The key is read from ANTHROPIC_API_KEY at call time (not module load), so a
 * missing key is a clean per-request error rather than an import-time crash.
 */

import Anthropic from "@anthropic-ai/sdk";

/** Model used for all clinical-analysis prose. */
export const ANALYSIS_MODEL = "claude-opus-5";

/** Hard ceiling on a single request, in milliseconds. */
export const ANALYSIS_TIMEOUT_MS = 120_000;

/** Output-token ceiling. Non-streaming, so kept well under HTTP timeouts. */
const MAX_TOKENS = 16_000;

/** Every failure out of this module is one of these. */
export class AnalysisLlmError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AnalysisLlmError";
    this.cause = cause;
  }
}

export interface AskClaudeOptions {
  /** Optional system prompt. */
  system?: string;
  /** Override the default request timeout (ms). */
  timeoutMs?: number;
}

/**
 * Send a prompt to Claude and return the response text.
 *
 * Throws `AnalysisLlmError` on a missing key, a timeout, a network failure, an
 * API error, or a response that carries no text (e.g. a safety refusal).
 */
export async function askClaude(
  prompt: string,
  options: AskClaudeOptions = {},
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new AnalysisLlmError(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local and restart the app.",
    );
  }

  if (!prompt.trim()) {
    throw new AnalysisLlmError("Cannot send an empty prompt.");
  }

  const client = new Anthropic({ apiKey, maxRetries: 1 });

  let response: Anthropic.Message;
  try {
    response = await client.messages.create(
      {
        model: ANALYSIS_MODEL,
        max_tokens: MAX_TOKENS,
        ...(options.system ? { system: options.system } : {}),
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: options.timeoutMs ?? ANALYSIS_TIMEOUT_MS },
    );
  } catch (err) {
    throw new AnalysisLlmError(describeError(err), err);
  }

  if (response.stop_reason === "refusal") {
    throw new AnalysisLlmError(
      "Claude declined to answer this request. Review the intake text and try again.",
    );
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!text) {
    throw new AnalysisLlmError("Claude returned an empty response.");
  }

  return text;
}

/** Map SDK errors to a short message that is safe to show in the UI. */
function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "ANTHROPIC_API_KEY was rejected. Check the key and try again.";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return "This API key does not have access to the analysis model.";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "Rate limited by the API. Wait a moment and try again.";
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return `The request to Claude timed out after ${Math.round(
      ANALYSIS_TIMEOUT_MS / 1000,
    )}s.`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Claude API. Check the internet connection.";
  }
  if (err instanceof Anthropic.APIError) {
    return `Claude API error (${err.status ?? "unknown status"}): ${err.message}`;
  }
  return "Unexpected error calling the Claude API.";
}
