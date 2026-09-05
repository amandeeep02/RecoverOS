import { describe, expect, it } from "vitest";
import {
  checkCompliance,
  checkEMandateDebit,
  checkSmsSend,
  checkWhatsAppSend,
  DEFAULT_COMPLIANCE_CONFIG,
  isWithinTelemarketingWindow,
  minimizeForAudit,
  type ComplianceConfig,
} from "@/lib/compliance";
import { evaluatePolicy } from "@/lib/policy";
import { defaultMerchantPolicy } from "@/lib/pipeline";

const config: ComplianceConfig = DEFAULT_COMPLIANCE_CONFIG;

const approvedSmsTemplateId = "txn_payment_failed_v1";
const smsConfig: ComplianceConfig = {
  ...config,
  dlt: {
    templates: {
      [approvedSmsTemplateId]: { templateId: approvedSmsTemplateId, header: "RCVROS", messageClass: "transactional", approved: true },
    },
  },
};

const approvedWhatsAppTemplateId = "wa_payment_reminder_v1";
const whatsAppConfig: ComplianceConfig = {
  ...config,
  whatsapp: {
    ...config.whatsapp,
    templates: {
      ...config.whatsapp.templates,
      [approvedWhatsAppTemplateId]: { templateId: approvedWhatsAppTemplateId, messageClass: "transactional", approved: true },
    },
  },
};

describe("TRAI TCCCPR quiet-hours boundary", () => {
  // Merchant offset is +330min (IST). Local 9:00am == UTC 03:30, local 9:00pm == UTC 15:30.
  it("allows contact exactly at the 9am open boundary", () => {
    expect(isWithinTelemarketingWindow("2026-01-15T03:30:00.000Z", config)).toBe(true);
  });

  it("blocks contact one minute before the 9am open boundary", () => {
    expect(isWithinTelemarketingWindow("2026-01-15T03:29:00.000Z", config)).toBe(false);
  });

  it("allows contact one minute before the 9pm close boundary", () => {
    expect(isWithinTelemarketingWindow("2026-01-15T15:29:00.000Z", config)).toBe(true);
  });

  it("blocks contact exactly at the 9pm close boundary (21:00 is quiet hours)", () => {
    expect(isWithinTelemarketingWindow("2026-01-15T15:30:00.000Z", config)).toBe(false);
  });

  it("blocks a configured national-holiday date even during allowed hours", () => {
    const holidayConfig: ComplianceConfig = { ...config, telemarketing: { ...config.telemarketing, blockedDates: ["2026-01-15"] } };
    expect(isWithinTelemarketingWindow("2026-01-15T06:00:00.000Z", holidayConfig)).toBe(false);
  });

  it("propagates the quiet-hours violation through checkVoiceCall via checkCompliance", () => {
    const result = checkCompliance({
      channel: "voice",
      nowIso: "2026-01-15T16:00:00.000Z", // 21:30 IST, outside window
      consentValid: true,
      optedOut: false,
      config,
    });
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("TRAI_QUIET_HOURS");
  });
});

