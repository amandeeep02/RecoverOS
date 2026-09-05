// lib/compliance.ts
//
// Compliance-as-code for outbound customer contact and recurring debits.
//
// This module answers one narrow question: "is RecoverOS allowed to make
// *this* contact, *right now*, in *this* way?" It does not decide whether to
// contact a customer at all — that is `lib/policy.ts`'s job (cost, EIR,
// budgets, experiment assignment). This module decides whether a contact
// that policy already wants to make is lawful, and hands back machine-
// readable reasons when it is not.
//
// Design constraints (deliberate, mirrors lib/policy.ts):
//   - Pure. No network I/O, no credentials, no reads of process.env.
//   - Deterministic. No `Date.now()` / `new Date()` with no argument inside
//     any decision function — every function that needs "now" takes an ISO
//     timestamp argument, so decisions replay identically in tests and in
//     the eval harness.
//   - No model, no prompt. A regulation is a table lookup and an arithmetic
//     comparison, never an LLM call.
//
import { rupees } from "@/lib/money";

// Regulatory thresholds below are cited with a source comment. Indian
// telecom/payments regulation has been revised multiple times (RBI has
// consolidated eight prior e-mandate circulars into a single 2026 framework;
// TRAI has amended TCCCPR repeatedly since 2018) — treat every numeric
// default here as "verify before quoting publicly," not as settled law.

// ---------------------------------------------------------------------------
// Regulation & violation vocabulary
// ---------------------------------------------------------------------------

export type RegulationRef =
  | "TRAI_TCCCPR_2018" // Telecom Commercial Communication Customer Preference Regulations
  | "TRAI_DND_NCPR" // National Customer Preference Register ("DND registry")
  | "WHATSAPP_BUSINESS_POLICY" // Meta's WhatsApp Business Platform commerce policy
  | "RBI_EMANDATE_FRAMEWORK" // RBI Digital Payments: E-Mandate Framework
  | "DPDP_ACT_2023"; // Digital Personal Data Protection Act, 2023

export type ComplianceViolationCode =
  | "TRAI_QUIET_HOURS"
  | "DLT_TEMPLATE_MISSING"
  | "DND_PROMOTIONAL_BLOCKED"
  | "WA_OUTSIDE_SERVICE_WINDOW"
  | "WA_TEMPLATE_NOT_PREAPPROVED"
  | "WA_OPT_IN_MISSING"
  | "RBI_PREDEBIT_NOTICE_MISSING"
  | "RBI_AFA_REQUIRED"
  | "DPDP_CONSENT_ABSENT"
  | "DPDP_OPTED_OUT";

export interface ComplianceViolation {
  /** Stable machine code. Never renamed once shipped — dashboards and audit
   *  payloads key off this, not the human-readable reason. */
  code: ComplianceViolationCode;
  /** Human-readable explanation, safe to show a merchant or auditor. */
  reason: string;
  /** Which regulation this gate derives from. */
  regulation: RegulationRef;
}

export type MessageClass = "transactional" | "promotional";
export type Channel = "sms" | "whatsapp" | "voice";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DltTemplate {
  templateId: string;
  /** DLT-registered sender header, e.g. "RCVROS". */
  header: string;
  messageClass: MessageClass;
  approved: boolean;
}

export interface WhatsAppTemplate {
  templateId: string;
  messageClass: MessageClass;
  approved: boolean;
}

export interface ComplianceConfig {
  /**
   * Merchant local-time offset from UTC, in minutes (e.g. +330 for Asia/Kolkata).
   * A fixed offset (not an IANA zone name) so quiet-hours arithmetic stays
   * pure and dependency-free. Exact for India (IST has no DST); a merchant
   * operating in a DST-observing timezone must pass the correct effective
   * offset for the date in question.
   */
  merchantTimeZoneOffsetMinutes: number;

  telemarketing: {
    /**
     * TRAI TCCCPR restricts telemarketing calls and commercial SMS to this
     * local-time window. "Roughly 9am-9pm" is the well-known figure; TRAI
     * has amended TCCCPR more than once since 2018 (most recently Feb 2025 —
     * see trai.gov.in/sites/default/files/2025-02/Regulation_12022025.pdf,
     * and PIB press release PRID 2102413). RE-VERIFY before quoting.
     */
    allowedStartHour: number; // 9  (9 AM, inclusive)
    allowedEndHour: number; // 21 (9 PM, exclusive — 21:00 itself is quiet hours)
    /** ISO "YYYY-MM-DD" dates (merchant-local) on which no telemarketing
     *  contact is permitted at all, e.g. national holidays. Empty by default
     *  — a merchant/ops team must supply its own holiday calendar. */
    blockedDates: string[];
  };

