/**
 * lib/proposal.ts — the untrusted-model-output boundary.
 *
 * IDEA.md §9: "Everything the model emits passes through lib/proposal.ts —
 * Zod-validated, action constrained to the closed set, confidence capped at the
 * structured diagnosis's confidence, malformed output silently replaced with the
 * deterministic fallback and tagged `llm_output_rejected`."
 *
 * That is this file, literally. Nothing here calls a model, holds a credential,
 * or executes anything. It takes `unknown` in and returns a value the rest of
 * the system already knows how to reject.
 */

import { z } from "zod";
import {
  actionSchema,
  failureClassSchema,
  type ActionProposal,
  type CustomerProfile,
  type Diagnosis,
  type PaymentEvent,
} from "@/lib/domain";
import { proposalFor } from "@/lib/scoring";

/**
 * A model-inferred cause can never outrank a structured gateway signal. The
 * weakest structured code in lib/diagnosis.ts carries 0.82; the ceiling sits
 * below it so an LLM diagnosis is always the least-trusted supported cause.
 */
export const LLM_CONFIDENCE_CEILING = 0.8;

/**
 * IDEA.md §9's floor. Below this the diagnosis is discarded and the
 * deterministic `unknown` path runs instead — which lib/scoring.ts turns into
 * ESCALATE, never into autonomous customer contact.
 */
export const LLM_CONFIDENCE_FLOOR = 0.45;

const MAX_REASON_CODES = 8;
const MAX_REASON_CODE_LENGTH = 64;

/**
 * Phrases that do not occur in gateway failure codes or in honest model output,
 * but do occur when someone is steering the model through a field they control.
 * A failure code is attacker-influenced data: it originates upstream of us and
 * a merchant's own checkout metadata can end up inside it.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|preceding|above|earlier)\s+(instruction|prompt|rule|direction)/i,
  /disregard\s+(all\s+|any\s+|the\s+)?(previous|prior|preceding|above|earlier|system)/i,
  /forget\s+(everything|all|your)\s/i,
  /(system|developer)\s*(prompt|message|instruction)/i,
  /you\s+are\s+now\s+(a|an|the)?\s*\w/i,
  /new\s+(instruction|rule|task|objective|directive)s?\s*[:\-]/i,
  /\b(override|bypass|escalate)\s+(the\s+)?(polic|safety|guardrail|restriction|check)/i,
  /\brecommend\b[^.\n]{0,40}\b(VOICE_CALL|PAYMENT_LINK|REMINDER|RETRY|STOP|ESCALATE|WAIT)\b/i,
  /\b(always|must)\s+(return|respond|output|answer)\s+with\b/i,
  /<\s*\/?\s*(system|instruction|assistant|human)\s*>/i,
  /```\s*(system|instruction)/i,
];

/** Real gateway codes are short machine tokens or a short issuer phrase. */
const MAX_CODE_WORDS = 12;
const MAX_CODE_LENGTH = 160;

export interface InjectionVerdict {
  suspicious: boolean;
  /** Machine reasons, safe to log and to render in the audit trail. */
  signals: string[];
}

/**
 * Screens attacker-influenced text before it is used to build a prompt, and
 * screens model output before it is trusted. Returns machine reason codes, not
 * prose, so the result can go straight into a Diagnosis's reasonCodes.
 *
 * `mode` selects which checks apply. "code" is the strict mode for a gateway
 * failure code, where prose is itself the anomaly. "prose" runs only the
 * instruction-override phrases, because a model explanation is legitimately
 * long-form English and the shape checks would reject every honest one.
 */
export function detectPromptInjection(
  text: string | null | undefined,
  mode: "code" | "prose" = "code",
): InjectionVerdict {
  const signals: string[] = [];
  if (!text) return { suspicious: false, signals };

  if (mode === "code") {
    if (text.length > MAX_CODE_LENGTH) signals.push("injection_signal:oversized_code");
    if (text.trim().split(/\s+/).length > MAX_CODE_WORDS) signals.push("injection_signal:prose_shaped_code");
    // Control characters and line breaks are how a single field becomes two.
    if (/[\u0000-\u0008\u000A-\u001F\u007F]/.test(text)) signals.push("injection_signal:control_characters");
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      signals.push("injection_signal:instruction_override");
      break;
    }
  }
  return { suspicious: signals.length > 0, signals };
}

/**
 * Reduces attacker-influenced text to something safe to interpolate: single
 * line, bounded length, no delimiter-forging characters. Callers must still run
 * detectPromptInjection first — this narrows the blast radius, it does not
 * decide anything.
 */
