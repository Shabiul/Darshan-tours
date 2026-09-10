"use client";

import Link from "next/link";
import { formatINR, formatDate } from "@/lib/utils";
import type { Quote } from "@/lib/booking-actions";

type Props = {
  bookingNo: string;
  bookingId?: number;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  quote?: Quote | null;
  amountPaid: number;
  paymentId?: string;
  paymentDate?: string;
  branchName?: string | null;
};

export function InlineInvoiceCard({
  bookingNo,
  bookingId,
  customerName,
  customerPhone,
  customerEmail,
  quote,
  amountPaid,
  paymentId,
  paymentDate = formatDate(new Date().toISOString()),
  branchName,
}: Props) {
  const invoiceNo = `INV-${new Date().getFullYear()}-${String(bookingId || bookingNo.replace(/\D/g, "") || "10001").slice(-5)}`;
  // `amountPaid` is the ONLINE payment, which never includes the deposit — so the
  // derived fallbacks must not subtract the deposit out of it.
  const depositAmount = quote?.depositPayableAtPickup ?? quote?.depositAmount ?? 1000;
  const gstAmount = quote?.gstAmount ?? Math.round((amountPaid / 1.06) * 0.06);
  const baseAmount = quote?.baseAmount ?? Math.max(0, amountPaid - gstAmount);

  return (
    <div className="mt-6 overflow-hidden rounded-2xl border border-emerald-200 bg-white p-6 shadow-md transition print:border-none print:shadow-none print:p-0 text-left">
      {/* Invoice Header */}
      <div className="flex flex-col gap-4 border-b border-ink-100 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 print:hidden">PAID TAX INVOICE</span>
            <span className="text-xs text-ink-400">#{invoiceNo}</span>
          </div>
          <h2 className="mt-1 font-display text-xl font-bold text-ink-950">Darshh Holiday Bike &amp; Car Rentals</h2>
          {/* Contact number matches the printed price posters and the business
              settings row. It previously read "+91 98452 10001", which reaches nobody. */}
          <p className="text-xs text-ink-500">Sakleshpura &amp; Hassan, Hassan District, Karnataka · +91 76768 75595</p>
        </div>

        <div className="text-left sm:text-right">
          <p className="text-xs font-semibold uppercase text-ink-400">Date Paid</p>
          <p className="text-sm font-semibold text-ink-900">{paymentDate}</p>
          <p className="text-xs text-ink-500">Booking: <span className="font-mono font-bold text-ink-900">{bookingNo}</span></p>
          {branchName && (
            <p className="text-xs text-ink-500">Pickup branch: <span className="font-semibold text-ink-900">{branchName}</span></p>
          )}
        </div>
      </div>

      {/* Customer Info */}
      <div className="grid grid-cols-1 gap-4 py-4 text-xs sm:grid-cols-2">
        <div>
          <p className="font-semibold uppercase text-ink-400">Billed To</p>
          <p className="font-semibold text-ink-900">{customerName || "Valued Customer"}</p>
          {customerPhone && <p className="text-ink-600">{customerPhone}</p>}
          {customerEmail && <p className="text-ink-600">{customerEmail}</p>}
        </div>
        <div className="sm:text-right">
          <p className="font-semibold uppercase text-ink-400">Payment Status</p>
          <p className="font-bold text-emerald-700">✓ Fully Paid via Razorpay UPI / Online</p>
          {paymentId && <p className="text-ink-500">Transaction ID: <span className="font-mono text-ink-800">{paymentId}</span></p>}
        </div>
      </div>

      {/* Itemized Table */}
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-ink-100 text-ink-400 uppercase">
              <th className="py-2 font-semibold">Description</th>
              <th className="py-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-50 text-ink-800">
            <tr>
              <td className="py-2.5">
                <span className="font-semibold text-ink-900">Vehicle Rental Charge</span>
                {quote && <span className="ml-1 text-ink-500">({quote.days} day{quote.days > 1 ? "s" : ""})</span>}
              </td>
              <td className="py-2.5 text-right font-medium text-ink-900">{formatINR(baseAmount)}</td>
            </tr>
            {quote && Boolean(quote.offSchedulePickupFee && quote.offSchedulePickupFee > 0) && (
              <tr>
                <td className="py-2.5 text-amber-800">Off-Schedule Pickup Surcharge</td>
                <td className="py-2.5 text-right font-medium text-amber-900">{formatINR(quote.offSchedulePickupFee!)}</td>
              </tr>
            )}
            <tr>
              <td className="py-2.5">GST (6%)</td>
              <td className="py-2.5 text-right font-medium text-ink-900">{formatINR(gstAmount)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-ink-900 font-bold text-sm text-ink-950">
              <td className="pt-3">Paid Online Now</td>
              <td className="pt-3 text-right text-emerald-700">{formatINR(amountPaid)}</td>
            </tr>
            <tr className="text-xs text-ink-700">
              <td className="pt-2">
                <span>Security deposit — cash at pickup, refundable</span>
                <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 print:hidden">Not charged online</span>
              </td>
              <td className="pt-2 text-right font-medium text-ink-900">{formatINR(depositAmount)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* PDF Download & Print Action Buttons */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-ink-100 pt-4 print:hidden">
        <Link
          href={`/invoice/${encodeURIComponent(bookingNo)}`}
          target="_blank"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-700 hover:underline"
        >
          <span>👁️ View Full Page Invoice</span>
        </Link>

        <button
          type="button"
          onClick={() => window.print()}
          className="btn-primary inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold shadow-sm hover:scale-[1.02] active:scale-[0.98] transition cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Download / Save PDF Invoice
        </button>
      </div>
    </div>
  );
}