  dlt: {
    /** DLT-registered templates, keyed by templateId. No entry (or an entry
     *  with approved: false) ⇒ SMS is refused outright — this is the "SMS
     *  executor throws without a registered template ID" rule from TCCCPR,
     *  modeled as data rather than hardcoded into the check function. */
    templates: Record<string, DltTemplate>;
  };

  dnd: {
    /** true = promotional (non-transactional) messages require the
     *  customer to have separately opted into promotional comms (DND
     *  "partially blocked" category), even when general contact consent
     *  is valid. Transactional messages (a payment-failure notice) are
     *  never DND-gated — TCCCPR exempts transactional/service messages. */
    promotionalRequiresOptIn: boolean;
  };

  whatsapp: {
    /**
     * WhatsApp Business Platform "customer service window": once a customer
     * messages the business, free-form replies are allowed for this many
     * hours; after it lapses only pre-approved templates may be sent. This
     * is Meta platform policy, not Indian law — see
     * developers.facebook.com/docs/whatsapp/pricing (customer service
     * window). 24h at the time of writing; Meta has changed pricing/window
     * rules before, re-verify.
     */
    serviceWindowHours: number;
    templates: Record<string, WhatsAppTemplate>;
    /** Explicit WhatsApp opt-in required regardless of service window state. */
    requireOptIn: boolean;
  };

  eMandate: {
    /**
     * RBI's e-mandate framework requires notifying the customer before a
     * recurring debit. The 2026 consolidated E-Mandate Framework (21 Apr
     * 2026) states "at least 24 hours before every debit"; every circular
     * back to 2019 also used 24h, though the required notice channel and
     * content have shifted. RE-VERIFY before quoting.
     */
    preDebitNotificationHours: number;
    /**
     * AFA (a second factor, e.g. OTP) is required for a recurring debit
     * above this amount. Raised from ₹5,000 to ₹15,000 by RBI circular
     * RBI/2022-23/106 (Aug 2022). A separate ₹1,00,000 carve-out exists for
     * insurance premiums, mutual-fund SIPs, and credit-card bill payments
     * (RBI clarification, Dec 2023) — NOT modeled here; a merchant in one
     * of those categories should override this config, not this logic. The
     * 2026 E-Mandate Framework consolidates prior circulars — CONFIRM the
     * figure has not moved again before quoting it publicly.
     */
    afaThresholdPaise: number;
  };
}

/**
 * Well-known WhatsApp template id, registered by default so the follow-up
 * path in lib/whatsapp.ts has something to send outside the service window
 * out of the box. A real merchant integration must register its own
 * template with Meta and point config at the real templateId.
 */
export const DEFAULT_WHATSAPP_FOLLOWUP_TEMPLATE_ID = "payment_recovery_followup_v1";

/**
 * Deployment switch: RECOVEROS_DISABLE_QUIET_HOURS=1 widens the TRAI telemarketing
 * window to the whole day for THIS process only. It exists so a demo can be recorded
 * outside 09:00–21:00 IST. It is not a regulatory position: the benchmark and the
 * tests never set it, DEFAULT_COMPLIANCE_CONFIG is untouched, and the dashboard shows
 * a banner while it is on so nothing on screen claims a gate that is not armed.
 */
export function quietHoursDisabled(): boolean {
  return process.env.RECOVEROS_DISABLE_QUIET_HOURS === "1";
}

/** The config this process actually enforces: the given base, minus quiet hours when the switch is on. */
export function runtimeComplianceConfig(base: ComplianceConfig = DEFAULT_COMPLIANCE_CONFIG): ComplianceConfig {
  if (!quietHoursDisabled()) return base;
  return { ...base, telemarketing: { ...base.telemarketing, allowedStartHour: 0, allowedEndHour: 24 } };
}

/** A merchant with nothing registered yet: quiet hours enforced, nothing
 *  pre-approved, opt-in required everywhere. Every real merchant is expected
 *  to override `dlt.templates` / `whatsapp.templates` once they register. */
