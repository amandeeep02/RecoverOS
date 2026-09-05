import { quietHoursDisabled } from "@/lib/compliance";
import { CheckoutDemo } from "@/components/checkout-demo";

export const dynamic = "force-dynamic";

export default function CheckoutPage() {
  return <CheckoutDemo quietHoursDisabled={quietHoursDisabled()} />;
}
