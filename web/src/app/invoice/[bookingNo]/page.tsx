import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { gatewayGet } from "@/lib/gateway";
import { formatINR, formatDateTime } from "@/lib/utils";
import { InvoicePrintButton } from "@/components/customer/InvoicePrintButton";

export const metadata: Metadata = { title: "Invoice", robots: { index: false, follow: false } };
export const revalidate = 0;

type InvoiceResponse = {
  booking: Record<string, unknown>;
  invoice: Record<string, unknown> | null;
  business: Record<string, unknown>;
  error?: string;
};

export default async function InvoicePage(props: { params: Promise<{ bookingNo: string }> }) {
  const params = await props.params;
  const bookingNo = params.bookingNo;

  // An invoice is a customer-specific tax document. It is fetched ONLY through the
  // authorized gateway route, which verifies the bearer session owns this booking.
  //
  // Removed from here, both of which bypassed that check entirely:
  //   - a Redis read of `session:invoice:<bookingNo>` performed BEFORE any auth, keyed
  //     only by booking number, holding the customer name/phone/email/address for 24h,
  //     so anyone hitting /invoice/<any booking no> got the cached PII of whoever
  //     viewed it last, with no session at all;
  //   - a direct Supabase fallback that re-selected `customers(*)` with no ownership
  //     check and matched on the raw sequential primary key, making /invoice/1,
  //     /invoice/2, ... walk every customer PII record.
  // Failing closed (redirect to the portal) is the correct behaviour for PII when the
  // CRM is unreachable.
  let invoiceData: InvoiceResponse | null = null;
  try {
    const res = await gatewayGet<InvoiceResponse>(`/api/gateway/v1/customer/invoice/${encodeURIComponent(bookingNo)}`, { auth: true });
    if (res && res.booking) invoiceData = res;
  } catch {}

  if (!invoiceData || !invoiceData.booking) {
    redirect("/customer/portal");
  }

  const { booking, invoice, business: info } = invoiceData;

  const lines = [
    ["Base rental", Number(booking.base_amount)],
    ["Off-schedule / other fees", Number(booking.other_fees_amount)],
    ["Extra km charge", Number(booking.extra_km_amount)],
    ["Late fee", Number(booking.late_fee_amount)],
    ["Damage charge", Number(booking.damage_amount)],
  ].filter(([, v]) => Number(v) > 0) as Array<[string, number]>;

  return (
    <article className="container-x max-w-3xl py-10 print:py-2">
      <div className="card p-8 print:border-0 print:bg-white print:shadow-none">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-ink-100 pb-6">
          <div>
            <p className="font-display text-2xl font-semibold text-ink-900">{String(info.name ?? "Darshh Holiday")}</p>
            <p className="mt-1 text-sm text-ink-500">{String(info.address ?? "")}</p>
            <p className="text-sm text-ink-500">{String(info.phone ?? "")} · {String(info.email ?? "")}</p>
          </div>
          <div className="text-right">
            <p className="text-xs font-bold uppercase tracking-wider text-ink-400">Tax Invoice</p>
            <p className="font-display text-xl font-semibold text-ink-900">{invoice ? String(invoice.invoice_no) : "Draft"}</p>
            <p className="text-xs text-ink-500">{invoice ? formatDateTime(String(invoice.created_at)) : "Not yet issued"}</p>
          </div>
        </div>

        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-ink-400">Billed to</p>
            <p className="mt-1 text-sm font-semibold text-ink-900">{String(booking.customer_name ?? "—")}</p>
            <p className="text-sm text-ink-600">{String(booking.customer_phone ?? "")}</p>
            <p className="text-sm text-ink-600">{String(booking.customer_email ?? "")}</p>
            <p className="text-sm text-ink-600">{String(booking.customer_address ?? "")}</p>
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-ink-400">Booking</p>
            <p className="mt-1 text-sm text-ink-700">{String(booking.booking_no)}</p>
            <p className="text-sm text-ink-700">{String(booking.vehicle_name)} ({String(booking.registration_no ?? "—")})</p>
            <p className="text-sm text-ink-700">{formatDateTime(String(booking.pickup_at))} → {formatDateTime(String(booking.return_at))}</p>
            {Boolean(booking.branch_name) && (
              <p className="text-sm text-ink-700">Pickup branch: <span className="font-medium">{String(booking.branch_name)}</span></p>
            )}
          </div>
        </div>

        {/* No vehicle photography on invoices. A tax invoice is a financial
            document — it carries billing detail only. Do not reintroduce imagery
            here or on the CRM's copy of this page. */}

        <table className="mt-6 w-full text-sm">
          <thead>
            <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wider text-ink-400">
              <th className="py-2 font-semibold">Description</th>
              <th className="py-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(([label, value]) => (
              <tr key={label} className="border-b border-ink-50">
                <td className="py-2 text-ink-700">{label}</td>
                <td className="py-2 text-right text-ink-800">{formatINR(value)}</td>
              </tr>
            ))}
            <tr className="border-b border-ink-50">
              <td className="py-2 text-ink-700">GST</td>
              <td className="py-2 text-right text-ink-800">{formatINR(Number(booking.gst_amount))}</td>
            </tr>
            {Number(booking.discount_amount) > 0 && (
              <tr className="border-b border-ink-50">
                <td className="py-2 text-ink-700">Discount</td>
                <td className="py-2 text-right text-emerald-700">-{formatINR(Number(booking.discount_amount))}</td>
              </tr>
            )}
            <tr className="border-b border-ink-50">
              <td className="py-2 text-ink-700">Security deposit (cash at pickup, refundable)</td>
              <td className="py-2 text-right text-ink-800">{formatINR(Number(booking.deposit_amount))}</td>
            </tr>
            <tr className="border-b border-ink-50">
              <td className="py-2 font-semibold text-ink-900">Total Invoice</td>
              <td className="py-2 text-right font-semibold text-ink-900">{formatINR(Number(booking.total_amount))}</td>
            </tr>
            <tr>
              <td className="py-3 text-base font-bold text-ink-900">Total paid</td>
              <td className="py-3 text-right text-base font-bold text-emerald-700">{formatINR(Number(booking.paid_amount))}</td>
            </tr>
          </tbody>
        </table>

        <InvoicePrintButton />
      </div>
    </article>
  );
}
