/**
 * Isolated Anthropic client for the Clinical Analysis feature.
 *
 * The narrative comes back as STRUCTURED output: the caller supplies a JSON
 * schema, the API enforces the shape, and this module returns the parsed
 * object. Section assembly therefore never depends on parsing prose.
 *
 * Nothing else in the tool imports this file, and this file imports nothing
 * from the tool. The existing report path (parser → matcher → flagging →
 * generator/word) must never depend on the API being reachable: every failure
 * here surfaces as an `AnalysisLlmError` with a message safe to show the user.
 *
 * The key is read from ANTHROPIC_API_KEY at call time (not module load), so a
 * missing key is a clean per-request error rather than an import-time crash.
 *
 * One entry point: askClaudeStructured().
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

export interface AskClaudeStructuredOptions extends AskClaudeOptions {
  /** JSON Schema the response must satisfy. Enforced by the API. */
  schema: Record<string, unknown>;
}

/**
 * Send a prompt and get back an object matching `schema`.
 *
 * The shape is enforced server-side, so a missing section is an API-level
 * failure rather than a silently half-empty document. Throws
 * `AnalysisLlmError` on a missing key, a timeout, a network failure, an API
 * error, a refusal, a truncated response, or output that is not the expected
 * JSON.
 */
export async function askClaudeStructured<T>(
  prompt: string,
  options: AskClaudeStructuredOptions,
): Promise<T> {
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
        output_config: { format: { type: "json_schema", schema: options.schema } },
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
  if (response.stop_reason === "max_tokens") {
    throw new AnalysisLlmError(
      "The response was cut off before it was complete. Try again, or shorten the intake text.",
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

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AnalysisLlmError(
      "Claude's response was not valid JSON for the requested format.",
    );
  }
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
