import { randomUUID } from "node:crypto";
import type { ExecutionResult, PaymentEvent } from "@/lib/domain";
import type { RecoveryStore } from "@/lib/store";

type ExecutionInput = {
  episodeId: string;
  event: PaymentEvent;
  action: "PAYMENT_LINK" | "REMINDER" | "RETRY";
};

/** Injectable so the executor's retry, timeout and persistence rules are testable
 *  without a network or a wall clock. Production supplies none of these. */
export interface ExecutorDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  maxRateLimitRetries: number;
  retryBaseMs: number;
}

const DEFAULT_DEPS: ExecutorDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs: Number(process.env.RAZORPAY_TIMEOUT_MS ?? 8_000),
  maxRateLimitRetries: 2,
  retryBaseMs: 250,
};

/**
 * A failed attempt is not the same fact as a refused one.
 *
 * `durable: false` means the executor learned nothing about whether the action can
 * ever succeed — a socket died, a deadline passed, Razorpay returned 502 or asked us
 * to slow down. Writing that to the idempotency key turns a five-second blip into a
 * permanent refusal: `getExecution` finds the FAILED row on every subsequent attempt
 * and the episode can never be retried, for the life of the row. So transient
 * outcomes are returned and not persisted, and the key stays free for a real answer.
 */
interface ExecutorAttempt {
  result: ExecutionResult;
  durable: boolean;
}

/** Credential boundary: only this module reads Razorpay credentials. */
export async function executeApprovedAction(
  input: ExecutionInput,
  recoveryStore: RecoveryStore,
  overrides: Partial<ExecutorDeps> = {},
): Promise<ExecutionResult> {
  const deps: ExecutorDeps = { ...DEFAULT_DEPS, ...overrides };
  const idempotencyKey = `${input.episodeId}:${input.action}`;
  const prior = await recoveryStore.getExecution(idempotencyKey);
  if (prior) return { ...prior, idempotentReplay: true };

  let attempt: ExecutorAttempt;
  if (input.action === "PAYMENT_LINK" && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    attempt = await createRazorpayTestPaymentLink(input, idempotencyKey, deps);
  } else {
    attempt = simulated(input);
  }

  if (attempt.durable) await recoveryStore.saveExecution(idempotencyKey, input.episodeId, input.action, attempt.result);
  return attempt.result;
}

function failure(error: string, durable: boolean): ExecutorAttempt {
  return {
    durable,
    result: {
      actionId: randomUUID(),
      status: "FAILED",
      executor: "razorpay_payment_link_api",
      externalReference: null,
      idempotentReplay: false,
      error,
      executedAt: new Date().toISOString(),
    },
  };
}

function success(externalReference: string): ExecutorAttempt {
  return {
    durable: true,
    result: {
      actionId: randomUUID(),
      status: "EXECUTED",
      executor: "razorpay_payment_link_api",
      externalReference,
      idempotentReplay: false,
      error: null,
      executedAt: new Date().toISOString(),
    },
  };
}

/** The executor that labels itself: nothing on screen claims a live API call it did not make. */
function simulated(input: ExecutionInput, note: string | null = null): ExecutorAttempt {
  return {
    durable: true,
    result: {
      actionId: randomUUID(),
      status: "SIMULATED",
      executor: "simulated_executor",
      externalReference: `sim_${input.action.toLowerCase()}_${input.event.paymentId}`,
      idempotentReplay: false,
      error: note,
      executedAt: new Date().toISOString(),
    },
  };
}

/**
 * Razorpay test mode allows 30 payment links per account, ever; cancelling does not
 * free them. That 429 is not "slow down", it is "this sandbox cannot create links",
 * and retrying it is pointless. It is also not a decision failure: the policy approved
 * the action and only the sandbox declined to mint the artifact. So it degrades to the
 * simulated executor, durably and labelled, exactly as running without keys does.
 * A production 429 carries no such text and keeps its transient handling below.
 */
function isTestModeCap(body: { error?: { code?: string; description?: string } }): boolean {
  return body.error?.code === "RATE_LIMIT_EXCEEDED" && /test mode limit/i.test(body.error.description ?? "");
}

