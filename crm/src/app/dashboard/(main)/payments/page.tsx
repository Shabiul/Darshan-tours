import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { sbSelect, sbUpdate, num } from "@/lib/supabase-rest";
import { fetchRazorpayPayment } from "@/lib/razorpay";
import { PaymentsTableWithDrawer } from "@/components/dashboard/PaymentsTableWithDrawer";
import type { PaymentTransactionData } from "@/components/dashboard/PaymentDetailModal";

export const metadata: Metadata = { title: "Payments | Darshh CRM", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function PaymentsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/dashboard/login");

  const paymentsRes = await sbSelect<Record<string, unknown>>(
    "payments",
    "select=*,bookings(booking_no,pickup_at,return_at,customers(name,phone,email),vehicles(name,registration_no)),customers(name,phone,email)&order=created_at.desc,due_date.asc.nullslast"
  );
  if (!paymentsRes.ok) throw new Error(`Could not load payments: ${paymentsRes.error}`);

  const rawRows = paymentsRes.data.map((p) => {
    const booking = p.bookings as
      | { booking_no?: string; pickup_at?: string; return_at?: string; customers?: { name?: string; phone?: string; email?: string } | null; vehicles?: { name?: string; registration_no?: string } | null }
      | null;
    const customer = (p.customers || booking?.customers) as { name?: string; phone?: string; email?: string } | null;
    return {
      ...p,
      booking_no: booking?.booking_no ?? null,
      pickup_at: booking?.pickup_at ?? null,
      return_at: booking?.return_at ?? null,
      vehicle_name: booking?.vehicles?.name ?? null,
      registration_no: booking?.vehicles?.registration_no ?? null,
      customer_name: customer?.name ?? null,
      customer_phone: customer?.phone ?? null,
      customer_email: customer?.email ?? null,
    } as Record<string, unknown>;
  });

  for (const p of rawRows) {
    const rzpId = p.razorpay_payment_id as string | undefined;
    if (rzpId && (p.status !== "Paid" || !p.upi_id || !p.bank_ref_no || p.method === "Online")) {
      try {
        const rzpRes = await fetchRazorpayPayment(rzpId);
        if (rzpRes.ok) {
          const rzp = rzpRes.payment;
          const liveVpa = rzp.vpa || rzp.upi?.vpa || null;
          const liveMethod = rzp.method ? (rzp.method.toLowerCase() === "upi" ? "UPI" : rzp.method.toUpperCase()) : null;
          const liveRrn = rzp.acquirer_data?.rrn || rzp.acquirer_data?.upi_transaction_id || rzp.acquirer_data?.bank_transaction_id || null;

          const patch: Record<string, unknown> = { upi_id: liveVpa, vpa: liveVpa };
          if (liveRrn) patch.bank_ref_no = liveRrn;
          if (liveMethod) patch.method = liveMethod;

          if (rzp.status === "captured" && p.status !== "Paid") {
            patch.status = "Paid";
            patch.paid_at = rzp.created_at ? new Date(rzp.created_at * 1000).toISOString() : new Date().toISOString();
            p.status = "Paid";
            p.paid_at = patch.paid_at;
            if (p.booking_id) {
              const { generateInvoiceForBooking } = await import("@/lib/invoices");
              await generateInvoiceForBooking(Number(p.booking_id)).catch(() => null);
            }
          }

          await sbUpdate("payments", `id=eq.${Number(p.id)}`, patch);

          p.upi_id = liveVpa;
          p.vpa = liveVpa;
          p.bank_ref_no = liveRrn ?? p.bank_ref_no;
          if (liveMethod) p.method = liveMethod;
        }
      } catch {}
    }
  }

  const payments: PaymentTransactionData[] = rawRows.map((p) => {
    const upi = (p.upi_id as string) ?? (p.vpa as string) ?? null;
    const method = (p.method as string) ?? null;

    return {
      id: Number(p.id),
      payment_no: String(p.payment_no),
      booking_id: p.booking_id as number | null,
      booking_no: (p.booking_no as string) ?? null,
      customer_id: p.customer_id as number | null,
      customer_name: (p.customer_name as string) ?? null,
      customer_phone: (p.customer_phone as string) ?? null,
      customer_email: (p.customer_email as string) ?? null,
      vehicle_name: (p.vehicle_name as string) ?? null,
      registration_no: (p.registration_no as string) ?? null,
      pickup_at: (p.pickup_at as string) ?? null,
      return_at: (p.return_at as string) ?? null,
      amount: num(p.amount),
      amount_paise: num(p.amount_paise),
      currency: String(p.currency ?? "INR"),
      kind: String(p.kind ?? "advance"),
      method: method ?? (p.razorpay_payment_id ? "Online Gateway" : "Cash / Direct"),
      upi_id: upi,
      vpa: upi,
      bank_ref_no: (p.bank_ref_no as string) ?? null,
      gateway_ref: (p.gateway_ref as string) ?? null,
      razorpay_order_id: (p.razorpay_order_id as string) ?? null,
      razorpay_payment_id: (p.razorpay_payment_id as string) ?? null,
      razorpay_signature: (p.razorpay_signature as string) ?? null,
      due_date: (p.due_date as string) ?? null,
      paid_at: (p.paid_at as string) ?? null,
      status: String(p.status ?? "Pending"),
      notes: (p.notes as string) ?? null,
      receipt_no: (p.receipt_no as string) ?? null,
      created_at: (p.created_at as string) ?? null,
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 pb-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink-900">Payments & Transactions</h1>
          <p className="mt-1 text-sm text-ink-500">
            Real-time Razorpay gateway transactions, deposits, online order IDs, and manual receipts.
          </p>
        </div>
      </div>

      <PaymentsTableWithDrawer initialPayments={payments} />
    </div>
  );
}
