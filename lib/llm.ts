/**
 * lib/llm.ts — the provider boundary.
 *
 * This is the ONLY module in the repository that knows a model vendor exists.
 * Everything above it talks to the `LlmClient` interface, which is trivially
 * faked in tests. Two rules hold here and are enforced by the module boundary:
 *
 *  1. This module returns raw text. It never returns a decision, an action, or
 *     a number the rest of the system will spend money on. Validation of model
 *     output is `lib/proposal.ts`'s job, not this file's.
 *  2. With no credential configured, `getLlmClient()` returns `null` — exactly
 *     the way `lib/voice.ts` returns null when Twilio is absent. Callers must
 *     treat null as "run the deterministic path", never as an error. This is
 *     what keeps the eval harness and the test suite offline and deterministic.
 */


/**
 * Model selection.
 *
 * Both slots default to `openai/gpt-oss-120b` served by Groq (see GROQ_ENDPOINT
 * below — an OpenAI-compatible completions API, not Anthropic's). The choice is
 * latency and unit cost at long-tail volume: slot 1 fires on the ~7% of episodes
 * whose failure code the deterministic table cannot classify, and slot 2 narrates
 * cohorts. Neither slot decides money, so the quality bar is "classify a short
 * opaque string, or admit you cannot" rather than open-ended reasoning.
 *
 * Each slot is independently overridable — RECOVEROS_LLM_DIAGNOSIS_MODEL and
 * RECOVEROS_LLM_NARRATION_MODEL — so an operator who wants a frontier model on
 * diagnosis can have one without a code change. The deterministic floor beneath
 * both slots is identical either way: with no credential, `getLlmClient()`
 * returns null and the classification falls back to the table.
 */
export const DIAGNOSIS_MODEL = process.env.RECOVEROS_LLM_DIAGNOSIS_MODEL ?? "openai/gpt-oss-120b";
export const NARRATION_MODEL = process.env.RECOVEROS_LLM_NARRATION_MODEL ?? "openai/gpt-oss-120b";

export type LlmPurpose = "diagnosis" | "narration";

export interface LlmRequest {
  /** Which of the two sanctioned placements this call belongs to. */
  purpose: LlmPurpose;
  system: string;
  /** Fully assembled user turn. Callers are responsible for sanitising any
   *  attacker-influenced substring BEFORE it reaches this boundary. */
  user: string;
  maxTokens: number;
  /** Optional JSON schema for structured outputs. Belt: it raises the odds the
   *  text parses. Braces: `lib/proposal.ts` re-validates regardless. */
  schema?: Record<string, unknown>;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface LlmClient {
  readonly modelId: string;
  /** Resolves to the model's raw text output. Throws on transport/API failure;
   *  callers catch and fall through to their deterministic path. */
  complete(req: LlmRequest): Promise<string>;
}

export class LlmRefusalError extends Error {
  constructor(public readonly category: string | null) {
    super(`Model declined the request (category: ${category ?? "unknown"})`);
    this.name = "LlmRefusalError";
  }
}

/** Explicitly injected client. Set by tests and by any caller doing its own DI. */
let injectedClient: LlmClient | null = null;
let injectedClientSet = false;
/** Lazily constructed real client, so importing this module never opens a socket. */
let realClient: LlmClient | null = null;

function apiKey(): string | null {
  const key = process.env.GROQ_API_KEY?.trim();
  return key ? key : null;
}

/** True when a real model call is possible. False in CI, in the eval harness,
 *  and on any machine without a credential. */
export function isLlmConfigured(): boolean {
  if (injectedClientSet) return injectedClient !== null;
  if (process.env.RECOVEROS_LLM_DISABLED === "1") return false;
  return apiKey() !== null;
}

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/**
 * Groq speaks the OpenAI chat-completions dialect, so this is a plain `fetch` —
 * no vendor SDK, no dependency to keep current, and the whole surface we depend on
 * is visible in one function. Swapping provider again means editing this class and
 * nothing else: everything above the boundary consumes `LlmClient`.
 */
class GroqLlmClient implements LlmClient {
  constructor(readonly modelId: string, private readonly key: string) {}

  async complete(req: LlmRequest): Promise<string> {
    const model = req.purpose === "diagnosis" ? DIAGNOSIS_MODEL : NARRATION_MODEL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(GROQ_ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          max_completion_tokens: req.maxTokens,
          // Deterministic decoding. These are classification and short language
          // tasks; sampling would make the same failure code resolve differently
          // between runs, which the resolution cache would then freeze in.
          temperature: 0,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          // Constrained decoding against the caller's schema. This matters more
          // than it looks: with a bare `json_object` the model returns valid JSON
          // under its OWN key names — it answered `category` where the contract
          // says `diagnosis`, and omitted `certainty_class` entirely — so every
          // semantically correct classification was thrown away by validation.
          // Zod in lib/proposal.ts is still the guarantee; this is what stops us
          // paying for answers we then discard.
          ...(req.schema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: { name: req.purpose, strict: true, schema: req.schema },
                },
              }
            : {}),
          // gpt-oss exposes reasoning effort directly. Both placements are short
          // language tasks, not work that repays deep reasoning.
          reasoning_effort: req.effort ?? "low",
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Groq ${response.status}: ${body.slice(0, 300)}`);
      }
      const data = await response.json() as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
      };
      const choice = data.choices?.[0];
      if (choice?.finish_reason === "content_filter") {
        throw new LlmRefusalError("content_filter");
      }
      return (choice?.message?.content ?? "").trim();
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Returns a client, or `null` when the system must run deterministically.
 * Null is the normal, expected, non-exceptional case in tests and evals.
 */
export function getLlmClient(): LlmClient | null {
  if (injectedClientSet) return injectedClient;
  if (process.env.RECOVEROS_LLM_DISABLED === "1") return null;
  const key = apiKey();
  if (!key) return null;
  if (!realClient) realClient = new GroqLlmClient(DIAGNOSIS_MODEL, key);
  return realClient;
}

/** Dependency injection seam. Tests pass a fake; `null` forces the offline path. */
export function setLlmClient(client: LlmClient | null): void {
  injectedClient = client;
  injectedClientSet = true;
}

/** Drop the injection and go back to environment-driven resolution. */
export function resetLlmClient(): void {
  injectedClient = null;
  injectedClientSet = false;
  realClient = null;
}
