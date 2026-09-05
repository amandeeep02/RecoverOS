import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { postSignedRazorpayWebhook } from "@/app/_lib/signed-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The live loop beat (IDEA.md §11, 0:35).
 *
 * This does not shortcut the pipeline. It builds a Razorpay-shaped `payment.failed`
 * body, signs it with the configured webhook secret, and POSTs it to the REAL
 * `/api/webhooks/razorpay` route over HTTP — so the signature check, the
 * normalizer, the idempotency guard, the degradation detector and the policy engine
 * all run exactly as they do for a webhook from Razorpay.
 *
 * With `paidEpisodeId` it plays the other half: the customer paying the link. It reads
 * the link id the executor actually recorded on that episode and POSTs a signed
 * `payment_link.paid` for it, so the same route closes the loop it opened.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    amountRupees?: number;
    method?: "card" | "upi" | "netbanking" | "wallet";
    failureCode?: string;
    issuer?: string;
    network?: string;
    nativeRecoveryState?: "ACTIVE" | "EXHAUSTED" | "UNKNOWN";
    paidEpisodeId?: string;
  };

  const suffix = Date.now().toString(36);
  const payload = body.paidEpisodeId ? await paidPayload(body.paidEpisodeId, suffix) : failedPayload(body, suffix);
  if (!payload) {
    return NextResponse.json({ error: "episode has no executed payment link to pay" }, { status: 409 });
  }
  return postSigned(request, payload, suffix, body);
}

/** The worker executes a few hundred ms after the 202; give it a moment to record the link. */
async function paidPayload(episodeId: string, suffix: string) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const episode = await store.getEpisode(episodeId);
    const linkId = episode?.execution?.externalReference;
    if (episode && linkId) {
      return {
        event: "payment_link.paid",
        account_id: episode.event.merchantId,
        created_at: Math.floor(Date.now() / 1000),
        payload: {
          payment_link: {
            entity: {
              id: linkId,
              reference_id: episode.id.slice(0, 40),
              status: "paid",
              amount: episode.event.amountPaise,
              amount_paid: episode.event.amountPaise,
              notes: { recoveros_episode_id: episode.id, payment_id: episode.event.paymentId },
            },
          },
          payment: { entity: { id: `pay_settle_${suffix}`, amount: episode.event.amountPaise, status: "captured", method: episode.event.paymentMethod } },
        },
      };
    }
    if (!episode) return null;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

function failedPayload(body: { amountRupees?: number; method?: string; failureCode?: string; nativeRecoveryState?: string }, suffix: string) {
  const amountPaise = Math.round((body.amountRupees ?? 4_999) * 100);
  const method = body.method ?? "card";
  return {
    event: "payment.failed",
    account_id: "merchant_demo",
    created_at: Math.floor(Date.now() / 1000),
    native_recovery_state: body.nativeRecoveryState ?? "EXHAUSTED",
    payload: {
      payment: {
        entity: {
          id: `pay_live_${suffix}`,
          amount: amountPaise,
          method,
          status: "failed",
          error_code: body.failureCode ?? "expired_card",
          error_source: "bank",
          customer_id: `cust_live_${suffix}`,
          subscription_id: `sub_live_${suffix}`,
        },
      },
    },
  };
}

async function postSigned(request: NextRequest, payload: object, suffix: string, body: { issuer?: string; network?: string }) {
  const posted = await postSignedRazorpayWebhook(request.nextUrl.origin, payload, `evt_live_${suffix}`);
  return NextResponse.json(
    { posted: { url: posted.url, signed: posted.signed, issuer: body.issuer ?? null, network: body.network ?? null }, status: posted.status, result: posted.result },
    { status: posted.ok ? 200 : posted.status },
  );
}
