import type { Diagnosis, PaymentEvent } from "@/lib/domain";

const knownFailureCodes: Record<string, Omit<Diagnosis, "reasonCodes">> = {
  insufficient_funds: {
    category: "insufficient_balance",
    confidence: 0.96,
    certaintyClass: "known",
    explanation: "The issuer reported insufficient balance; a customer-directed recovery path may help after native recovery ends.",
  },
  bank_declined: {
    category: "temporary_bank_decline",
    confidence: 0.9,
    certaintyClass: "known",
    explanation: "The issuer declined the payment without a terminal credential or mandate signal.",
  },
  expired_card: {
    category: "expired_payment_credential",
    confidence: 0.98,
    certaintyClass: "known",
    explanation: "The payment credential has expired and needs a customer update.",
  },
  authentication_failed: {
    category: "authentication_issue",
    confidence: 0.97,
    certaintyClass: "known",
    explanation: "Authentication failed; the customer may need to re-authenticate the payment method.",
  },
  mandate_rejected: {
    category: "mandate_issue",
    confidence: 0.98,
    certaintyClass: "known",
    explanation: "The recurring-payment mandate was rejected and should not be retried blindly.",
  },
  permanent_decline: {
    category: "permanent_decline",
    confidence: 0.98,
    certaintyClass: "known",
    explanation: "The issuer supplied a terminal decline signal; automated recovery has low expected value.",
  },
  network_error: {
    category: "network_gateway_failure",
    confidence: 0.82,
    certaintyClass: "known",
    explanation: "A transient network or gateway error occurred; native recovery is the lowest-friction next step.",
  },
};

/** Structured codes win. This module deliberately has no executor or credential access. */
export function diagnose(event: PaymentEvent): Diagnosis {
  const code = event.failureCode?.toLowerCase() ?? "";
  const known = knownFailureCodes[code];
  if (known) {
    return { ...known, reasonCodes: [code, `source:${event.failureSource}`] };
  }

  if (event.failureSource === "network" || event.failureSource === "gateway") {
    return {
      category: "network_gateway_failure",
      confidence: 0.58,
      certaintyClass: "inferred",
      reasonCodes: [`source:${event.failureSource}`],
      explanation: "The source suggests a transient rail issue, but no structured failure code confirms the cause.",
    };
  }

  return {
    category: "unknown",
    confidence: 0.25,
    certaintyClass: "unknown",
    reasonCodes: [code || "missing_failure_code", `source:${event.failureSource}`],
    explanation: "No supported structured signal identifies the failure cause. This case should not receive aggressive automated treatment.",
  };
}
