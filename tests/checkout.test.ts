import { describe, expect, it } from "vitest";
import { checkoutFailureCode, checkoutFailureWebhook } from "@/lib/checkout";
import { normalizeRazorpayEvent } from "@/lib/normalizer";
import { diagnose } from "@/lib/diagnosis";
import type { PaymentEvent } from "@/lib/domain";

describe("checkout failure → payment.failed webhook", () => {
  it("maps only what Razorpay's error clearly says, and leaves the rest unknown", () => {
    expect(checkoutFailureCode({ reason: "insufficient_funds" })).toBe("insufficient_funds");
    expect(checkoutFailureCode({ description: "Your card has expired", reason: "payment_failed" })).toBe("expired_card");
    expect(checkoutFailureCode({ reason: "payment_failed", source: "bank", step: "payment_authorization" })).toBe("bank_declined");
    // A customer closing the bank page is not a bank decline; it stays what Razorpay called it.
    const cancelled = checkoutFailureCode({ reason: "payment_cancelled", source: "customer", step: "payment_authentication" });
    expect(cancelled).toBe("payment_cancelled");
    expect(diagnose({ failureCode: cancelled, paymentMethod: "card", failureSource: "customer", nativeRecoveryState: "EXHAUSTED" } as PaymentEvent).category).toBe("unknown");
  });

  it("builds a body the real webhook route normalizes: phone, issuer, exhausted native cycle, one customer per order", () => {
    const report = {
      orderId: "order_T1", paymentId: "pay_T1", amountPaise: 499_900, contact: "9876543210", name: "Test",
      error: { code: "BAD_REQUEST_ERROR", description: "Payment failed", source: "bank", step: "payment_authorization", reason: "payment_failed" },
    };
    const payment = { id: "pay_T1", method: "card", contact: "+919876543210", card: { issuer: "HDFC", network: "Visa" }, error_source: "bank", error_step: "payment_authorization", error_reason: "payment_failed", error_description: "Payment failed" };
    const { failureCode, payload } = checkoutFailureWebhook(report, payment, 1_700_000_000_000);
    expect(failureCode).toBe("bank_declined");

    const event = normalizeRazorpayEvent(payload, { eventId: "evt_ck_1" });
    expect(event).toMatchObject({ eventType: "payment.failed", failureCode: "bank_declined", customerPhone: "+919876543210", amountPaise: 499_900, paymentMethod: "card", nativeRecoveryState: "EXHAUSTED", paymentId: "pay_T1" });
    expect(event.railMetadata).toMatchObject({ issuer: "HDFC", network: "Visa" });

    const entity = (p: ReturnType<typeof checkoutFailureWebhook>) => p.payload.payload.payment.entity;
    expect(entity(checkoutFailureWebhook({ ...report, paymentId: "pay_T2" }, null)).customer_id).toBe(entity({ failureCode, payload }).customer_id);
    expect(entity(checkoutFailureWebhook({ ...report, orderId: "order_T2" }, null)).customer_id).not.toBe(entity({ failureCode, payload }).customer_id);
  });

  it("falls back to the browser's report when Razorpay's payment record is unavailable", () => {
    const { failureCode, payload } = checkoutFailureWebhook(
      { orderId: "order_T3", paymentId: null, amountPaise: 99_900, contact: "+919876543210", error: { description: "Insufficient funds in account", reason: "payment_failed", source: "bank", step: "payment_authorization" } },
      null,
    );
    expect(failureCode).toBe("insufficient_funds");
    const event = normalizeRazorpayEvent(payload, { eventId: "evt_ck_3" });
    expect(event.paymentId).toBe("pay_ck_order_T3");
    expect(event.customerPhone).toBe("+919876543210");
  });
});