export function sanitizeUntrustedText(text: string, maxLength = MAX_CODE_LENGTH): string {
  return text
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[`<>{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanReasonCodes(codes: string[]): string[] {
  return codes
    .slice(0, MAX_REASON_CODES)
    .map((code) => code.replace(/[^a-zA-Z0-9_.:\-]/g, "_").slice(0, MAX_REASON_CODE_LENGTH))
    .filter((code) => code.length > 0);
}

/**
 * The wire shape both slot-1 halves are validated against. `diagnosis` is
 * constrained to the same closed failure-class union the deterministic table
 * uses, and `recommended_action` to the closed action set — a hallucinated
 * `SEND_MONEY` fails here rather than reaching lib/policy.ts.
 */
const llmProposalSchema = z.object({
  diagnosis: failureClassSchema,
  certainty_class: z.enum(["known", "inferred", "unknown"]),
  confidence: z.number().min(0).max(1),
  recommended_action: actionSchema,
  reason_codes: z.array(z.string()).max(MAX_REASON_CODES),
  explanation: z.string().min(1).max(800),
  drafted_message: z.string().max(600).nullable().optional(),
});

export type LlmProposalPayload = z.infer<typeof llmProposalSchema>;

/** The diagnosis half. Everything except the action, which slot 1 does not need. */
const llmDiagnosisSchema = llmProposalSchema.omit({ recommended_action: true, drafted_message: true });

export interface LlmDiagnosisRejection {
  diagnosis: Diagnosis;
  rejected: boolean;
}

/**
 * Validate an untrusted LLM classification into a Diagnosis.
 *
 * Every failure mode returns `deterministic` — the caller's existing
 * deterministic result — with machine reason codes appended. The model can
 * widen what we understand; it can never narrow what we refuse.
 */
export function parseLlmDiagnosis(
  raw: unknown,
  context: { deterministic: Diagnosis; modelId: string },
): LlmDiagnosisRejection {
  const reject = (...codes: string[]): LlmDiagnosisRejection => ({
    rejected: true,
    diagnosis: {
      ...context.deterministic,
      reasonCodes: [...context.deterministic.reasonCodes, "llm_output_rejected", ...codes],
    },
  });

  const parsed = llmDiagnosisSchema.safeParse(raw);
  if (!parsed.success) return reject("llm_reject:schema");

  // The model's own prose is untrusted too: a payload that echoes an injection
  // back at us is evidence the upstream field steered it.
  const echo = detectPromptInjection(`${parsed.data.explanation} ${parsed.data.reason_codes.join(" ")}`, "prose");
  if (echo.suspicious) return reject("llm_reject:injection_echo", ...echo.signals);

  if (parsed.data.diagnosis === "unknown") return reject("llm_reject:no_category");

  if (parsed.data.confidence < LLM_CONFIDENCE_FLOOR) return reject("llm_reject:below_confidence_floor");

  return {
    rejected: false,
    diagnosis: {
      category: parsed.data.diagnosis,
      // Capped, and never promoted to "known": only a structured gateway code
      // earns that. An LLM cause is always at most "inferred".
      confidence: Math.min(parsed.data.confidence, LLM_CONFIDENCE_CEILING),
      certaintyClass: "inferred",
      reasonCodes: cleanReasonCodes([
        ...context.deterministic.reasonCodes,
        ...parsed.data.reason_codes,
        "llm_diagnosed",
        `llm_model:${context.modelId}`,
      ]),
      explanation: parsed.data.explanation,
    },
  };
}

/**
 * Validate an untrusted LLM response into a proposal-shaped object. This is not
 * an authority grant: the result must still pass evaluatePolicy before execution.
 */
export function parseLlmProposal(
  raw: unknown,
  fallbackContext: { event: PaymentEvent; profile: CustomerProfile; diagnosis: Diagnosis },
): ActionProposal {
  const fallback = () => {
    const deterministic = proposalFor(fallbackContext.event, fallbackContext.diagnosis, fallbackContext.profile);
    return {
      ...deterministic,
      reasonCodes: [...deterministic.reasonCodes, "llm_output_rejected"],
      explanation: `${deterministic.explanation} The untrusted proposal was malformed and was ignored.`,
    };
  };

  const parsed = llmProposalSchema.safeParse(raw);
  if (!parsed.success) return fallback();

  const echo = detectPromptInjection(`${parsed.data.explanation} ${parsed.data.reason_codes.join(" ")}`, "prose");
  if (echo.suspicious) {
    const rejected = fallback();
    return { ...rejected, reasonCodes: [...rejected.reasonCodes, ...echo.signals] };
  }

  return {
    action: parsed.data.recommended_action,
    confidence: Math.min(parsed.data.confidence, fallbackContext.diagnosis.confidence),
    reasonCodes: cleanReasonCodes(parsed.data.reason_codes),
    explanation: parsed.data.explanation,
    draftedMessage: parsed.data.drafted_message ?? null,
    source: "llm",
  };
}

export { llmProposalSchema, llmDiagnosisSchema };