export const DEFAULT_COMPLIANCE_CONFIG: ComplianceConfig = {
  merchantTimeZoneOffsetMinutes: 330, // Asia/Kolkata, IST (UTC+5:30, no DST)
  telemarketing: { allowedStartHour: 9, allowedEndHour: 21, blockedDates: [] },
  dlt: { templates: {} },
  dnd: { promotionalRequiresOptIn: true },
  whatsapp: {
    serviceWindowHours: 24,
    templates: {
      [DEFAULT_WHATSAPP_FOLLOWUP_TEMPLATE_ID]: {
        templateId: DEFAULT_WHATSAPP_FOLLOWUP_TEMPLATE_ID,
        messageClass: "transactional",
        approved: true,
      },
    },
    requireOptIn: true,
  },
  eMandate: { preDebitNotificationHours: 24, afaThresholdPaise: rupees(15_000) },
};

// ---------------------------------------------------------------------------
// Time helpers (pure — no ambient clock)
// ---------------------------------------------------------------------------

/** Hour-of-day (0-24, fractional) in the given fixed UTC offset. Deliberately
 *  arithmetic rather than Intl/IANA-zone based, so it never depends on the
 *  runtime's timezone database and stays reproducible in CI. */
function localHourOfDay(nowIso: string, offsetMinutes: number): number {
  const utcMs = Date.parse(nowIso);
  const shifted = new Date(utcMs + offsetMinutes * 60_000);
  return shifted.getUTCHours() + shifted.getUTCMinutes() / 60 + shifted.getUTCSeconds() / 3600;
}

