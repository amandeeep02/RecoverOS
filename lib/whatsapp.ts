import type { RecoveryEpisode } from "@/lib/domain";
import { formatInr } from "@/lib/domain";
import { normalizeToE164 } from "@/lib/normalizer";
import {
  checkWhatsAppSend,
  DEFAULT_COMPLIANCE_CONFIG,
  DEFAULT_WHATSAPP_FOLLOWUP_TEMPLATE_ID,
  minimizeForAudit,
  type ComplianceConfig,
  type ComplianceViolation,
  type MessageClass,
} from "@/lib/compliance";

export function getWhatsAppConfig(): { accountSid: string; authToken: string; fromNumber: string } | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (sid && token && from) return { accountSid: sid, authToken: token, fromNumber: from };
  return null;
}

/**
 * Low-level Twilio transport. No compliance gate here by design: this is
 * called both by `sendCompliantWhatsApp` below (already gated) and directly
 * by inbound-webhook handlers replying to a message the customer just sent
 * (transactional, inside an open WhatsApp session by construction). Any
 * *proactive* (agent/merchant-initiated) send must go through
 * `sendCompliantWhatsApp` / `sendWhatsAppFollowUp` instead of calling this
 * directly, so it cannot skip the WhatsApp/DPDP gate.
 */
export async function sendWhatsApp(toPhone: string, body: string): Promise<{ sid: string; status: string } | { error: string }> {
  const twilio = getWhatsAppConfig();
  if (!twilio) return { error: "Twilio not configured" };
  const to = normalizeToE164(toPhone);
  if (!to) return { error: "Invalid phone" };
  try {
    const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64");
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: `whatsapp:${to}`, From: `whatsapp:${twilio.fromNumber}`, Body: body }),
    });
    const data = await response.json();
    if (data.sid) return { sid: data.sid, status: data.status };
    console.error("WhatsApp send rejected:", data.code, data.message);
    return { error: data.message ?? "send_failed" };
  } catch (error) {
    console.error("WhatsApp send failed:", error);
    return { error: "network_error" };
  }
}

/** Everything sendCompliantWhatsApp needs to decide whether a proactive send
 *  is lawful. There is no "just send it" escape hatch — a caller that omits
 *  a template id and is outside the service window is refused. */
export interface WhatsAppComplianceContext {
  messageClass?: MessageClass;
  optedIn: boolean;
  optedOut: boolean;
  consentValid: boolean;
  /** Last inbound message from this customer on the WhatsApp channel
   *  specifically (a voice-call response does not open a WhatsApp session). */
  lastCustomerMessageAtIso: string | null;
  /** DLT/WhatsApp-registered template id. Required whenever the service
   *  window is not open; the send is impossible without one in that case. */
  templateId?: string | null;
  /** Decision-time "now". Defaults to the real clock — this file is an
   *  executor with I/O, not a pure decision function. */
  nowIso?: string;
  config?: ComplianceConfig;
}

export type WhatsAppSendOutcome =
  | { sent: true; sid: string; status: string }
  | { sent: false; refused: true; violations: ComplianceViolation[] }
  | { sent: false; refused: false; error: string };

/**
 * Compliance-gated WhatsApp send. Refuses (never throws — matches this
 * file's existing `{ error }` result style) instead of sending whenever the
 * WhatsApp Business Platform window/opt-in rule or DPDP consent is not
 * satisfied. This is the only path a proactive, agent-initiated WhatsApp
 * message should take.
 */
export async function sendCompliantWhatsApp(toPhone: string, body: string, context: WhatsAppComplianceContext): Promise<WhatsAppSendOutcome> {
  const config = context.config ?? DEFAULT_COMPLIANCE_CONFIG;
  const nowIso = context.nowIso ?? new Date().toISOString();
  const check = checkWhatsAppSend({
    nowIso,
    messageClass: context.messageClass ?? "transactional",
    optedIn: context.optedIn,
    optedOut: context.optedOut,
    consentValid: context.consentValid,
    lastCustomerMessageAtIso: context.lastCustomerMessageAtIso,
    templateId: context.templateId ?? null,
    config,
  });
  if (!check.allowed) {
    console.error("WhatsApp send refused by compliance gate:", minimizeForAudit({ toPhone, violations: check.violations }));
    return { sent: false, refused: true, violations: check.violations };
  }
  const outcome = await sendWhatsApp(toPhone, body);
  if ("error" in outcome) return { sent: false, refused: false, error: outcome.error };
  return { sent: true, sid: outcome.sid, status: outcome.status };
}

/** Post-call / post-response follow-up: acknowledge the reason and share the
 *  payment path. Always proactive (agent-initiated), so it always goes
 *  through the compliance gate — a payment reminder is transactional, but
 *  the WhatsApp service-window/opt-in check still applies. Falls back to
 *  the default registered template when outside the window. */
export async function sendWhatsAppFollowUp(
  episode: RecoveryEpisode,
  customerReason?: string,
  options: { config?: ComplianceConfig; nowIso?: string } = {},
): Promise<WhatsAppSendOutcome | { sent: false; refused: false; error: "no_phone_on_file" }> {
  if (!episode.profile.phone) return { sent: false, refused: false, error: "no_phone_on_file" };
  const config = options.config ?? DEFAULT_COMPLIANCE_CONFIG;
  const lastWhatsAppMessage = episode.customerResponses
    .filter((r) => r.channel === "whatsapp")
    .reduce<string | null>((latest, r) => (!latest || r.receivedAt > latest ? r.receivedAt : latest), null);
  const link = episode.proposal?.action === "PAYMENT_LINK" ? episode.execution?.externalReference : null;
  const reasonLine = customerReason ? `Aapne bataya: "${customerReason}". ` : "";
  const body = `RecoverOS (${episode.event.merchantId}): ${reasonLine}Aapka ${formatInr(episode.event.amountPaise)} ka payment pending hai.${link ? ` Secure payment link: ${link}` : " Payment complete karne ke liye link jald hi yahan milega."} Dhanyavaad!`;

  return sendCompliantWhatsApp(episode.profile.phone, body, {
    messageClass: "transactional",
    // CustomerProfile has no dedicated WhatsApp opt-in field yet; general
    // contact consent (and no opt-out) is used as a stand-in until domain.ts
    // grows one. Flagged for whoever wires this into the profile schema.
    optedIn: episode.profile.consentValid && !episode.profile.optedOut,
    optedOut: episode.profile.optedOut,
    consentValid: episode.profile.consentValid,
    lastCustomerMessageAtIso: lastWhatsAppMessage,
    templateId: DEFAULT_WHATSAPP_FOLLOWUP_TEMPLATE_ID,
    nowIso: options.nowIso,
    config,
  });
}
