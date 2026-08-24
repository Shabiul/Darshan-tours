"use server";

import { nextNumber } from "./utils";
import { logActivity, pushNotification } from "./activity";
import { sendTemplate } from "./messaging";
import { createRazorpayOrder, verifyRazorpaySignature, fetchRazorpayPayment, razorpayConfigured, razorpayKeyId } from "./razorpay";
import { generateInvoiceForBooking } from "./invoices";
import { toPaise } from "./utils";
import { calculateBookingFinancials } from "./pricing";
import { sbSelectOne, sbSelect, sbInsert, sbUpdate, sbCount, sbRpc, num } from "./supabase-rest";

/**
 * The money path talks to Supabase directly.
 *
 * It used to write to a per-lambda SQLite file and then fire the Supabase copy
 * as an unawaited promise. Vercel freezes the lambda the moment the response is
 * returned, so those copies frequently never ran: the customer saw "payment
 * successful" while nothing reached the durable store. Every write below is
 * awaited, and a failed write is reported as a failure.
 */

type PaymentRow = {
  id: number;
  payment_no: string;
  booking_id: number | null;
  customer_id: number | null;
  amount: number | string;
  amount_paise: number | string | null;
  status: string;
  gateway_ref: string | null;
  razorpay_order_id: string | null;
};

type BookingRow = {
  id: number;
  booking_no: string | null;
  customer_id: number | null;
  vehicle_id: number | null;
  pickup_at: string | null;
  total_amount: number | string | null;
  deposit_amount: number | string | null;
  base_amount: number | string | null;
  gst_amount: number | string | null;
  paid_amount: number | string | null;
  status: string | null;
};

const nowISO = () => new Date().toISOString();

/**
 * Creates (or reuses) a Pending payment record for the full outstanding amount on a
 * booking and opens a matching Razorpay order against it. Called from the booking
 * confirmation step and from the customer portal's "Pay now".
 */
export async function createBookingPaymentOrder(bookingId: number, overrideAmount?: number): Promise<
  { ok: true; orderId: string; amountPaise: number; keyId: string; paymentId: number; paymentNo: string; notes?: Record<string, string>; businessName: string } | { ok: false; error: string }
> {
  if (!razorpayConfigured()) {
    return { ok: false, error: "Online payment isn't set up yet. Our team will contact you on WhatsApp to arrange payment." };
  }

  const bookingRes = await sbSelectOne<BookingRow>("bookings", `select=*&id=eq.${bookingId}`);
  if (!bookingRes.ok) return { ok: false, error: bookingRes.error };
  const booking = bookingRes.data;
  if (!booking) return { ok: false, error: "Booking not found." };

  // Calculate clean financial figures, ensuring deposit is strictly isolated
  const fin = calculateBookingFinancials(booking);
  const totalAmount = fin.totalAmount;
  const paidAmount = fin.paidAmount;
  const depositAmount = fin.depositAmount;

  // The security deposit is collected in CASH at pickup and is kept separate in `deposit_amount`.
  // `total_amount` is the rental total (base + surcharges + GST), so the amount taken online
  // is that minus anything already paid.
  const onlinePayable = totalAmount;
  const due = overrideAmount && overrideAmount > 0 ? overrideAmount : Math.max(1, onlinePayable - paidAmount);
  if (due <= 0) return { ok: false, error: "This booking is already fully paid." };

  const duePaise = Math.max(100, toPaise(due));

  const breakdownJson = JSON.stringify({
    baseAmount: booking.base_amount != null ? num(booking.base_amount) : Math.max(0, due - num(booking.gst_amount)),
    depositAmount,
    gstAmount: num(booking.gst_amount),
    totalAmount: due,
  });

  const existingRes = await sbSelectOne<PaymentRow>(
    "payments",
    `select=*&booking_id=eq.${bookingId}&status=eq.Pending&kind=eq.full&order=id.desc`
  );
  if (!existingRes.ok) return { ok: false, error: existingRes.error };

  let payment: { id: number; payment_no: string; amount: number };

  if (existingRes.data) {
    const upd = await sbUpdate("payments", `id=eq.${existingRes.data.id}`, { breakdown_json: breakdownJson });
    if (!upd.ok) return { ok: false, error: upd.error };
    payment = { id: existingRes.data.id, payment_no: existingRes.data.payment_no, amount: num(existingRes.data.amount) };
  } else {
    const paymentNo = nextNumber("PY", null);
    const ins = await sbInsert<PaymentRow>("payments", {
      payment_no: paymentNo,
      booking_id: bookingId,
      customer_id: booking.customer_id ?? null,
      amount: due,
      amount_paise: duePaise,
      currency: "INR",
      kind: "full",
      status: "Pending",
      notes: "Rental fare payment",
      breakdown_json: breakdownJson,
      created_at: nowISO(),
    });
    if (!ins.ok) return { ok: false, error: ins.error };
    payment = { id: ins.data.id, payment_no: ins.data.payment_no, amount: num(ins.data.amount) };
  }

  const gstAmount = Math.round(totalAmount * 0.06);
  const rzpNotes: Record<string, string> = {
    "Booking No": String(booking.booking_no ?? `BK-${bookingId}`),
    "Rental Base": `₹${totalAmount.toLocaleString("en-IN")}`,
    "Pickup Fee": `₹250`,
    "GST (6%)": `₹${gstAmount.toLocaleString("en-IN")}`,
    "Refundable Deposit": `₹${depositAmount.toLocaleString("en-IN")}`,
  };

  const order = await createRazorpayOrder({ amountInRupees: payment.amount, receipt: payment.payment_no, notes: rzpNotes });
  if (!order.ok) return { ok: false, error: order.error };

  // The order id must be durably attached to the payment row before the customer
  // pays, otherwise the webhook cannot find the record it belongs to.
  const link = await sbUpdate("payments", `id=eq.${payment.id}`, {
    gateway_ref: order.orderId,
    razorpay_order_id: order.orderId,
    amount_paise: duePaise,
  });
  if (!link.ok) return { ok: false, error: link.error };

  return {
    ok: true,
    orderId: order.orderId,
    amountPaise: order.amount,
    keyId: razorpayKeyId()!,
    paymentId: payment.id,
    paymentNo: payment.payment_no,
    notes: rzpNotes,
    businessName: "Darshh Holiday",
  };
}