/** Razorpay refuses a second link on a reference_id it already holds. That refusal is
 *  the orphan we are looking for, not an error. */
function isDuplicateReference(status: number, description: string): boolean {
  return status === 400 && /reference[_\s]?id/i.test(description);
}

function retryAfterMs(response: Response, attemptIndex: number, deps: ExecutorDeps): number {
  const header = response.headers?.get?.("retry-after");
  const seconds = header === null || header === undefined ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 10_000);
  return Math.min(deps.retryBaseMs * 2 ** attemptIndex, 10_000);
}

async function createRazorpayTestPaymentLink(input: ExecutionInput, idempotencyKey: string, deps: ExecutorDeps): Promise<ExecutorAttempt> {
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
  // Deterministic per episode, and Razorpay enforces its uniqueness. This is what
  // stops a create that timed out on our side — but landed on theirs — from
  // orphaning a live plink_ that we then duplicate on the retry.
  const referenceId = input.episodeId.slice(0, 40);
  const headers = {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json",
    // Sent as well as the reference_id: the header lets Razorpay collapse the retry
    // itself, the reference_id lets us recover the link if it does not.
    "X-Razorpay-Idempotency-Key": idempotencyKey,
  };
  const body = JSON.stringify({
    amount: input.event.amountPaise,
    currency: "INR",
    reference_id: referenceId,
    description: `Recover failed subscription payment ${input.event.paymentId}`,
    customer: { name: `Customer ${input.event.customerId.slice(-6)}` },
    notify: { sms: false, email: false },
    notes: { recoveros_episode_id: input.episodeId, payment_id: input.event.paymentId },
  });

  for (let attemptIndex = 0; ; attemptIndex++) {
    let response: Response;
    try {
      response = await deps.fetch("https://api.razorpay.com/v1/payment_links", {
        method: "POST",
        headers,
        body,
        // Without a deadline a hung socket holds the webhook worker open until the
        // platform kills it, and the episode is neither executed nor retryable.
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
    } catch (error) {
      // A throw here is a socket, a DNS answer or a deadline — never a decision.
      const message = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown Razorpay transport error";
      const orphan = await findExistingPaymentLink(referenceId, headers, deps);
      return orphan ?? failure(message, false);
    }

    if (response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as { error?: { code?: string; description?: string } };
      if (isTestModeCap(body)) return simulated(input, `Razorpay ${body.error?.description}; executed by the simulated executor`);
      if (attemptIndex < deps.maxRateLimitRetries) {
        await deps.sleep(retryAfterMs(response, attemptIndex, deps));
        continue;
      }
      return failure("Razorpay rate limited the request (429)", false);
    }

    let data: { id?: string; error?: { description?: string } } = {};
    try {
      data = (await response.json()) as typeof data;
    } catch {
      data = {};
    }

    if (response.ok && data.id) return success(data.id);

    const description = data.error?.description ?? `Razorpay returned ${response.status}`;

    if (isDuplicateReference(response.status, description)) {
      const orphan = await findExistingPaymentLink(referenceId, headers, deps);
      if (orphan) return orphan;
    }

    // 5xx and 408 are Razorpay's problem and may clear on their own; every other
    // status is an answer about this request and will be the same answer next time.
    const transient = response.status >= 500 || response.status === 408;
    return failure(description, !transient);
  }
}

/**
 * Recover a link that was created but whose response we never saw. Best effort by
 * design: if the lookup itself fails we fall back to reporting the original
 * transient failure rather than inventing an outcome.
 */
async function findExistingPaymentLink(referenceId: string, headers: Record<string, string>, deps: ExecutorDeps): Promise<ExecutorAttempt | null> {
  try {
    const response = await deps.fetch(`https://api.razorpay.com/v1/payment_links?reference_id=${encodeURIComponent(referenceId)}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { payment_links?: Array<{ id?: string }> };
    const existing = data.payment_links?.find((link) => typeof link.id === "string" && link.id.length > 0);
    return existing?.id ? success(existing.id) : null;
  } catch {
    return null;
  }
}
