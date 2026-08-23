import { z } from "zod";
import { actionSchema, type ActionProposal, type CustomerProfile, type Diagnosis, type PaymentEvent } from "@/lib/domain";
import { proposalFor } from "@/lib/scoring";

const llmProposalSchema = z.object({
  diagnosis: z.string().min(1),
  certainty_class: z.enum(["known", "inferred", "unknown"]),
  confidence: z.number().min(0).max(1),
  recommended_action: actionSchema,
  reason_codes: z.array(z.string()).max(8),
  explanation: z.string().min(1).max(800),
  drafted_message: z.string().max(600).nullable().optional(),
});

/**
 * Validate an untrusted LLM response into a proposal-shaped object. This is not
 * an authority grant: the result must still pass evaluatePolicy before execution.
 */
export function parseLlmProposal(
  raw: unknown,
  fallbackContext: { event: PaymentEvent; profile: CustomerProfile; diagnosis: Diagnosis },
): ActionProposal {
  const parsed = llmProposalSchema.safeParse(raw);
  if (!parsed.success) {
    const fallback = proposalFor(fallbackContext.event, fallbackContext.diagnosis, fallbackContext.profile);
    return {
      ...fallback,
      reasonCodes: [...fallback.reasonCodes, "llm_output_rejected"],
      explanation: `${fallback.explanation} The untrusted proposal was malformed and was ignored.`,
    };
  }
  return {
    action: parsed.data.recommended_action,
    confidence: Math.min(parsed.data.confidence, fallbackContext.diagnosis.confidence),
    reasonCodes: parsed.data.reason_codes,
    explanation: parsed.data.explanation,
    draftedMessage: parsed.data.drafted_message ?? null,
    source: "llm",
  };
}

export { llmProposalSchema };
