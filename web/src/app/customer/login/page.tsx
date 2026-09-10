import type { Metadata } from "next";
import { CustomerLogin } from "@/components/customer/CustomerLogin";

export const metadata: Metadata = {
  title: "Track Your Enquiry",
  description: "Log in with your phone number or email to view your enquiry status and quotation.",
  robots: { index: false, follow: false },
};

export default function CustomerLoginPage() {
  return (
    <div className="container-x max-w-md py-16">
      <div className="card p-8">
        <h1 className="font-display text-2xl font-semibold text-ink-900">Track your enquiry</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-600">
          Enter the phone number or email you used in your enquiry. We will send you a one-time password (OTP) to log in securely.
        </p>
        <CustomerLogin />
      </div>
    </div>
  );
}