describe("DLT template requirement (TRAI TCCCPR)", () => {
  const withinWindowIso = "2026-01-15T06:00:00.000Z"; // 11:30 IST

  it("refuses commercial SMS with no template id at all", () => {
    const result = checkSmsSend({ nowIso: withinWindowIso, messageClass: "transactional", consentValid: true, optedOut: false, dltTemplateId: null, config: smsConfig });
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("DLT_TEMPLATE_MISSING");
  });

  it("refuses commercial SMS with an unregistered template id", () => {
    const result = checkSmsSend({ nowIso: withinWindowIso, messageClass: "transactional", consentValid: true, optedOut: false, dltTemplateId: "not_registered", config: smsConfig });
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("DLT_TEMPLATE_MISSING");
  });

  it("allows commercial SMS once a registered, approved, class-matching template id is supplied", () => {
    const result = checkSmsSend({ nowIso: withinWindowIso, messageClass: "transactional", consentValid: true, optedOut: false, dltTemplateId: approvedSmsTemplateId, config: smsConfig });
    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

describe("transactional vs. promotional DND split", () => {
  const withinWindowIso = "2026-01-15T06:00:00.000Z";

  it("does not DND-gate a transactional payment-failure notice", () => {
    const result = checkSmsSend({
      nowIso: withinWindowIso,
      messageClass: "transactional",
      consentValid: true,
      optedOut: false,
      dndPromotionalOptIn: false, // no promotional opt-in — irrelevant for a transactional message
      dltTemplateId: approvedSmsTemplateId,
      config: smsConfig,
    });
    expect(result.allowed).toBe(true);
  });

  it("DND-gates a promotional/incentive message when the customer has not separately opted in", () => {
    const promoTemplateId = "promo_discount_v1";
    const promoConfig: ComplianceConfig = {
      ...smsConfig,
      dlt: { templates: { ...smsConfig.dlt.templates, [promoTemplateId]: { templateId: promoTemplateId, header: "RCVROS", messageClass: "promotional", approved: true } } },
    };
    const result = checkSmsSend({
      nowIso: withinWindowIso,
      messageClass: "promotional",
      consentValid: true,
      optedOut: false,
      dndPromotionalOptIn: false,
      dltTemplateId: promoTemplateId,
      config: promoConfig,
    });
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("DND_PROMOTIONAL_BLOCKED");
  });

  it("allows the same promotional message once the customer has opted in", () => {
    const promoTemplateId = "promo_discount_v1";
    const promoConfig: ComplianceConfig = {
      ...smsConfig,
      dlt: { templates: { ...smsConfig.dlt.templates, [promoTemplateId]: { templateId: promoTemplateId, header: "RCVROS", messageClass: "promotional", approved: true } } },
    };
    const result = checkSmsSend({
      nowIso: withinWindowIso,
      messageClass: "promotional",
      consentValid: true,
      optedOut: false,
      dndPromotionalOptIn: true,
      dltTemplateId: promoTemplateId,
      config: promoConfig,
    });
    expect(result.allowed).toBe(true);
  });
});

describe("WhatsApp 24h customer service window", () => {
  const now = "2026-01-15T12:00:00.000Z";

  it("allows a free-form reply just inside the window (23h since last customer message)", () => {
    const lastMessage = new Date(Date.parse(now) - 23 * 60 * 60 * 1000).toISOString();
    const result = checkWhatsAppSend({ nowIso: now, messageClass: "transactional", optedIn: true, optedOut: false, consentValid: true, lastCustomerMessageAtIso: lastMessage, templateId: null, config });
    expect(result.allowed).toBe(true);
  });

  it("refuses a free-form (templateless) message just outside the window (25h since last customer message)", () => {
    const lastMessage = new Date(Date.parse(now) - 25 * 60 * 60 * 1000).toISOString();
    const result = checkWhatsAppSend({ nowIso: now, messageClass: "transactional", optedIn: true, optedOut: false, consentValid: true, lastCustomerMessageAtIso: lastMessage, templateId: null, config });
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("WA_OUTSIDE_SERVICE_WINDOW");
  });

  it("refuses outside the window even with no prior customer message at all", () => {
    const result = checkWhatsAppSend({ nowIso: now, messageClass: "transactional", optedIn: true, optedOut: false, consentValid: true, lastCustomerMessageAtIso: null, templateId: null, config });
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("WA_OUTSIDE_SERVICE_WINDOW");
  });

  it("allows an outside-window send once a pre-approved template id is supplied", () => {
    const result = checkWhatsAppSend({
      nowIso: now,
      messageClass: "transactional",
      optedIn: true,
      optedOut: false,
      consentValid: true,
      lastCustomerMessageAtIso: null,
      templateId: approvedWhatsAppTemplateId,
      config: whatsAppConfig,
    });
    expect(result.allowed).toBe(true);
  });

  it("still refuses without WhatsApp opt-in, even inside the window", () => {
    const lastMessage = new Date(Date.parse(now) - 1 * 60 * 60 * 1000).toISOString();
    const result = checkWhatsAppSend({ nowIso: now, messageClass: "transactional", optedIn: false, optedOut: false, consentValid: true, lastCustomerMessageAtIso: lastMessage, templateId: null, config });
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("WA_OPT_IN_MISSING");
  });
});

describe("RBI e-mandate AFA threshold boundary", () => {
  const now = "2026-01-15T12:00:00.000Z";
  const validNotice = { scheduledDebitAtIso: now, preDebitNotificationSentAtIso: new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString() };

  it("does not require AFA exactly at the threshold", () => {
    const result = checkEMandateDebit({ nowIso: now, amountPaise: config.eMandate.afaThresholdPaise, afaCompleted: false, ...validNotice, config });
    expect(result.violations.map((v) => v.code)).not.toContain("RBI_AFA_REQUIRED");
  });

  it("requires AFA one paisa above the threshold when not completed", () => {
    const result = checkEMandateDebit({ nowIso: now, amountPaise: config.eMandate.afaThresholdPaise + 1, afaCompleted: false, ...validNotice, config });
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("RBI_AFA_REQUIRED");
  });

  it("allows above-threshold debits once AFA has been completed", () => {
    const result = checkEMandateDebit({ nowIso: now, amountPaise: config.eMandate.afaThresholdPaise + 1, afaCompleted: true, ...validNotice, config });
    expect(result.violations.map((v) => v.code)).not.toContain("RBI_AFA_REQUIRED");
  });

  it("separately refuses a debit with no valid pre-debit notification", () => {
    const result = checkEMandateDebit({ nowIso: now, amountPaise: 100, afaCompleted: true, scheduledDebitAtIso: now, preDebitNotificationSentAtIso: null, config });
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("RBI_PREDEBIT_NOTICE_MISSING");
  });

  it("refuses when the notification was sent less than the configured lead time before the debit", () => {
    const lateNotice = new Date(Date.parse(now) - 2 * 60 * 60 * 1000).toISOString(); // only 2h notice
    const result = checkEMandateDebit({ nowIso: now, amountPaise: 100, afaCompleted: true, scheduledDebitAtIso: now, preDebitNotificationSentAtIso: lateNotice, config });
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("RBI_PREDEBIT_NOTICE_MISSING");
  });
});

describe("DPDP consent / opt-out", () => {
  it("refuses any channel when the customer has opted out, even with everything else valid", () => {
    const result = checkCompliance({
      channel: "whatsapp",
      nowIso: "2026-01-15T12:00:00.000Z",
      consentValid: true,
      optedOut: true,
      whatsapp: { optedIn: true, lastCustomerMessageAtIso: "2026-01-15T11:00:00.000Z" },
      config,
    });
    expect(result.allowed).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("DPDP_OPTED_OUT");
  });

  it("refuses when consent was never valid", () => {
    const result = checkCompliance({ channel: "voice", nowIso: "2026-01-15T06:00:00.000Z", consentValid: false, optedOut: false, config });
    expect(result.violations.map((v) => v.code)).toContain("DPDP_CONSENT_ABSENT");
  });
});

describe("minimizeForAudit", () => {
  it("redacts phone numbers under known PII keys, nested and top-level", () => {
    const payload = {
      episodeId: "ep_1",
      customerId: "cust_1",
      phone: "+919876543210",
      profile: { contact: "9876543210", note: "keep me" },
      history: [{ toPhone: "+919812345678" }],
    };
    const minimized = minimizeForAudit(payload);
    const serialized = JSON.stringify(minimized);
    expect(serialized).not.toContain("9876543210");
    expect(serialized).not.toContain("9812345678");
    expect((minimized as any).profile.note).toBe("keep me");
    expect((minimized as any).episodeId).toBe("ep_1");
  });

  it("also redacts a phone-shaped value under an unexpected key name", () => {
    const payload = { arbitraryField: "+91 98765 43210" };
    const minimized = minimizeForAudit(payload);
    expect(JSON.stringify(minimized)).not.toContain("98765 43210");
  });

  it("leaves non-phone data untouched", () => {
    const payload = { amountPaise: 15000, action: "PAYMENT_LINK", reasons: ["all_policy_checks_passed"] };
    expect(minimizeForAudit(payload)).toEqual(payload);
  });
});

describe("regulatory gate composition in evaluatePolicy", () => {
  // These exist because the gate was correct code wired up wrong, and every
  // existing test passed anyway: the unit tests exercised lib/compliance.ts
  // directly, and no test armed the gate through lib/policy.ts. The eval harness
  // never supplied `nowIso`, so the defect could only appear in production.
  const at = (iso: string) => iso;
  const baseInput = (action: string, nowIso: string) => ({
    event: {
      eventId: "evt_1", eventType: "payment.failed", occurredAt: nowIso, merchantId: "m_1",
      customerId: "cust_1", paymentId: "pay_1", subscriptionId: "sub_1", amountPaise: 250000,
      currency: "INR", paymentMethod: "card", failureCode: "insufficient_funds",
      failureSource: "issuer", nativeRecoveryState: "EXHAUSTED", customerPhone: "+919876543210",
      railMetadata: { issuer: "HDFC", network: "CARD" },
    },
    profile: {
      customerId: "cust_1", phone: "+919876543210", consentValid: true, optedOut: false,
      contactWindowOpen: true, daysSinceLastPayment: 10, lifetimeValuePaise: 5000000,
      subscriptionActive: true, previousInterventionCount: 0,
    },
    proposal: { action, confidence: 0.9 },
    eir: { eirPaise: 50000, eirWithoutChurnPaise: 50000, interventionCostPaise: 300 },
    policy: { ...defaultMerchantPolicy("m_1"), allowRetry: true, minimumEirPaise: 0, holdoutPct: 0 },
    automatedAttemptCount: 0, reminderCount: 0, voiceCallCount: 0,
    diagnosisConfidence: 0.9, degradationWindowId: null, episodeId: "ep_1",
    nowIso,
    complianceContext: {
      scheduledDebitAtIso: nowIso,
      preDebitNotificationSentAtIso: new Date(Date.parse(nowIso) - 25 * 3600 * 1000).toISOString(),
      afaCompleted: true,
    },
  }) as never;

  it("does not refuse a compliant silent mandate retry at 3am for a missing SMS template", () => {
    // A RETRY sends nothing. TRAI quiet hours and DLT template registration govern
    // messages; RBI's e-mandate framework governs this. Passing `channel ?? \"sms\"`
    // without an sms payload made the DLT check fail closed and refused every
    // mandate retry, which is both a code defect and a category error.
    const decision = evaluatePolicy(baseInput("RETRY", at("2026-03-04T21:30:00.000Z")));
    expect(decision.reasons.join(",")).not.toContain("DLT_TEMPLATE_MISSING");
    expect(decision.reasons.join(",")).not.toContain("TRAI_QUIET_HOURS");
    expect(decision.outcome).not.toBe("REJECT");
  });

  it("still refuses a mandate retry whose RBI pre-debit notice is absent", () => {
    const input = baseInput("RETRY", at("2026-03-04T12:00:00.000Z")) as Record<string, never>;
    (input as { complianceContext: { preDebitNotificationSentAtIso: string | null } })
      .complianceContext.preDebitNotificationSentAtIso = null;
    const decision = evaluatePolicy(input as never);
    expect(decision.outcome).toBe("REJECT");
    expect(decision.reasons.join(",")).toContain("RBI_PREDEBIT_NOTICE_MISSING");
  });

  it("still applies quiet hours to an action that actually contacts the customer", () => {
    const decision = evaluatePolicy(baseInput("VOICE_CALL", at("2026-03-04T22:30:00.000Z")));
    expect(decision.outcome).not.toBe("APPROVE");
  });
});
