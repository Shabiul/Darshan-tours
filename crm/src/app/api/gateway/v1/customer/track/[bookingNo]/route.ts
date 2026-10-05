import { NextRequest, NextResponse } from "next/server";
import { sbSelect, sbSelectOne, num } from "@/lib/supabase-rest";
import { calculateBookingFinancials } from "@/lib/pricing";

/**
 * Public booking tracker. Everything here comes from Supabase in one pass — the previous
 * version read a local SQLite mirror first and only fell back to Supabase for the booking
 * itself, so on a cold lambda the booking was found but its documents, payments and
 * history all came back empty and the tracker showed a paid booking as unpaid.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ bookingNo: string }> }) {
  const { bookingNo } = await params;
  const rawRef = String(bookingNo).trim();
  if (!rawRef) {
    return NextResponse.json({ ok: false, error: "Missing booking number." }, { status: 400 });
  }

  // Support matching booking_no verbatim or with/without a BK- prefix. Deliberately
  // never falls back to the raw numeric primary key: this endpoint is unauthenticated
  // (anyone holding a booking number reaches it), and matching on `id` let anyone walk
  // /track/1, /track/2, ... and pull up every booking's customer name, vehicle, dates
  // and financial totals in the system. booking_no is long and non-sequential
  // (BK-2026-XXXXXXX), so it isn't practically guessable the way a small integer is.
  const filter = /^\d+$/.test(rawRef)
    ? `or=(booking_no.eq.${rawRef},booking_no.eq.BK-${rawRef})`
    : `or=(booking_no.eq.${encodeURIComponent(rawRef)},booking_no.eq.${encodeURIComponent(rawRef.replace(/^BK-/i, ""))})`;

  const bookingRes = await sbSelectOne<Record<string, any>>(
    "bookings",
    `select=*,customers(name,phone,email),vehicles(name,registration_no,brand,model),invoices(invoice_no,created_at)` +
      `&${filter}`
  );
  if (!bookingRes.ok) return NextResponse.json({ ok: false, error: bookingRes.error }, { status: 502 });

  const booking = bookingRes.data;
  if (!booking) return NextResponse.json({ ok: false, error: "Booking not found." }, { status: 404 });

  const bookingId = Number(booking.id);
  const customerId = Number(booking.customer_id) || 0;
  let invoice = Array.isArray(booking.invoices) ? booking.invoices[0] : booking.invoices;

  if (!invoice && (booking.status === "Confirmed" || booking.status === "Payment received" || num(booking.paid_amount) > 0)) {
    try {
      const { generateInvoiceForBooking, getInvoiceForBooking } = await import("@/lib/invoices");
      await generateInvoiceForBooking(bookingId);
      const freshlyGenerated = await getInvoiceForBooking(bookingId);
      if (freshlyGenerated) {
        invoice = freshlyGenerated;
      }
    } catch (e) {
      console.warn(`[tracker] invoice generation failed for ${bookingId}:`, e);
    }
  }

  const [photoRes, docsRes, paymentsRes, historyRes] = await Promise.all([
    booking.vehicle_id
      ? sbSelectOne<{ url: string }>(
          "vehicle_photos",
          `select=url&vehicle_id=eq.${Number(booking.vehicle_id)}&order=is_primary.desc`
        )
      : Promise.resolve({ ok: true as const, data: null }),
    sbSelect<Record<string, unknown>>(
      "customer_documents",
      // Scoped to THIS booking. It previously also matched on customer_id, so a
      // returning customer saw every document from every past booking stacked onto
      // whichever one they were viewing — seventeen entries on a booking with five.
      // Every insert always sets booking_id, so nothing legitimate is lost.
      `select=id,kind,number,verified,created_at&booking_id=eq.${bookingId}`
    ),
    sbSelect<Record<string, unknown>>(
      "payments",
      `select=id,payment_no,amount,kind,method,status,razorpay_payment_id,paid_at&booking_id=eq.${bookingId}&order=created_at.desc`
    ),
    sbSelect<Record<string, unknown>>(
      "booking_history",
      `select=action,detail,created_at&booking_id=eq.${bookingId}&order=created_at.asc`
    ),
  ]);

  const photoUrl = (photoRes.ok && photoRes.data?.url) || "/vehicles/mahindra-thar.avif";
  const docs = docsRes.ok ? docsRes.data : [];
  const payments = paymentsRes.ok ? paymentsRes.data : [];
  const history = historyRes.ok ? historyRes.data : [];

  // `verified` is INTEGER in the schema, not boolean.
  const totalVerifiedDocs = docs.filter((d) => num(d.verified) === 1).length;
  const isAllDocsVerified = docs.length > 0 && totalVerifiedDocs === docs.length;

  // PUBLIC, UNAUTHENTICATED PROJECTION.
  //
  // Anyone holding a booking number reaches this, so it carries only what a customer
  // needs to see their booking's progress. Removed from the previous response, all of
  // which was being served to anonymous callers:
  //   - documents[].number  — the raw driving licence / government ID number
  //   - customer_phone      — PII
  //   - notes               — free-text internal/rejection commentary
  //   - registration_no     — identifies the physical vehicle
  //   - id, documents[].id  — internal primary keys
  //   - payment_no, invoice_no — financial document identifiers
  //   - history[]           — internal audit trail
  // Document verification is reported as counts and a per-kind status only, which is
  // all the tracking screen actually renders.
  return NextResponse.json({
    ok: true,
    data: {
      booking_no: booking.booking_no,
      status: booking.status,
      pickup_at: booking.pickup_at,
      return_at: booking.return_at,
      pickup_branch: "Darshh Holiday - Hassan & Sakleshpura Branch",
      customer_name: booking.customers?.name ?? null,
      vehicle_name: booking.vehicles?.name ?? null,
      photo_url: photoUrl,
      base_amount: num(booking.base_amount),
      gst_amount: num(booking.gst_amount),
      deposit_amount: calculateBookingFinancials(booking).depositAmount,
      total_amount: calculateBookingFinancials(booking).totalAmount,
      paid_amount: calculateBookingFinancials(booking).paidAmount,
      balance_due: calculateBookingFinancials(booking).balanceDue,
      documents: docs.map((d) => ({
        kind: String(d.kind),
        verified: num(d.verified) === 1,
      })),
      total_docs: docs.length,
      verified_docs: totalVerifiedDocs,
      is_all_docs_verified: isAllDocsVerified,
      payments: payments.map((p) => ({
        amount: num(p.amount),
        kind: String(p.kind),
        status: String(p.status),
        method: p.method ? String(p.method) : "Online",
        paid_at: p.paid_at ? String(p.paid_at) : null,
      })),
      invoice: invoice ? { invoice_no: String(invoice.invoice_no), created_at: invoice.created_at } : null,
      created_at: booking.created_at,
    },
  });
}
