import { randomUUID } from "node:crypto";
import type { ExecutionResult, PaymentEvent } from "@/lib/domain";
import type { RecoveryStore } from "@/lib/store";

type ExecutionInput = {
  episodeId: string;
  event: PaymentEvent;
  action: "PAYMENT_LINK" | "REMINDER" | "RETRY";
};

/** Credential boundary: only this module reads Razorpay credentials. */
export async function executeApprovedAction(input: ExecutionInput, recoveryStore: RecoveryStore): Promise<ExecutionResult> {
  const idempotencyKey = `${input.episodeId}:${input.action}`;
  const prior = await recoveryStore.getExecution(idempotencyKey);
  if (prior) return { ...prior, idempotentReplay: true };

  let result: ExecutionResult;
  if (input.action === "PAYMENT_LINK" && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    result = await createRazorpayTestPaymentLink(input);
  } else {
    result = {
      actionId: randomUUID(),
      status: "SIMULATED",
      executor: input.action === "PAYMENT_LINK" ? "simulated_executor" : "simulated_executor",
      externalReference: `sim_${input.action.toLowerCase()}_${input.event.paymentId}`,
      idempotentReplay: false,
      error: null,
      executedAt: new Date().toISOString(),
    };
  }
  await recoveryStore.saveExecution(idempotencyKey, input.episodeId, input.action, result);
  return result;
}

async function createRazorpayTestPaymentLink(input: ExecutionInput): Promise<ExecutionResult> {
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
  try {
    const response = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: input.event.amountPaise,
        currency: "INR",
        reference_id: input.episodeId.slice(0, 40),
        description: `Recover failed subscription payment ${input.event.paymentId}`,
        customer: { name: `Customer ${input.event.customerId.slice(-6)}` },
        notify: { sms: false, email: false },
        notes: { recoveros_episode_id: input.episodeId, payment_id: input.event.paymentId },
      }),
    });
    const data = (await response.json()) as { id?: string; error?: { description?: string } };
    if (!response.ok || !data.id) throw new Error(data.error?.description ?? `Razorpay returned ${response.status}`);
    return {
      actionId: randomUUID(),
      status: "EXECUTED",
      executor: "razorpay_payment_link_api",
      externalReference: data.id,
      idempotentReplay: false,
      error: null,
      executedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      actionId: randomUUID(),
      status: "FAILED",
      executor: "razorpay_payment_link_api",
      externalReference: null,
      idempotentReplay: false,
      error: error instanceof Error ? error.message : "Unknown Razorpay executor error",
      executedAt: new Date().toISOString(),
    };
  }
}