export async function verifyBookingPayment(input: {
  paymentId: number;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
  skipSignatureCheck?: boolean;
}): Promise<{ ok: true; bookingNo: string; alreadyProcessed?: boolean } | { ok: false; error: string }> {
  // 1. Idempotency: a Razorpay payment id is unique, so if one is already recorded
  //    as Paid this is a replay (webhook retry, or the browser callback racing the
  //    webhook) and must not be applied to the booking a second time.
  const priorRes = await sbSelectOne<{ id: number; status: string; booking_id: number | null }>(
    "payments",
    `select=id,status,booking_id&razorpay_payment_id=eq.${encodeURIComponent(input.razorpayPaymentId)}`
  );
  if (!priorRes.ok) return { ok: false, error: priorRes.error };
  if (priorRes.data && priorRes.data.status === "Paid") {
    const bookingNo = await lookupBookingNo(priorRes.data.booking_id);
    return { ok: true, bookingNo: bookingNo ?? `BK-${input.paymentId}`, alreadyProcessed: true };
  }

  if (!input.skipSignatureCheck) {
    const valid = verifyRazorpaySignature(input.razorpayOrderId, input.razorpayPaymentId, input.razorpaySignature);
    if (!valid) {
      await logActivity(null, "payment_signature_invalid", "payment", input.paymentId, { orderId: input.razorpayOrderId });
      return { ok: false, error: "We could not verify this payment. If money was deducted, contact us with your booking number and we'll sort it out." };
    }
  }

  const orderId = encodeURIComponent(input.razorpayOrderId);
  const paymentRes = await sbSelectOne<PaymentRow>(
    "payments",
    `select=*&id=eq.${input.paymentId}&or=(gateway_ref.eq.${orderId},razorpay_order_id.eq.${orderId})`
  );
  if (!paymentRes.ok) return { ok: false, error: paymentRes.error };
  const payment = paymentRes.data;
  if (!payment) return { ok: false, error: "Payment record not found." };

  if (payment.status === "Paid") {
    const bookingNo = await lookupBookingNo(payment.booking_id);
    return { ok: true, bookingNo: bookingNo ?? "", alreadyProcessed: true };
  }

  const paidAmount = num(payment.amount);
  const receiptNo = nextNumber("RC", null);

  // Fetch verified payment details directly from Razorpay API
  let realMethod: string | null = null;
  let realVpa: string | null = null;
  let realBankRef: string | null = null;

  try {
    const rzpRes = await fetchRazorpayPayment(input.razorpayPaymentId);
    if (rzpRes.ok) {
      const p = rzpRes.payment;
      realVpa = p.vpa || p.upi?.vpa || null;
      realMethod = p.method ? (p.method.toLowerCase() === "upi" ? "UPI" : p.method.toUpperCase()) : null;
      realBankRef = p.acquirer_data?.rrn || p.acquirer_data?.upi_transaction_id || p.acquirer_data?.bank_transaction_id || null;
    }
  } catch {}

  // COALESCE semantics: only overwrite when Razorpay actually told us something.
  const patch: Record<string, unknown> = {
    status: "Paid",
    paid_at: nowISO(),
    notes: `Razorpay payment ID: ${input.razorpayPaymentId}`,
    receipt_no: receiptNo,
    gateway_ref: input.razorpayPaymentId,
    razorpay_order_id: input.razorpayOrderId,
    razorpay_payment_id: input.razorpayPaymentId,
    razorpay_signature: input.razorpaySignature,
  };
  if (realMethod) patch.method = realMethod;
  if (realVpa) {
    patch.upi_id = realVpa;
    patch.vpa = realVpa;
  }
  if (realBankRef) patch.bank_ref_no = realBankRef;

  // Guard on status so two concurrent verifications cannot both mark it Paid.
  const paidUpdate = await sbUpdate<PaymentRow>("payments", `id=eq.${payment.id}&status=neq.Paid`, patch);
  if (!paidUpdate.ok) return { ok: false, error: `Could not record the payment: ${paidUpdate.error}` };
  if (paidUpdate.data.length === 0) {
    const bookingNo = await lookupBookingNo(payment.booking_id);
    return { ok: true, bookingNo: bookingNo ?? "", alreadyProcessed: true };
  }

  const bookingId = payment.booking_id;
  if (!bookingId) return { ok: false, error: "Payment is not linked to a booking." };

  const unverifiedDocs = await sbCount("customer_documents", `booking_id=eq.${bookingId}&verified=eq.0`);
  const newBookingStatus = unverifiedDocs.ok && unverifiedDocs.data === 0 ? "Confirmed" : "Payment received";

  // Atomic accumulate in Postgres. Read-modify-write in application code loses
  // one of two concurrent payments.
  const incr = await sbRpc<number>("increment_booking_paid", { p_booking_id: bookingId, p_amount: paidAmount });
  if (!incr.ok) return { ok: false, error: `Payment recorded but the booking balance could not be updated: ${incr.error}` };

  const statusUpdate = await sbUpdate("bookings", `id=eq.${bookingId}`, { status: newBookingStatus, updated_at: nowISO() });
  if (!statusUpdate.ok) return { ok: false, error: `Payment recorded but the booking status could not be updated: ${statusUpdate.error}` };

  await sbInsert("booking_history", {
    booking_id: bookingId,
    action: "payment_verified",
    detail: JSON.stringify({
      payment_no: payment.payment_no,
      amount: paidAmount,
      razorpay_payment_id: input.razorpayPaymentId,
      status: newBookingStatus,
    }),
    created_at: nowISO(),
  });

  await logActivity(null, "payment_verified", "payment", payment.id, { amount: paidAmount, razorpay_payment_id: input.razorpayPaymentId });

  // Invoicing must never block a verified payment from being recorded.
  const invoice = await generateInvoiceForBooking(bookingId).catch((err) => {
    console.error("[payments] invoice generation failed", err);
    return null;
  });

  const bookingRes = await sbSelectOne<BookingRow>("bookings", `select=booking_no,pickup_at,customer_id,vehicle_id&id=eq.${bookingId}`);
  const booking = bookingRes.ok ? bookingRes.data : null;

  let customerName: string | null = null;
  let customerPhone: string | null = null;
  let vehicleName: string | null = null;

  if (booking?.customer_id) {
    const c = await sbSelectOne<{ name: string | null; phone: string | null }>("customers", `select=name,phone&id=eq.${booking.customer_id}`);
    if (c.ok && c.data) {
      customerName = c.data.name;
      customerPhone = c.data.phone;
    }
  }
  if (booking?.vehicle_id) {
    const v = await sbSelectOne<{ name: string | null }>("vehicles", `select=name&id=eq.${booking.vehicle_id}`);
    if (v.ok && v.data) vehicleName = v.data.name;
  }

  const bookingNo = booking?.booking_no ?? "";

  if (customerPhone) {
    try {
      await sendTemplate("payment_receipt", customerPhone, { name: customerName ?? "", amount: `₹${paidAmount.toLocaleString("en-IN")}`, reference: input.razorpayPaymentId, receipt_no: receiptNo, booking_no: bookingNo }, null, bookingId);
      await sendTemplate("booking_confirmation", customerPhone, { name: customerName ?? "", booking_no: bookingNo, vehicle: vehicleName ?? "", pickup_at: booking?.pickup_at ?? "", location: "" }, null, bookingId);
      if (invoice) {
        await sendTemplate("invoice_generated", customerPhone, { name: customerName ?? "", invoice_no: invoice.invoiceNo, booking_no: bookingNo, total: `₹${paidAmount.toLocaleString("en-IN")}` }, null, bookingId);
      }
    } catch {
      // best-effort — messaging must never block a verified payment from being recorded
    }
  }

  const staff = await sbSelect<{ id: number }>("users", "select=id&role=in.(admin,manager)&is_active=eq.1");
  if (staff.ok) {
    for (const s of staff.data) {
      await pushNotification(s.id, `Payment received — ${bookingNo}`, `${customerName ?? "Customer"} · ${vehicleName ?? ""}`, null, bookingId);
    }
  }

  try {
    const { cacheInvalidatePrefix } = await import("./redis");
    await cacheInvalidatePrefix("web:gateway:");
    await cacheInvalidatePrefix("vehicles:");
    await cacheInvalidatePrefix("fleet:");
  } catch {}

  try {
    const { revalidatePath } = await import("next/cache");
    revalidatePath("/dashboard", "layout");
    revalidatePath("/dashboard/bookings", "page");
    revalidatePath("/dashboard/vehicles", "page");
    revalidatePath("/dashboard/allocations", "page");
  } catch {}

  return { ok: true, bookingNo };
}

async function lookupBookingNo(bookingId: number | null | undefined): Promise<string | null> {
  if (!bookingId) return null;
  const res = await sbSelectOne<{ booking_no: string | null }>("bookings", `select=booking_no&id=eq.${bookingId}`);
  return res.ok ? res.data?.booking_no ?? null : null;
}