/** Merchant-local calendar date ("YYYY-MM-DD") for the given instant. */
function localDateString(nowIso: string, offsetMinutes: number): string {
  const utcMs = Date.parse(nowIso);
  const shifted = new Date(utcMs + offsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** TRAI TCCCPR telemarketing window: commercial calls/SMS only within the
 *  configured local-time band, and never on a configured blocked date. This
 *  is the real implementation behind `CustomerProfile.contactWindowOpen`. */
export function isWithinTelemarketingWindow(nowIso: string, config: ComplianceConfig = DEFAULT_COMPLIANCE_CONFIG): boolean {
  if (config.telemarketing.blockedDates.includes(localDateString(nowIso, config.merchantTimeZoneOffsetMinutes))) {
    return false;
  }
  const hour = localHourOfDay(nowIso, config.merchantTimeZoneOffsetMinutes);
  return hour >= config.telemarketing.allowedStartHour && hour < config.telemarketing.allowedEndHour;
}

function hoursBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return (to - from) / (1000 * 60 * 60);
}

/** True while a WhatsApp customer-service session is open: the customer
 *  messaged within the configured window and "now" hasn't lapsed past it. */
export function isWithinWhatsAppServiceWindow(
  nowIso: string,
  lastCustomerMessageAtIso: string | null,
  config: ComplianceConfig = DEFAULT_COMPLIANCE_CONFIG,
): boolean {
  if (!lastCustomerMessageAtIso) return false;
  const elapsed = hoursBetween(lastCustomerMessageAtIso, nowIso);
  return elapsed !== null && elapsed >= 0 && elapsed < config.whatsapp.serviceWindowHours;
}

// ---------------------------------------------------------------------------
// Aggregate result
// ---------------------------------------------------------------------------

export interface ComplianceResult {
  allowed: boolean;
  violations: ComplianceViolation[];
}

function dpdpViolations(consentValid: boolean, optedOut: boolean): ComplianceViolation[] {
  if (optedOut) {
    return [{ code: "DPDP_OPTED_OUT", reason: "Customer has opted out of contact; DPDP purpose limitation forbids contacting them regardless of channel.", regulation: "DPDP_ACT_2023" }];
  }
  if (!consentValid) {
    return [{ code: "DPDP_CONSENT_ABSENT", reason: "No valid DPDP consent on file for this contact purpose.", regulation: "DPDP_ACT_2023" }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Per-channel helpers — the executors call these directly to refuse
// ---------------------------------------------------------------------------

export interface SmsSendInput {
  nowIso: string;
  messageClass: MessageClass;
  consentValid: boolean;
  optedOut: boolean;
  /** DND "partially blocked" opt-in for promotional content specifically.
   *  Irrelevant for transactional messages. */
  dndPromotionalOptIn?: boolean;
  dltTemplateId?: string | null;
  config?: ComplianceConfig;
}

/** TRAI TCCCPR + DND gate for commercial SMS. A payment-failure notice is
 *  transactional; a discount/incentive offer is promotional and is
 *  DND-gated separately (see `messageClass`). */
export function checkSmsSend(input: SmsSendInput): ComplianceResult {
  const config = input.config ?? DEFAULT_COMPLIANCE_CONFIG;
  const violations: ComplianceViolation[] = [...dpdpViolations(input.consentValid, input.optedOut)];

  if (!isWithinTelemarketingWindow(input.nowIso, config)) {
    violations.push({
      code: "TRAI_QUIET_HOURS",
      reason: `Commercial SMS is restricted to ${config.telemarketing.allowedStartHour}:00-${config.telemarketing.allowedEndHour}:00 merchant-local time under TCCCPR.`,
      regulation: "TRAI_TCCCPR_2018",
    });
  }

  const template = input.dltTemplateId ? config.dlt.templates[input.dltTemplateId] : undefined;
  if (!template || !template.approved) {
    violations.push({
      code: "DLT_TEMPLATE_MISSING",
      reason: "No DLT-registered header/template ID for this SMS. TRAI TCCCPR requires a registered template; unregistered commercial SMS is refused.",
      regulation: "TRAI_TCCCPR_2018",
    });
  } else if (template.messageClass !== input.messageClass) {
    violations.push({
      code: "DLT_TEMPLATE_MISSING",
      reason: `DLT template ${input.dltTemplateId} is registered as ${template.messageClass}, not ${input.messageClass}; a template cannot carry a different message class than it was registered for.`,
      regulation: "TRAI_TCCCPR_2018",
    });
  }

  if (input.messageClass === "promotional" && config.dnd.promotionalRequiresOptIn && !input.dndPromotionalOptIn) {
    violations.push({
      code: "DND_PROMOTIONAL_BLOCKED",
      reason: "Promotional content requires the customer's separate DND promotional opt-in; general contact consent is not sufficient.",
      regulation: "TRAI_DND_NCPR",
    });
  }

  return { allowed: violations.length === 0, violations };
}

export interface VoiceCallCheckInput {
  nowIso: string;
  consentValid: boolean;
  optedOut: boolean;
  config?: ComplianceConfig;
}

/** TRAI TCCCPR + DPDP gate for an outbound telemarketing/collections call. */
export function checkVoiceCall(input: VoiceCallCheckInput): ComplianceResult {
  const config = input.config ?? DEFAULT_COMPLIANCE_CONFIG;
  const violations: ComplianceViolation[] = [...dpdpViolations(input.consentValid, input.optedOut)];

  if (!isWithinTelemarketingWindow(input.nowIso, config)) {
    violations.push({
      code: "TRAI_QUIET_HOURS",
      reason: `Telemarketing calls are restricted to ${config.telemarketing.allowedStartHour}:00-${config.telemarketing.allowedEndHour}:00 merchant-local time under TCCCPR.`,
      regulation: "TRAI_TCCCPR_2018",
    });
  }

  return { allowed: violations.length === 0, violations };
}

export interface WhatsAppSendInput {
  nowIso: string;
  messageClass: MessageClass;
  optedIn: boolean;
  optedOut: boolean;
  consentValid: boolean;
  /** Last inbound WhatsApp message from this customer, if any. Opens/keeps
   *  open the 24h service window. Only a message on the *WhatsApp* channel
   *  counts — a voice-call response does not open a WhatsApp session. */
  lastCustomerMessageAtIso: string | null;
  /** Required outside the service window; must be pre-approved in config. */
  templateId?: string | null;
  config?: ComplianceConfig;
}

/** WhatsApp Business Platform gate: opt-in always required; outside the
 *  24h customer service window only a pre-approved template may be sent. */
export function checkWhatsAppSend(input: WhatsAppSendInput): ComplianceResult {
  const config = input.config ?? DEFAULT_COMPLIANCE_CONFIG;
  const violations: ComplianceViolation[] = [...dpdpViolations(input.consentValid, input.optedOut)];

  if (config.whatsapp.requireOptIn && !input.optedIn) {
    violations.push({
      code: "WA_OPT_IN_MISSING",
      reason: "Customer has not opted into WhatsApp Business messaging.",
      regulation: "WHATSAPP_BUSINESS_POLICY",
    });
  }

  const withinWindow = isWithinWhatsAppServiceWindow(input.nowIso, input.lastCustomerMessageAtIso, config);
  if (!withinWindow) {
    if (!input.templateId) {
      violations.push({
        code: "WA_OUTSIDE_SERVICE_WINDOW",
        reason: `No inbound message from this customer within the ${config.whatsapp.serviceWindowHours}h WhatsApp customer service window; a free-form message would be sent outside it and requires a pre-approved template.`,
        regulation: "WHATSAPP_BUSINESS_POLICY",
      });
    } else if (!config.whatsapp.templates[input.templateId]?.approved) {
      violations.push({
        code: "WA_TEMPLATE_NOT_PREAPPROVED",
        reason: `Template "${input.templateId}" is not a pre-approved WhatsApp template; outside the service window only pre-approved templates may be sent.`,
        regulation: "WHATSAPP_BUSINESS_POLICY",
      });
    }
  }

  return { allowed: violations.length === 0, violations };
}

export interface EMandateDebitCheckInput {
  nowIso: string;
  amountPaise: number;
  /** When the debit is scheduled to occur. */
  scheduledDebitAtIso: string | null;
  /** When the pre-debit notification was actually sent, if it was. */
  preDebitNotificationSentAtIso: string | null;
  /** Whether AFA (e.g. OTP) has already been completed for this debit. */
  afaCompleted: boolean;
  config?: ComplianceConfig;
}

/** RBI e-mandate gate for a recurring debit (a RETRY on a mandate, or the
 *  first automated debit attempt). Both checks are independent — either can
 *  fail on its own. */
export function checkEMandateDebit(input: EMandateDebitCheckInput): ComplianceResult {
  const config = input.config ?? DEFAULT_COMPLIANCE_CONFIG;
  const violations: ComplianceViolation[] = [];

  if (!hasValidPreDebitNotice(input, config)) {
    violations.push({
      code: "RBI_PREDEBIT_NOTICE_MISSING",
      reason: `RBI's e-mandate framework requires the customer be notified at least ${config.eMandate.preDebitNotificationHours}h before a recurring debit; no valid notification is on record for this debit.`,
      regulation: "RBI_EMANDATE_FRAMEWORK",
    });
  }

  if (input.amountPaise > config.eMandate.afaThresholdPaise && !input.afaCompleted) {
    violations.push({
      code: "RBI_AFA_REQUIRED",
      reason: `Recurring debit of ${input.amountPaise}p exceeds the ${config.eMandate.afaThresholdPaise}p no-AFA threshold; Additional Factor Authentication is required and has not been completed. This must escalate, never silently retry.`,
      regulation: "RBI_EMANDATE_FRAMEWORK",
    });
  }

  return { allowed: violations.length === 0, violations };
}

function hasValidPreDebitNotice(input: EMandateDebitCheckInput, config: ComplianceConfig): boolean {
  if (!input.preDebitNotificationSentAtIso || !input.scheduledDebitAtIso) return false;
  const leadHours = hoursBetween(input.preDebitNotificationSentAtIso, input.scheduledDebitAtIso);
  return leadHours !== null && leadHours >= config.eMandate.preDebitNotificationHours;
}

// ---------------------------------------------------------------------------
// Single entry point
// ---------------------------------------------------------------------------

export interface ComplianceCheckInput {
  channel: Channel;
  /** Defaults to "transactional" when omitted — the stricter class must be
   *  requested explicitly, never inferred from a missing field. */
  messageClass?: MessageClass;
  nowIso: string;
  consentValid: boolean;
  optedOut: boolean;
  config?: ComplianceConfig;
  sms?: { dltTemplateId?: string | null; dndPromotionalOptIn?: boolean };
  whatsapp?: { optedIn: boolean; lastCustomerMessageAtIso: string | null; templateId?: string | null };
  /** Present only when this contact is (or accompanies) a recurring debit. */
  eMandate?: {
    amountPaise: number;
    scheduledDebitAtIso: string | null;
    preDebitNotificationSentAtIso: string | null;
    afaCompleted: boolean;
  };
}

/** Single entry point: evaluates every applicable regulation for one
 *  proposed contact/debit and returns every violation found, not just the
 *  first. `allowed` is true only when the list is empty. */
export function checkCompliance(input: ComplianceCheckInput): ComplianceResult {
  const config = input.config ?? DEFAULT_COMPLIANCE_CONFIG;
  const messageClass = input.messageClass ?? "transactional";
  const violations: ComplianceViolation[] = [];

  if (input.channel === "sms") {
    violations.push(
      ...checkSmsSend({
        nowIso: input.nowIso,
        messageClass,
        consentValid: input.consentValid,
        optedOut: input.optedOut,
        dndPromotionalOptIn: input.sms?.dndPromotionalOptIn,
        dltTemplateId: input.sms?.dltTemplateId,
        config,
      }).violations,
    );
  } else if (input.channel === "whatsapp") {
    violations.push(
      ...checkWhatsAppSend({
        nowIso: input.nowIso,
        messageClass,
        optedIn: input.whatsapp?.optedIn ?? false,
        optedOut: input.optedOut,
        consentValid: input.consentValid,
        lastCustomerMessageAtIso: input.whatsapp?.lastCustomerMessageAtIso ?? null,
        templateId: input.whatsapp?.templateId,
        config,
      }).violations,
    );
  } else if (input.channel === "voice") {
    violations.push(
      ...checkVoiceCall({
        nowIso: input.nowIso,
        consentValid: input.consentValid,
        optedOut: input.optedOut,
        config,
      }).violations,
    );
  }

  if (input.eMandate) {
    violations.push(
      ...checkEMandateDebit({
        nowIso: input.nowIso,
        amountPaise: input.eMandate.amountPaise,
        scheduledDebitAtIso: input.eMandate.scheduledDebitAtIso,
        preDebitNotificationSentAtIso: input.eMandate.preDebitNotificationSentAtIso,
        afaCompleted: input.eMandate.afaCompleted,
        config,
      }).violations,
    );
  }

  // A caller can legitimately hit the same DPDP gate twice (e.g. channel
  // check + eMandate check both run dpdpViolations-equivalent logic in the
  // future) — de-dupe by code so `violations` stays a set of distinct
  // reasons, not a multiset.
  const seen = new Set<ComplianceViolationCode>();
  const deduped = violations.filter((v) => {
    if (seen.has(v.code)) return false;
    seen.add(v.code);
    return true;
  });

  return { allowed: deduped.length === 0, violations: deduped };
}

// ---------------------------------------------------------------------------
// DPDP Act 2023 — audit minimization
// ---------------------------------------------------------------------------

const PII_KEY_HINTS = new Set([
  "phone",
  "phonenumber",
  "customerphone",
  "tophone",
  "frmphone",
  "fromphone",
  "contact",
  "e164phone",
  "waphone",
  "mobile",
  "msisdn",
]);

/** Loosely matches a phone-shaped string (E.164 or Indian local format)
 *  regardless of which key it was found under, as a defense-in-depth catch
 *  for PII that isn't under an expected key name. */
function looksLikePhoneNumber(value: string): boolean {
  const trimmed = value.trim();
  if (!/^\+?[\d][\d\s-]{6,}$/.test(trimmed)) return false;
  const digits = trimmed.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15;
}

function redactPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 2) return "[REDACTED]";
  return `[REDACTED:***${digits.slice(-2)}]`;
}

function redactValue(value: unknown, keyHint?: string): unknown {
  if (typeof value === "string") {
    const keyIsPii = !!keyHint && PII_KEY_HINTS.has(keyHint.toLowerCase());
    if (keyIsPii || looksLikePhoneNumber(value)) return redactPhone(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(entry, key);
    }
    return out;
  }
  return value;
}

/**
 * DPDP Act 2023 purpose-limitation helper. Redacts phone/contact PII from a
 * payload before it is written to the (append-only) audit log, keeping
 * every other field intact so the audit trail stays useful without
 * retaining more personal data than the audit purpose requires. Matches by
 * key name (phone, contact, msisdn, ...) and, as a backstop, by value shape
 * (anything that parses as a phone number), so a differently-named field
 * carrying a phone number is still caught.
 */
export function minimizeForAudit<T>(payload: T): T {
  return redactValue(payload) as T;
}
