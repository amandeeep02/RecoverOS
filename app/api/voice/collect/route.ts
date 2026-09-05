import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { realtimeServer } from "@/lib/realtime";
import { sendWhatsAppFollowUp } from "@/lib/whatsapp";

export const runtime = "nodejs";

const TWIML_HEADERS = { "Content-Type": "text/xml" };

function twiml(body: string) {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: TWIML_HEADERS });
}

/** Receives the customer's spoken answer from Twilio <Gather> and attaches it to the episode. */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const callSid = form.get("CallSid");
  const speech = (form.get("SpeechResult") as string | null)?.trim();
  const digits = (form.get("Digits") as string | null)?.trim();
  const confidence = Number(form.get("Confidence"));

  if (typeof callSid !== "string") return twiml("<Say>Goodbye.</Say>");

  const episode = await store.getEpisodeByCallSid(callSid);
  if (!episode) return twiml("<Say>Goodbye.</Say>");

  const text = speech || (digits ? `Pressed ${digits}` : "No response captured");
  const response = {
    responseId: `resp_${callSid}_${Date.now()}`,
    channel: "voice" as const,
    text,
    confidence: Number.isFinite(confidence) && confidence > 0 ? confidence : null,
    externalRef: callSid,
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
      payload: { channel: "voice", text, confidence: response.confidence },
    });
    realtimeServer.emit({
      type: "customer.responded",
      episode: { id: updated.id, status: updated.status, customerId: updated.event.customerId, amountPaise: updated.event.amountPaise },
      text,
      confidence: response.confidence,
    });
    void sendWhatsAppFollowUp(updated, text);
  }

  return twiml(`<Say voice="Polly.Aditi" language="hi-IN">Dhanyavaad! Aapka jawab record ho gaya. Hum jaldi payment link bhejenge. Alvida.</Say>`);
}
