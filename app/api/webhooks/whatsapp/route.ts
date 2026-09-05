import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { realtimeServer } from "@/lib/realtime";
import { normalizeToE164 } from "@/lib/normalizer";
import { sendWhatsApp } from "@/lib/whatsapp";

export const runtime = "nodejs";

/** Twilio WhatsApp inbound: customer replies are attached to their latest episode and acknowledged. */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const from = form.get("From");
  const body = (form.get("Body") as string | null)?.trim();
  const messageSid = form.get("MessageSid");

  if (typeof from !== "string" || !body) return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });

  const phone = normalizeToE164(from.replace(/^whatsapp:/, ""));
  if (!phone) return NextResponse.json({ ok: false, error: "bad_number" }, { status: 400 });

  const episode = await store.getLatestEpisodeByPhone(phone);
  if (!episode) {
    await sendWhatsApp(phone, "RecoverOS: Koi active recovery episode nahi mila aapke number ke liye.");
    return NextResponse.json({ ok: true, matched: false });
  }

  const response = {
    responseId: `resp_${messageSid ?? `wa_${Date.now()}`}`,
    channel: "whatsapp" as const,
    text: body,
    confidence: null,
    externalRef: typeof messageSid === "string" ? messageSid : null,
    receivedAt: new Date().toISOString(),
  };
  const updated = await store.appendCustomerResponse(episode.id, response);
  if (updated) {
    await store.appendAudit({
      auditId: `audit_resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      episodeId: episode.id,
      eventId: episode.event.eventId,
      customerId: episode.event.customerId,
      paymentId: episode.event.paymentId,
      timestamp: response.receivedAt,
      stage: "CUSTOMER_RESPONSE",
      payload: { channel: "whatsapp", text: body },
    });
    realtimeServer.emit({ type: "episode.updated", episode: { id: updated.id, status: updated.status, customerId: updated.event.customerId, amountPaise: updated.event.amountPaise } });
  }

  const link = episode.proposal?.action === "PAYMENT_LINK" ? episode.execution?.externalReference : null;
  await sendWhatsApp(phone, `RecoverOS: Aapka jawab note kar liya — "${body}".${link ? ` Payment link: ${link}` : " Team jald follow-up karegi."}`);

  return NextResponse.json({ ok: true, matched: true, episodeId: episode.id });
}
