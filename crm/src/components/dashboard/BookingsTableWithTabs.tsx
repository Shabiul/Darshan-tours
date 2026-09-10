"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { formatDateTime, formatINR, waLink } from "@/lib/utils";
import { StatusBadge } from "@/components/ui";
import { calculateBookingFinancials } from "@/lib/pricing";
import { istDateKey } from "@/lib/rental-clock";
import { BookingReviewModal, type BookingReviewData } from "./BookingReviewModal";

type PickupSort = "default" | "asc" | "desc";

export function BookingsTableWithTabs({
  initialBookings,
  branches = [],
}: {
  initialBookings: BookingReviewData[];
  branches?: Array<{ id: number; name: string; slug?: string }>;
}) {
  const [activeTab, setActiveTab] = useState<"all" | "active" | "pending" | "rejected">("all");
  const [selectedBranch, setSelectedBranch] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedBooking, setSelectedBooking] = useState<BookingReviewData | null>(null);
  // "Upcoming" scopes the list to today's pickup date and onward (IST calendar day,
  // not the last 24 hours), earliest first by default — a booking whose pickup already
  // passed is not upcoming even if it never got handed over. pickupSort is independent
  // so staff can still sort ascending/descending without the date floor, or combine both.
  const [pickupSort, setPickupSort] = useState<PickupSort>("default");
  const [upcomingOnly, setUpcomingOnly] = useState(false);

  // Filter Bookings by Tab & Branch
  const branchFilteredList = useMemo(() => {
    if (selectedBranch === "all") return initialBookings;
    return initialBookings.filter((b) => {
      if (b.branch_id !== undefined && b.branch_id !== null && String(b.branch_id) === selectedBranch) {
        return true;
      }
      const targetBr = branches.find((br) => String(br.id) === selectedBranch);
      const targetName = targetBr?.name.toLowerCase() || selectedBranch.toLowerCase();
      if (b.branch_name && b.branch_name.toLowerCase().includes(targetName)) {
        return true;
      }
      if (b.pickup_location && b.pickup_location.toLowerCase().includes(targetName)) {
        return true;
      }
      return false;
    });
  }, [initialBookings, selectedBranch, branches]);

  const isPaidOrStaff = (b: BookingReviewData) => (b.paid_amount || 0) > 0 || Boolean(b.manager_id);
  const isPendingVerification = (b: BookingReviewData) =>
    (["Pending verification", "Payment received"].includes(b.status) && isPaidOrStaff(b)) ||
    (b.status === "Pending verification" && isPaidOrStaff(b));
  const isUnpaid = (b: BookingReviewData) =>
    (b.status === "Pending payment" || b.status === "Draft" || b.status === "Pending verification") && !isPaidOrStaff(b);

  const allCount = branchFilteredList.length;
  const activeCount = branchFilteredList.filter((b) =>
    ["Confirmed", "Ready for pickup", "Vehicle handed over", "Active rental", "Return pending"].includes(b.status)
  ).length;
  const pendingCount = branchFilteredList.filter(isPendingVerification).length;
  const unpaidCount = branchFilteredList.filter(isUnpaid).length;
  const rejectedCount = branchFilteredList.filter((b) =>
    ["Rejected", "Cancelled"].includes(b.status)
  ).length;

  const filteredBookings = useMemo(() => {
    let list = branchFilteredList;

    if (activeTab === "active") {
      list = list.filter((b) =>
        ["Confirmed", "Ready for pickup", "Vehicle handed over", "Active rental", "Return pending"].includes(b.status)
      );
    } else if (activeTab === "pending") {
      list = list.filter(isPendingVerification);
    } else if ((activeTab as string) === "unpaid") {
      list = list.filter(isUnpaid);
    } else if (activeTab === "rejected") {
      list = list.filter((b) => ["Rejected", "Cancelled"].includes(b.status));
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (b) =>
          b.booking_no.toLowerCase().includes(q) ||
          (b.customer_name && b.customer_name.toLowerCase().includes(q)) ||
          (b.customer_phone && b.customer_phone.toLowerCase().includes(q)) ||
          (b.vehicle_name && b.vehicle_name.toLowerCase().includes(q)) ||
          (b.branch_name && b.branch_name.toLowerCase().includes(q)) ||
          (b.pickup_location && b.pickup_location.toLowerCase().includes(q)) ||
          (b.notes && b.notes.toLowerCase().includes(q))
      );
    }

    if (upcomingOnly) {
      const todayKey = istDateKey(new Date());
      list = list.filter((b) => b.pickup_at && istDateKey(new Date(b.pickup_at)) >= todayKey);
    }

    // Upcoming defaults to earliest-pickup-first (today, then tomorrow, ...) unless
    // staff explicitly picked a direction; the direction control also works standalone
    // without the date floor, for anyone who just wants the full list sorted by pickup.
    const effectiveSort: PickupSort = pickupSort !== "default" ? pickupSort : upcomingOnly ? "asc" : "default";
    if (effectiveSort !== "default") {
      const dir = effectiveSort === "asc" ? 1 : -1;
      list = [...list].sort((a, b) => {
        const at = a.pickup_at ? new Date(a.pickup_at).getTime() : 0;
        const bt = b.pickup_at ? new Date(b.pickup_at).getTime() : 0;
        return (at - bt) * dir;
      });
    }

    return list;
  }, [branchFilteredList, activeTab, searchQuery, upcomingOnly, pickupSort]);

  return (
    <div className="space-y-4" suppressHydrationWarning>
      {/* Search & Tabs Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Navigation Tabs */}
        <nav className="flex items-center gap-1.5 overflow-x-auto rounded-xl border border-ink-200 bg-white p-1 shadow-xs">
          <button
            type="button"
            onClick={() => setActiveTab("all")}
            className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition cursor-pointer ${
              activeTab === "all"
                ? "bg-ink-950 text-white shadow-xs"
                : "text-ink-600 hover:bg-ink-50"
            }`}
          >
            All Bookings ({allCount})
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("active")}
            className={`rounded-lg px-3.5 py-1.5 text-xs font-bold transition cursor-pointer ${
              activeTab === "active"
                ? "bg-emerald-600 text-white shadow-xs"
                : "text-ink-600 hover:bg-ink-50"
            }`}
          >
            Active & Confirmed ({activeCount})
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("pending")}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition cursor-pointer ${
              activeTab === "pending"
                ? "bg-amber-500 text-white shadow-xs"
                : "text-ink-600 hover:bg-ink-50"
            }`}
          >
            <span>Pending Verification</span>
            <span className={`rounded-full px-1.5 py-0.2 text-[10px] font-black ${
              activeTab === "pending" ? "bg-white text-amber-700" : "bg-amber-100 text-amber-900"
            }`}>
              {pendingCount}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("unpaid" as any)}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition cursor-pointer ${
              (activeTab as string) === "unpaid"
                ? "bg-slate-700 text-white shadow-xs"
                : "text-ink-600 hover:bg-ink-50"
            }`}
          >
            <span>Unpaid / Incomplete</span>
            <span className={`rounded-full px-1.5 py-0.2 text-[10px] font-black ${
              (activeTab as string) === "unpaid" ? "bg-white text-slate-900" : "bg-ink-100 text-ink-800"
            }`}>
              {unpaidCount}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("rejected")}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-bold transition cursor-pointer ${
              activeTab === "rejected"
                ? "bg-red-600 text-white shadow-xs"
                : "text-ink-600 hover:bg-ink-50"
            }`}
          >
            <span className="flex items-center gap-1">
              <span>Rejected Bookings</span>
              <svg className="h-3.5 w-3.5 text-current" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </span>
            <span className={`rounded-full px-1.5 py-0.2 text-[10px] font-black ${
              activeTab === "rejected" ? "bg-white text-red-700" : "bg-red-100 text-red-900"
            }`}>
              {rejectedCount}
            </span>
          </button>
        </nav>

        {/* Branch Filter Selector */}
        {branches && branches.length > 0 && (
          <div className="flex items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3 py-1.5 shadow-xs">
            <span className="text-xs text-ink-500">🏢 Branch:</span>
            <select
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              className="bg-transparent text-xs font-bold text-ink-800 focus:outline-none cursor-pointer pr-1"
            >
              <option value="all">All Branches ({initialBookings.length})</option>
              {branches.map((br) => {
                const count = initialBookings.filter((b) =>
                  (b.branch_id !== undefined && b.branch_id !== null && String(b.branch_id) === String(br.id)) ||
                  (b.branch_name && b.branch_name.toLowerCase().includes(br.name.toLowerCase())) ||
                  (b.pickup_location && b.pickup_location.toLowerCase().includes(br.name.toLowerCase()))
                ).length;
                return (
                  <option key={br.id} value={String(br.id)}>
                    {br.name} ({count})
                  </option>
                );
              })}
            </select>
          </div>
        )}

        {/* Pickup-date sort */}
        <div className="flex items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3 py-1.5 shadow-xs">
          <span className="text-xs text-ink-500">↕ Sort:</span>
          <select
            value={pickupSort}
            onChange={(e) => setPickupSort(e.target.value as PickupSort)}
            className="bg-transparent text-xs font-bold text-ink-800 focus:outline-none cursor-pointer pr-1"
          >
            <option value="default">Newest created</option>
            <option value="asc">Pickup date ↑ (earliest first)</option>
            <option value="desc">Pickup date ↓ (latest first)</option>
          </select>
        </div>

        {/* Upcoming-only toggle: today's pickup date onward, earliest first */}
        <button
          type="button"
          onClick={() => setUpcomingOnly((v) => !v)}
          className={`rounded-xl border px-3 py-1.5 text-xs font-bold transition cursor-pointer ${
            upcomingOnly
              ? "border-brand-600 bg-brand-600 text-white shadow-xs"
              : "border-ink-200 bg-white text-ink-600 hover:bg-ink-50"
          }`}
          title="Show only today's and future pickups, soonest first"
        >
          📅 Upcoming {upcomingOnly ? "✓" : ""}
        </button>

        {/* Quick Search */}
        <div className="relative min-w-[240px] flex-1 sm:max-w-xs">
          <input
            type="text"
            placeholder="Search booking #, customer, phone, vehicle, branch..."
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

      {/* Bookings Table */}
      {filteredBookings.length === 0 ? (
        <div className="card p-10 text-center text-sm text-ink-500 space-y-1">
          <p className="font-semibold">No bookings found</p>
          <p className="text-xs text-ink-400">
            {searchQuery || selectedBranch !== "all"
              ? "No records matched your search query or selected branch."
              : activeTab === "rejected"
              ? "Great! No rejected or cancelled bookings in this section."
              : "No bookings present in this category."}
          </p>
        </div>
      ) : activeTab === "rejected" ? (
        /* Dedicated Rejected Bookings Tab View */
        <div className="card overflow-x-auto border-red-200 shadow-xs">
          <div className="bg-red-50/70 px-4 py-2.5 border-b border-red-200 flex items-center justify-between text-xs text-red-900 font-semibold">
            <span>Showing {filteredBookings.length} Rejected / Cancelled Bookings with Recorded Reasons</span>
            <span className="text-[11px] text-red-700 font-normal">Click any row to review details or restore</span>
          </div>

          <table className="w-full min-w-[950px] text-sm">
            <thead>
              <tr className="border-b border-ink-100 bg-ink-50/50 text-left text-xs uppercase tracking-wider text-ink-400">
                <th className="px-4 py-3 font-semibold">Booking</th>
                <th className="px-4 py-3 font-semibold">Customer</th>
                <th className="px-4 py-3 font-semibold">Vehicle & Branch</th>
                <th className="px-4 py-3 font-semibold">Rejection Reason & Notes</th>
                <th className="px-4 py-3 font-semibold">Paid / Total</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredBookings.map((b) => (
                <tr
                  key={b.id}
                  onClick={() => setSelectedBooking(b)}
                  className="cursor-pointer border-b border-ink-50 bg-red-50/10 hover:bg-red-50/30 transition"
                >
                  <td className="px-4 py-3.5">
                    <div className="space-y-0.5">
                      <span className="font-bold font-mono text-red-950 hover:underline">
                        {b.booking_no}
                      </span>
                      <p suppressHydrationWarning className="text-[11px] font-medium text-ink-500 flex items-center gap-1">
                        <span className="text-ink-400">🕒</span>
                        <span>{formatDateTime(b.created_at || b.pickup_at)}</span>
                      </p>
                    </div>
                  </td>

                  <td className="px-4 py-3.5">
                    <p className="font-semibold text-ink-900">{b.customer_name ?? "—"}</p>
                    <p className="text-xs text-ink-500 font-mono">{b.customer_phone ?? "—"}</p>
                  </td>

                  <td className="px-4 py-3.5">
                    <p className="font-medium text-ink-800">{b.vehicle_name ?? "—"}</p>
                    <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                      <span className="text-xs text-ink-400 font-mono">{b.registration_no ?? "—"}</span>
                      {(b.branch_name || b.pickup_location) && (
                        <span className="inline-flex items-center rounded-sm bg-red-100/80 px-1.5 py-0.2 text-[10px] font-semibold text-red-800">
                          🏢 {b.branch_name || b.pickup_location}
                        </span>
                      )}
                    </div>
                  </td>

                  <td className="px-4 py-3.5 max-w-xs">
                    <div className="flex items-center gap-1.5 rounded-lg bg-red-100/70 p-2 text-xs font-semibold text-red-900 border border-red-200">
                      <svg className="h-3.5 w-3.5 text-red-700 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <span>{b.notes || "Rejection reason not recorded"}</span>
                    </div>
                  </td>

                  <td className="px-4 py-3.5 font-medium text-ink-700">
                    {(() => {
                      const fin = calculateBookingFinancials(b);
                      return `${formatINR(fin.paidAmount)} / ${formatINR(fin.totalAmount)}`;
                    })()}
                  </td>

                  <td className="px-4 py-3.5">
                    <StatusBadge status={b.status} />
                  </td>

                  <td className="px-4 py-3.5 text-right space-x-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedBooking(b);
                      }}
                      className="btn-secondary px-3 py-1 text-xs font-semibold"
                    >
                      Review / Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        /* Standard All / Active / Pending Bookings Table */
        <div className="card overflow-x-auto shadow-xs">
          <table className="w-full min-w-[950px] text-sm">
            <thead>
              <tr className="border-b border-ink-100 bg-ink-50/50 text-left text-xs uppercase tracking-wider text-ink-400">
                <th className="px-4 py-3 font-semibold">Booking</th>
                <th className="px-4 py-3 font-semibold">Customer</th>
                <th className="px-4 py-3 font-semibold">Vehicle & Branch</th>
                <th className="px-4 py-3 font-semibold">Pickup</th>
                <th className="px-4 py-3 font-semibold">Return</th>
                <th className="px-4 py-3 font-semibold">Documents</th>
                <th className="px-4 py-3 font-semibold">Paid</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredBookings.map((b) => {
                const docs = b.documents ?? [];
                const verifiedDocs = docs.filter((d) => d.verified === 1).length;

                return (
                  <tr
                    key={b.id}
                    onClick={() => setSelectedBooking(b)}
                    className="cursor-pointer border-b border-ink-50 hover:bg-ink-50/60 transition"
                  >
                    <td className="px-4 py-3.5">
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-bold font-mono text-ink-900 hover:text-brand-700">
                            {b.booking_no}
                          </span>
                        </div>
                        <p suppressHydrationWarning className="text-[11px] font-medium text-ink-500 flex items-center gap-1">
                          <span className="text-ink-400">🕒</span>
                          <span>{formatDateTime(b.created_at)}</span>
                        </p>
                      </div>
                    </td>

                    <td className="px-4 py-3.5">
                      <p className="font-semibold text-ink-900">{b.customer_name ?? "—"}</p>
                      {b.customer_phone && (
                        <a
                          href={waLink(b.customer_phone)}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline font-mono"
                        >
                          <span>{b.customer_phone}</span>
                          <svg className="h-3 w-3 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                          </svg>
                        </a>
                      )}
                    </td>

                    <td className="px-4 py-3.5">
                      <p className="font-medium text-ink-800">{b.vehicle_name ?? "—"}</p>
                      <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                        <span className="text-xs text-ink-400 font-mono">{b.registration_no ?? "—"}</span>
                        {(b.branch_name || b.pickup_location) && (
                          <span className="inline-flex items-center rounded-sm bg-brand-50 border border-brand-200 px-1.5 py-0.2 text-[10px] font-semibold text-brand-800">
                            🏢 {b.branch_name || b.pickup_location}
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="px-4 py-3.5 text-xs text-ink-600" suppressHydrationWarning>
                      {formatDateTime(b.pickup_at)}
                    </td>

                    <td className="px-4 py-3.5 text-xs text-ink-600" suppressHydrationWarning>
                      {formatDateTime(b.return_at)}
                    </td>

                    <td className="px-4 py-3.5">
                      {docs.length === 0 ? (
                        <span className="text-xs text-ink-400">—</span>
                      ) : (
                        <span
                          className={`badge text-[11px] font-bold ${
                            verifiedDocs === docs.length
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          <svg className="h-3 w-3 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          {verifiedDocs}/{docs.length} Verified
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3.5 font-medium text-ink-800">
                      {(() => {
                        const fin = calculateBookingFinancials(b);
                        return (
                          <>
                            <span className={fin.isFullyPaid ? "text-emerald-700 font-bold" : ""}>
                              {formatINR(fin.paidAmount)}
                            </span>{" "}
                            / {formatINR(fin.totalAmount)}
                          </>
                        );
                      })()}
                    </td>

                    <td className="px-4 py-3.5">
                      <StatusBadge status={b.status} />
                    </td>

                    <td className="px-4 py-3.5 text-right space-x-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedBooking(b);
                        }}
                        className="btn-secondary px-3 py-1 text-xs font-semibold bg-brand-50 text-brand-900 border-brand-200 hover:bg-brand-100"
                      >
                        Review 🔍
                      </button>
                      <Link
                        href={`/dashboard/bookings/${b.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="btn-secondary px-2.5 py-1 text-xs"
                      >
                        Full ↗
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Slide-Over Inspection & Review Drawer */}
      <BookingReviewModal
        booking={selectedBooking}
        isOpen={Boolean(selectedBooking)}
        onClose={() => setSelectedBooking(null)}
      />
    </div>
  );
}
