"use client";

import { useState, useMemo, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDate, formatDateTime, formatINR, waLink } from "@/lib/utils";
import { StatusBadge } from "@/components/ui";
import { PaymentDetailModal, type PaymentTransactionData } from "./PaymentDetailModal";
import { markPaymentPaid, syncRazorpayAction } from "@/lib/actions";

export function PaymentsTableWithDrawer({
  initialPayments,
}: {
  initialPayments: PaymentTransactionData[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [activeTab, setActiveTab] = useState<"all" | "paid" | "pending" | "deposits">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPayment, setSelectedPayment] = useState<PaymentTransactionData | null>(null);

  async function handleSyncRazorpay() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await syncRazorpayAction();
      if (res.ok) {
        setSyncResult({
          ok: true,
          msg: `Sync successful! ${res.reconciledCount} payments reconciled, ${res.repairedAmountCount} balances repaired, ${res.invoicesGenerated} invoices generated.`,
        });
        router.refresh();
      } else {
        setSyncResult({ ok: false, msg: `Sync failed: ${res.error}` });
      }
    } catch (err: any) {
      setSyncResult({ ok: false, msg: `Sync error: ${err?.message || err}` });
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncResult(null), 8000);
    }
  }

  const allCount = initialPayments.length;
  const paidCount = initialPayments.filter((p) => p.status === "Paid").length;
  const pendingCount = initialPayments.filter((p) => ["Pending", "Partially paid"].includes(p.status)).length;
  const depositCount = initialPayments.filter((p) => p.kind === "deposit" || p.kind === "extra_charge").length;

  const totalPaid = initialPayments
    .filter((p) => p.status === "Paid")
    .reduce((s, p) => s + Number(p.amount), 0);
  const totalPending = initialPayments
    .filter((p) => ["Pending", "Partially paid"].includes(p.status))
    .reduce((s, p) => s + Number(p.amount), 0);

  const filteredPayments = useMemo(() => {
    let list = initialPayments;

    if (activeTab === "paid") {
      list = list.filter((p) => p.status === "Paid");
    } else if (activeTab === "pending") {
      list = list.filter((p) => ["Pending", "Partially paid"].includes(p.status));
    } else if (activeTab === "deposits") {
      list = list.filter((p) => p.kind === "deposit" || p.kind === "extra_charge");
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (p) =>
          p.payment_no.toLowerCase().includes(q) ||
          (p.customer_name && p.customer_name.toLowerCase().includes(q)) ||
          (p.customer_phone && p.customer_phone.toLowerCase().includes(q)) ||
          (p.booking_no && p.booking_no.toLowerCase().includes(q)) ||
          (p.razorpay_payment_id && p.razorpay_payment_id.toLowerCase().includes(q)) ||
          (p.gateway_ref && p.gateway_ref.toLowerCase().includes(q)) ||
          (p.upi_id && p.upi_id.toLowerCase().includes(q)) ||
          (p.vpa && p.vpa.toLowerCase().includes(q)) ||
          (p.method && p.method.toLowerCase().includes(q)) ||
          (p.notes && p.notes.toLowerCase().includes(q))
      );
    }

    return list;
  }, [initialPayments, activeTab, searchQuery]);

  function handleQuickMarkPaid(e: React.MouseEvent, paymentId: number) {
    e.stopPropagation();
    startTransition(async () => {
      await markPaymentPaid(paymentId);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {/* Summary KPI Pills */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="card p-3 bg-emerald-50/50 border-emerald-200">
          <span className="text-[11px] font-semibold text-emerald-800 uppercase tracking-wider">Collected Revenue</span>
          <p className="font-display text-xl font-bold text-emerald-950 mt-0.5">{formatINR(totalPaid)}</p>
        </div>
        <div className="card p-3 bg-amber-50/50 border-amber-200">
          <span className="text-[11px] font-semibold text-amber-800 uppercase tracking-wider">Pending Dues</span>
          <p className="font-display text-xl font-bold text-amber-950 mt-0.5">{formatINR(totalPending)}</p>
        </div>
        <div className="card p-3">
          <span className="text-[11px] font-semibold text-ink-500 uppercase tracking-wider">Total Transactions</span>
          <p className="font-display text-xl font-bold text-ink-900 mt-0.5">{allCount} Records</p>
        </div>
        <div className="card p-3">
          <span className="text-[11px] font-semibold text-ink-500 uppercase tracking-wider">Paid Rate</span>
          <p className="font-display text-xl font-bold text-brand-700 mt-0.5">
            {allCount > 0 ? Math.round((paidCount / allCount) * 100) : 0}%
          </p>
        </div>
      </div>

      {/* Toolbar: Navigation Tabs & Search */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Navigation Tabs */}
        <nav className="flex items-center gap-1.5 overflow-x-auto rounded-xl border border-ink-200 bg-white p-1 shadow-xs">
          <button
            type="button"
            onClick={() => setActiveTab("all")}
            className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition ${
              activeTab === "all"
                ? "bg-ink-950 text-white shadow-xs"
                : "text-ink-600 hover:bg-ink-50"
            }`}
          >
            All Transactions ({allCount})
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("paid")}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition ${
              activeTab === "paid"
                ? "bg-emerald-600 text-white shadow-xs"
                : "text-ink-600 hover:bg-ink-50"
            }`}
          >
            <span>Paid ({paidCount})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("pending")}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition ${
              activeTab === "pending"
                ? "bg-amber-500 text-white shadow-xs"
                : "text-ink-600 hover:bg-ink-50"
            }`}
          >
            <span>Pending Dues</span>
            <span className={`rounded-full px-1.5 py-0.2 text-[10px] font-black ${
              activeTab === "pending" ? "bg-white text-amber-700" : "bg-amber-100 text-amber-900"
            }`}>
              {pendingCount}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("deposits")}
            className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition ${
              activeTab === "deposits"
                ? "bg-purple-600 text-white shadow-xs"
                : "text-ink-600 hover:bg-ink-50"
            }`}
          >
            Deposits & Extras ({depositCount})
          </button>
        </nav>

        {/* Search & Actions */}
        <div className="flex flex-wrap items-center gap-2 flex-1 sm:max-w-md justify-end">
          <button
            type="button"
            disabled={syncing}
            onClick={handleSyncRazorpay}
            className="inline-flex items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3 py-1.5 text-xs font-semibold text-ink-700 shadow-xs hover:bg-ink-50 transition shrink-0 cursor-pointer disabled:opacity-50"
            title="Sync all transactions and invoices with Razorpay"
          >
            <svg
              className={`h-3.5 w-3.5 text-brand-600 ${syncing ? "animate-spin" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            <span>{syncing ? "Syncing..." : "Sync Razorpay"}</span>
          </button>

          {/* Search Box */}
          <div className="relative min-w-[200px] flex-1">
            <input
              type="text"
              placeholder="Search payment #, UPI ID, customer, txn ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-xl border border-ink-200 bg-white py-1.5 pl-8 pr-3 text-xs text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-hidden"
            />
            <svg className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-ink-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2.5 top-1.5 text-xs text-ink-400 hover:text-ink-900"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {syncResult && (
        <div
          className={`flex items-center justify-between rounded-xl p-3 text-xs border ${
            syncResult.ok
              ? "bg-emerald-50 text-emerald-900 border-emerald-200"
              : "bg-red-50 text-red-900 border-red-200"
          }`}
        >
          <div className="flex items-center gap-2">
            <span>{syncResult.ok ? "✅" : "⚠️"}</span>
            <span className="font-medium">{syncResult.msg}</span>
          </div>
          <button
            type="button"
            onClick={() => setSyncResult(null)}
            className="text-xs font-bold hover:underline opacity-70 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Payments Table */}
      {filteredPayments.length === 0 ? (
        <div className="card p-10 text-center text-sm text-ink-500 space-y-1">
          <p className="font-semibold">No payment records found</p>
          <p className="text-xs text-ink-400">
            {searchQuery ? "No payments matched your search query." : "No transactions in this category."}
          </p>
        </div>
      ) : (
        <div className="card overflow-x-auto shadow-xs">
          <div className="bg-ink-50/50 px-4 py-2 border-b border-ink-100 flex items-center justify-between text-xs text-ink-600">
            <span>Showing {filteredPayments.length} transactions</span>
            <span className="text-[11px] text-ink-400">Click any row to view complete transaction details</span>
          </div>

          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-ink-100 bg-ink-50/50 text-left text-xs uppercase tracking-wider text-ink-400">
                <th className="px-4 py-3 font-semibold">Payment / Ref</th>
                <th className="px-4 py-3 font-semibold">Transaction & UPI ID</th>
                <th className="px-4 py-3 font-semibold">Customer</th>
                <th className="px-4 py-3 font-semibold">Booking / Vehicle</th>
                <th className="px-4 py-3 font-semibold">Amount</th>
                <th className="px-4 py-3 font-semibold">Date / Due</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredPayments.map((p) => {
                const isPaid = p.status === "Paid";
                const upi = p.upi_id || p.vpa;
                const txnId = p.razorpay_payment_id || p.gateway_ref;
                return (
                  <tr
                    key={p.id}
                    onClick={() => setSelectedPayment(p)}
                    className="cursor-pointer border-b border-ink-50 hover:bg-brand-50/20 transition group"
                  >
                    <td className="px-4 py-3.5">
                      <p className="font-bold text-ink-900 group-hover:text-brand-700 hover:underline">
                        {p.payment_no}
                      </p>
                      {p.receipt_no ? (
                        <p className="text-[11px] text-ink-400 font-mono">Rec: {p.receipt_no}</p>
                      ) : (
                        <p className="text-[11px] text-ink-400 capitalize">{p.kind}</p>
                      )}
                    </td>

                    <td className="px-4 py-3.5">
                      {txnId && (
                        <p className="font-mono text-xs font-semibold text-ink-800 truncate max-w-[170px]" title={txnId}>
                          {txnId}
                        </p>
                      )}
                      {upi ? (
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 font-mono text-[11px] font-bold text-emerald-800 border border-emerald-200 mt-0.5">
                          <svg className="h-3 w-3 text-emerald-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          <span>{upi}</span>
                        </span>
                      ) : (
                        <span className="text-[11px] text-ink-400 font-medium">
                          {p.method ?? "Card / NetBanking"}
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3.5">
                      <p className="font-semibold text-ink-900">{p.customer_name ?? "—"}</p>
                      {p.customer_phone && (
                        <span className="text-xs text-ink-500 font-mono">{p.customer_phone}</span>
                      )}
                    </td>

                    <td className="px-4 py-3.5">
                      {p.booking_id ? (
                        <div>
                          <Link
                            href={`/dashboard/bookings/${p.booking_id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="font-medium text-brand-700 hover:underline inline-block"
                          >
                            {p.booking_no ?? `#${p.booking_id}`}
                          </Link>
                          {p.vehicle_name && (
                            <p className="text-[11px] text-ink-500">{p.vehicle_name}</p>
                          )}
                        </div>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>

                    <td className="px-4 py-3.5">
                      <p className="font-bold text-ink-900">{formatINR(p.amount)}</p>
                      <span className="text-[10px] font-semibold text-ink-400 uppercase">{p.kind}</span>
                    </td>

                    <td className="px-4 py-3.5 text-xs text-ink-600">
                      {isPaid && p.paid_at ? (
                        <div>
                          <span className="text-emerald-700 font-medium">Paid</span>
                          <p className="text-[11px] text-ink-400">{formatDateTime(p.paid_at)}</p>
                        </div>
                      ) : p.due_date ? (
                        <div>
                          <span className="text-amber-700 font-medium">Due</span>
                          <p className="text-[11px] text-ink-400">{formatDate(p.due_date)}</p>
                        </div>
                      ) : (
                        formatDateTime(p.created_at || "")
                      )}
                    </td>

                    <td className="px-4 py-3.5">
                      <StatusBadge status={p.status} />
                    </td>

                    <td className="px-4 py-3.5 text-right space-x-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedPayment(p);
                        }}
                        className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold bg-brand-50 text-brand-900 border-brand-200 hover:bg-brand-100"
                      >
                        <span>Details</span>
                        <svg className="h-3.5 w-3.5 text-brand-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      </button>

                      {!isPaid && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={(e) => handleQuickMarkPaid(e, p.id)}
                          className="btn-primary inline-flex items-center gap-1.5 px-3 py-1 text-xs bg-emerald-600 hover:bg-emerald-700"
                        >
                          <span>Mark Paid</span>
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                          </svg>
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Transaction Detail Slide-Over Drawer */}
      <PaymentDetailModal
        payment={selectedPayment}
        isOpen={Boolean(selectedPayment)}
        onClose={() => setSelectedPayment(null)}
      />
    </div>
  );
}
