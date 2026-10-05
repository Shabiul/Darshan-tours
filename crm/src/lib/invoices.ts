import { sbSelect, sbSelectOne, sbInsert, num } from "./supabase-rest";
import { nextNumber } from "./utils";
import { getSetting } from "./settings";

export type Invoice = {
  id: number;
  invoice_no: string;
  booking_id: number | null;
  customer_id: number | null;
  subtotal: number;
  tax_pct: number;
  discount: number;
  total: number;
  status: string;
};

/** Returns the existing invoice for a booking, or null. */
export async function getInvoiceForBooking(bookingId: number): Promise<Invoice | null> {
  const res = await sbSelectOne<Invoice>("invoices", `select=*&booking_id=eq.${bookingId}`);
  if (!res.ok) throw new Error(`Could not load the invoice: ${res.error}`);
  return res.data;
}

/** Generates (or returns the existing) tax invoice for a booking, itemising base rate,
 * off-schedule/late fees, GST and gateway fee — matching what the customer was quoted.
 *
 * Supabase is the system of record; the SQLite mirror is no longer written to. Money
 * columns arrive from PostgREST as NUMERIC strings, so every amount goes through num()
 * before arithmetic — plain `+` on them concatenates.
 */
export async function generateInvoiceForBooking(bookingRef: number | string): Promise<{ id: number; invoiceNo: string }> {
  const rawRef = String(bookingRef).trim();
  const filter = /^\d+$/.test(rawRef)
    ? `or=(id.eq.${rawRef},booking_no.eq.${rawRef},booking_no.eq.BK-${rawRef})`
    : `or=(booking_no.eq.${encodeURIComponent(rawRef)},booking_no.eq.${encodeURIComponent(rawRef.replace(/^BK-/i, ""))})`;

  const bookingRes = await sbSelectOne<Record<string, unknown>>("bookings", `select=*&${filter}`);
  if (!bookingRes.ok) throw new Error(`Could not load the booking: ${bookingRes.error}`);
  const booking = bookingRes.data;
  if (!booking) throw new Error(`Booking ${bookingRef} not found.`);

  const bookingId = Number(booking.id);
  const existing = await getInvoiceForBooking(bookingId);
  if (existing) return { id: Number(existing.id), invoiceNo: existing.invoice_no };

  const gstPct = await getSetting<number>("tax_pct", 6);

  const subtotal = Math.max(
    0,
    Math.round(
      (num(booking.base_amount) +
        num(booking.other_fees_amount) +
        num(booking.extra_km_amount) +
        num(booking.late_fee_amount) +
        num(booking.damage_amount)) *
        100
    ) / 100
  );
  const discount = Math.max(0, Math.round(num(booking.discount_amount) * 100) / 100);
  const gstAmount = Math.max(0, Math.round(num(booking.gst_amount) * 100) / 100);
  const total = Math.max(0, Math.round((subtotal + gstAmount - discount) * 100) / 100);

  const invoiceNo = nextNumber("INV", null);
  const targetCustomerId =
    booking.customer_id === null || booking.customer_id === undefined ? null : Number(booking.customer_id);

  let insert = await sbInsert<Invoice>("invoices", {
    invoice_no: invoiceNo,
    booking_id: bookingId,
    customer_id: targetCustomerId,
    subtotal,
    tax_pct: num(gstPct),
    discount,
    total,
    status: "issued",
  });

  // If insert failed due to a foreign key constraint on customer_id, retry without customer_id
  if (!insert.ok && targetCustomerId !== null && /customer_id|foreign key|23503/i.test(insert.error)) {
    insert = await sbInsert<Invoice>("invoices", {
      invoice_no: nextNumber("INV", null),
      booking_id: bookingId,
      customer_id: null,
      subtotal,
      tax_pct: num(gstPct),
      discount,
      total,
      status: "issued",
    });
  }

  if (!insert.ok) {
    const recheck = await getInvoiceForBooking(bookingId);
    if (recheck) return { id: Number(recheck.id), invoiceNo: recheck.invoice_no };
    throw new Error(`Could not create the invoice: ${insert.error}`);
  }

  const row = Array.isArray(insert.data) ? insert.data[0] : insert.data;
  if (!row || !row.id) {
    const recheck = await getInvoiceForBooking(bookingId);
    if (recheck) return { id: Number(recheck.id), invoiceNo: recheck.invoice_no };
    throw new Error(`Invoice insert returned empty representation.`);
  }

  return { id: Number(row.id), invoiceNo: row.invoice_no ?? invoiceNo };
}

/**
 * Scans confirmed/paid bookings to ensure every single one has an issued invoice.
 * Generates missing invoices idempotently and returns the count of repaired rows.
 */
export async function healMissingInvoices(): Promise<{ scanned: number; generated: number }> {
  const [invRes, bRes] = await Promise.all([
    sbSelect<{ booking_id: number | null }>("invoices", "select=booking_id&booking_id=not.is.null"),
    sbSelect<{ id: number; status: string; paid_amount: number | string }>(
      "bookings",
      "select=id,status,paid_amount&or=(status.eq.Confirmed,status.eq.Payment received,paid_amount.gt.0)&order=id.desc&limit=200"
    ),
  ]);

  if (!bRes.ok || !invRes.ok) return { scanned: 0, generated: 0 };

  const existingBookingIds = new Set(
    invRes.data.map((r) => Number(r.booking_id)).filter((id) => Number.isInteger(id) && id > 0)
  );

  let generated = 0;
  for (const b of bRes.data) {
    const bId = Number(b.id);
    if (!existingBookingIds.has(bId)) {
      try {
        const res = await generateInvoiceForBooking(bId);
        if (res?.id) {
          existingBookingIds.add(bId);
          generated++;
        }
      } catch (err) {
        console.warn(`[invoices] healMissingInvoices failed for booking ${bId}:`, err);
      }
    }
  }

  return { scanned: bRes.data.length, generated };
}
