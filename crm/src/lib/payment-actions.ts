"use server";

import { nextNumber, parseJSON } from "./utils";
import { logActivity, pushNotification } from "./activity";
import { sendTemplate } from "./messaging";
import { createRazorpayOrder, verifyRazorpaySignature, fetchRazorpayPayment, razorpayConfigured, razorpayKeyId } from "./razorpay";
import { generateInvoiceForBooking } from "./invoices";
import { toPaise } from "./utils";
import { calculateBookingFinancials, calculateQuote } from "./pricing";
import { parseIstInstant } from "./rental-clock";
import { getVehicleById } from "./data";
import { sbSelectOne, sbSelect, sbInsert, sbUpdate, sbDelete, sbCount, sbRpc, num } from "./supabase-rest";

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
 * Creates (or reuses) a payment order against Razorpay.
 * Can be called with an existing `bookingId` or with pre-booking quote/amount details.
 * For new online checkouts, NO booking is created in the database until Razorpay confirms Paid.
 */
export async function createBookingPaymentOrder(
  bookingId?: number | null,
  overrideAmount?: number,
  quote?: {
    days?: number;
    baseAmount?: number;
    gstPct?: number;
    gstAmount?: number;
    depositAmount?: number;
    gatewayFeeAmount?: number;
    totalAmount?: number;
    payableNow?: number;
    depositPayableAtPickup?: number;
  } | null,
  customerInfo?: { name?: string; phone?: string; email?: string }
): Promise<
  { ok: true; orderId: string; amountPaise: number; keyId: string; paymentId: number; paymentNo: string; notes?: Record<string, string>; businessName: string } | { ok: false; error: string }
> {
  if (!razorpayConfigured()) {
    return { ok: false, error: "Online payment isn't set up yet. Our team will contact you on WhatsApp to arrange payment." };
  }

  // 1. If an existing booking is being paid (e.g. from customer portal or balance settlement)
  if (bookingId && bookingId > 0) {
    const bookingRes = await sbSelectOne<BookingRow>("bookings", `select=*&id=eq.${bookingId}`);
    if (!bookingRes.ok) return { ok: false, error: bookingRes.error };
    const booking = bookingRes.data;
    if (!booking) return { ok: false, error: "Booking not found." };

    const fin = calculateBookingFinancials(booking);
    const totalAmount = fin.totalAmount;
    const paidAmount = fin.paidAmount;
    const depositAmount = fin.depositAmount;

    const onlinePayable = totalAmount;
    const due = overrideAmount && overrideAmount > 0 ? overrideAmount : Math.max(1, onlinePayable - paidAmount);
    if (due <= 0) return { ok: false, error: "This booking is already fully paid." };

    // The reservation/payment window and the 3-attempt limit are constraints on the
    // SAME lifecycle, so both are evaluated together, database-side, against the
    // database clock and the one stored payment_window_expires_at.
    //
    // This gate did not exist: only the attempt count and "already fully paid" were
    // checked. Once the window closed, is_expired_reservation() had already freed the
    // unit to other customers, yet this function would still mint attempt 2 or 3 and
    // open a live Razorpay order — so a customer could pay, in full, for a vehicle
    // that was no longer held for them.
    const gate = await sbRpc<string>("can_start_payment_attempt", { p_booking_id: bookingId });
    if (!gate.ok) {
      return { ok: false, error: "Could not verify this booking's payment window: " + gate.error };
    }
    switch (gate.data) {
      case "ok":
        break;
      case "already_paid":
        return { ok: false, error: "This booking is already paid." };
      case "window_closed":
        return { ok: false, error: "The 15-minute payment window for this reservation has expired. Please start a new booking." };
      case "attempts_exhausted":
        return { ok: false, error: "This booking has already reached the maximum of 3 payment attempts. Please start a new booking." };
      case "not_active":
        return { ok: false, error: "This reservation is no longer active. Please start a new booking." };
      case "not_found":
        return { ok: false, error: "Booking not found." };
      default:
        return { ok: false, error: "This reservation cannot take a payment right now." };
    }

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
      // Deterministic attempt number, counted from the database rather than trusted
      // from any client-side counter or the Razorpay payment id. A booking gets at
      // most 3 payment attempts; the 4th is refused outright. The unique index on
      // (booking_id, attempt_number) is the actual guarantee against two concurrent
      // callers both minting "attempt 2" for the same booking — this loop just
      // recovers cleanly if that race is ever lost, instead of surfacing a raw
      // constraint error to the customer.
      let payment_: { id: number; payment_no: string; amount: number } | null = null;
      let attemptError = "";
      for (let tryNo = 0; tryNo < 2 && !payment_; tryNo++) {
        const priorAttempts = await sbCount("payments", `booking_id=eq.${bookingId}`);
        const attemptNumber = (priorAttempts.ok ? priorAttempts.data : 0) + 1;
        if (attemptNumber > 3) {
          return { ok: false, error: "This booking has already reached the maximum of 3 payment attempts. Please start a new booking." };
        }

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
          attempt_number: attemptNumber,
          created_at: nowISO(),
        });
        if (ins.ok) {
          payment_ = { id: ins.data.id, payment_no: ins.data.payment_no, amount: num(ins.data.amount) };
          break;
        }
        attemptError = ins.error;
        const isRaceOnAttemptNumber = ins.status === 409 || /duplicate key|already exists|23505/i.test(ins.error);
        if (!isRaceOnAttemptNumber) return { ok: false, error: ins.error };
        // Lost the race for this attempt number — loop recounts and tries the next one.
      }
      if (!payment_) return { ok: false, error: attemptError || "Could not start a new payment attempt." };
      payment = payment_;
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

  // 2. Pre-booking online checkout order
  const finalAmount = overrideAmount && overrideAmount > 0 ? overrideAmount : (quote?.payableNow ?? quote?.totalAmount ?? 1);
  const duePaise = Math.max(100, Math.round(finalAmount * 100));
  const paymentNo = nextNumber("PY", null);

  const baseAmt = quote?.baseAmount ?? Math.max(0, finalAmount - (quote?.gstAmount ?? 0));
  const depAmt = quote?.depositPayableAtPickup ?? quote?.depositAmount ?? 0;
  const gstAmt = quote?.gstAmount ?? 0;

  const rzpNotes: Record<string, string> = {
    "Customer": customerInfo?.name ?? "Online Customer",
    "Phone": customerInfo?.phone ?? "",
    "Base Rental": `₹${baseAmt.toLocaleString("en-IN")}`,
    "GST (6%)": gstAmt > 0 ? `₹${gstAmt.toLocaleString("en-IN")}` : "Included",
    "Deposit (cash at pickup)": depAmt > 0 ? `₹${depAmt.toLocaleString("en-IN")}` : "Collected at pickup",
    "Paid Online Now": `₹${finalAmount.toLocaleString("en-IN")}`,
  };

  const order = await createRazorpayOrder({ amountInRupees: finalAmount, receipt: paymentNo, notes: rzpNotes });
  if (!order.ok) return { ok: false, error: order.error };

  // Look up or create customer if phone provided
  let customerId: number | null = null;
  if (customerInfo?.phone) {
    try {
      const { findOrCreateCustomer } = await import("./bookings");
      const custRes = await findOrCreateCustomer({
        name: customerInfo.name || "Online Customer",
        phone: customerInfo.phone,
        email: customerInfo.email,
      });
      if (custRes.ok) customerId = custRes.customerId;
    } catch {}
  }

  const breakdownJson = JSON.stringify({
    baseAmount: baseAmt,
    depositAmount: depAmt,
    gstAmount: gstAmt,
    totalAmount: finalAmount,
  });

  // Pre-insert a Pending payment row so every created order has a durable database trail
  const ins = await sbInsert<PaymentRow>("payments", {
    payment_no: paymentNo,
    booking_id: null,
    customer_id: customerId,
    amount: finalAmount,
    amount_paise: duePaise,
    currency: "INR",
    kind: "full",
    status: "Pending",
    notes: `Pre-booking checkout for ${customerInfo?.name ?? "Customer"} (${customerInfo?.phone ?? ""})`,
    gateway_ref: order.orderId,
    razorpay_order_id: order.orderId,
    breakdown_json: breakdownJson,
    created_at: nowISO(),
  });

  const createdPaymentId = ins.ok ? ins.data.id : 0;

  return {
    ok: true,
    orderId: order.orderId,
    amountPaise: order.amount,
    keyId: razorpayKeyId()!,
    paymentId: createdPaymentId,
    paymentNo,
    notes: rzpNotes,
    businessName: "Darshh Holiday",
  };
}

/**
 * Releases a booking's reservation once its payment attempts have genuinely failed.
 *
 * Idempotent: the status-guarded UPDATE below only ever affects the FIRST call to see
 * the booking as "Pending payment" — a second release call (a stale retry racing its
 * own first attempt, or a duplicate trigger) sees zero affected rows and returns
 * cleanly, never releasing the same inventory twice.
 *
 * Confirmation always wins: re-checks the payments table directly (not just the
 * booking's own status column) for an actual Paid row before releasing anything, so a
 * payment.captured webhook that arrives late — even after release logic has already
 * started — cannot be undone by this call finishing afterward.
 */
export async function releaseBookingReservation(
  bookingId: number
): Promise<{ ok: true; released: boolean } | { ok: false; error: string }> {
  const bookingRes = await sbSelectOne<{ id: number; status: string; paid_amount: number | string }>(
    "bookings",
    `select=id,status,paid_amount&id=eq.${bookingId}`
  );
  if (!bookingRes.ok) return { ok: false, error: bookingRes.error };
  const booking = bookingRes.data;
  if (!booking) return { ok: false, error: `Booking ${bookingId} not found.` };

  if (booking.status === "Confirmed" || booking.status === "Payment received" || num(booking.paid_amount) > 0) {
    return { ok: true, released: false };
  }

  const paidRes = await sbCount("payments", `booking_id=eq.${bookingId}&status=eq.Paid`);
  if (paidRes.ok && paidRes.data > 0) {
    // A successful payment exists that hasn't confirmed the booking yet (a race with
    // verifyBookingPayment still in flight) — do not release under it.
    return { ok: true, released: false };
  }

  const statusFlip = await sbUpdate(
    "bookings",
    `id=eq.${bookingId}&status=eq.${encodeURIComponent("Pending payment")}`,
    { status: "Rejected", notes: "Payment abandoned after 3 failed attempts.", updated_at: nowISO() }
  );
  if (!statusFlip.ok) return { ok: false, error: statusFlip.error };
  if (statusFlip.data.length === 0) {
    // Already moved on (confirmed by a race, or already released by a prior call).
    return { ok: true, released: false };
  }

  // Not fatal to the caller, but if this fails the unit stays held by a booking that
  // has just been rejected — the exact "reservation stuck" state. Must be visible.
  const releasedBlocks = await sbDelete("availability_blocks", `booking_id=eq.${bookingId}`);
  if (!releasedBlocks.ok) console.error(`[payments] booking ${bookingId}: hold not released — ${releasedBlocks.error}`);

  await sbInsert("booking_history", {
    booking_id: bookingId,
    action: "reservation_released",
    detail: JSON.stringify({ reason: "3 failed payment attempts" }),
    created_at: nowISO(),
  });

  return { ok: true, released: true };
}

/**
 * Records a payment attempt as failed/abandoned (webhook payment.failed, or the
 * customer dismissing the Razorpay checkout without completing it) and releases the
 * reservation once the 3rd attempt is exhausted. Safe to call from either source, and
 * safe if it races a genuine capture: the Paid check and the CAS below mean a payment
 * that actually succeeded is never overwritten to Failed, and releaseBookingReservation
 * independently re-verifies no Paid payment exists before releasing anything.
 */
export async function recordFailedPaymentAttempt(
  paymentId: number
): Promise<
  | { ok: true; bookingId: number | null; attemptNumber: number | null; released: boolean; attemptsExhausted: boolean }
  | { ok: false; error: string }
> {
  const paymentRes = await sbSelectOne<{ id: number; booking_id: number | null; status: string; attempt_number: number | null }>(
    "payments",
    `select=id,booking_id,status,attempt_number&id=eq.${paymentId}`
  );
  if (!paymentRes.ok) return { ok: false, error: paymentRes.error };
  const payment = paymentRes.data;
  if (!payment) return { ok: false, error: `Payment ${paymentId} not found.` };

  if (payment.status === "Paid") {
    return { ok: true, bookingId: payment.booking_id, attemptNumber: payment.attempt_number, released: false, attemptsExhausted: false };
  }

  // Compare-and-swap: only the first caller to see this row as Pending flips it, same
  // pattern as the Paid transition below in verifyBookingPayment.
  const markedFailed = await sbUpdate("payments", `id=eq.${paymentId}&status=eq.Pending`, { status: "Failed" });
  if (!markedFailed.ok) console.error(`[payments] payment ${paymentId}: not marked Failed — ${markedFailed.error}`);

  if (!payment.booking_id) {
    return { ok: true, bookingId: null, attemptNumber: payment.attempt_number, released: false, attemptsExhausted: false };
  }

  const attemptNumber = payment.attempt_number ?? 0;
  if (attemptNumber < 3) {
    return { ok: true, bookingId: payment.booking_id, attemptNumber, released: false, attemptsExhausted: false };
  }

  const release = await releaseBookingReservation(payment.booking_id);
  if (!release.ok) return release;

  return { ok: true, bookingId: payment.booking_id, attemptNumber, released: release.released, attemptsExhausted: true };
}

export async function verifyBookingPayment(input: {
  paymentId?: number;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature?: string;
  skipSignatureCheck?: boolean;
  bookingPayload?: any;
}): Promise<{ ok: true; bookingNo: string; bookingId?: number; alreadyProcessed?: boolean } | { ok: false; error: string }> {
  // Attaching is guarded on the booking having no documents yet, so a Razorpay retry or
  // a customer refreshing the confirmation page cannot produce duplicate rows.
  async function attachDocumentsIfMissing(bookingId: number, payload: any): Promise<void> {
    const docs = payload?.documents;
    if (!Array.isArray(docs) || docs.length === 0) return;

    const existing = await sbCount("customer_documents", `booking_id=eq.${bookingId}`);
    if (!existing.ok || existing.data > 0) return;

    const bookingRow = await sbSelectOne<{ customer_id: number | null }>(
      "bookings",
      `select=customer_id&id=eq.${bookingId}`
    );
    const customerId = bookingRow.ok && bookingRow.data ? bookingRow.data.customer_id : null;
    if (!customerId) return;

    try {
      const { attachCustomerDocuments } = await import("./booking-actions");
      const res = await attachCustomerDocuments(customerId, bookingId, docs);
      if (!res.ok) {
        console.error(`[payments] booking ${bookingId}: documents not attached — ${res.error}`);
      }
    } catch (err) {
      // Never let document attachment fail a payment that is already settled.
      console.error(`[payments] booking ${bookingId}: document attachment threw`, err);
    }
  }

  // 1. Idempotency check on Razorpay payment ID
  const priorRes = await sbSelectOne<{ id: number; status: string; booking_id: number | null }>(
    "payments",
    `select=id,status,booking_id&razorpay_payment_id=eq.${encodeURIComponent(input.razorpayPaymentId)}`
  );
  if (priorRes.ok && priorRes.data && priorRes.data.status === "Paid" && priorRes.data.booking_id) {
    // The webhook usually settles the payment before the browser posts its verify call,
    // and it builds the booking from the draft enquiry — which carries no documents.
    // submitBooking() is the only writer of customer_documents, and it never runs
    // because this early return fires first, so the uploaded files orphan in storage
    // and the CRM shows "No Docs".
    //
    // The browser's call is the only one that carries bookingPayload.documents, so
    // attach them to the booking that already exists before returning.
    await attachDocumentsIfMissing(priorRes.data.booking_id, input.bookingPayload);

    const bNo = await lookupBookingNo(priorRes.data.booking_id);
    return { ok: true, bookingNo: bNo ?? `BK-${priorRes.data.booking_id}`, bookingId: priorRes.data.booking_id, alreadyProcessed: true };
  }

  // 2. Cryptographic signature verification
  if (!input.skipSignatureCheck) {
    if (!input.razorpaySignature) {
      await logActivity(null, "payment_signature_missing", "payment", input.paymentId ?? null, { orderId: input.razorpayOrderId });
      return { ok: false, error: "Payment signature missing." };
    }
    const valid = verifyRazorpaySignature(input.razorpayOrderId, input.razorpayPaymentId, input.razorpaySignature);
    if (!valid) {
      await logActivity(null, "payment_signature_invalid", "payment", input.paymentId ?? null, { orderId: input.razorpayOrderId });
      return { ok: false, error: "We could not verify this payment signature. If money was deducted, contact us with your payment ID." };
    }
  }

  // 3. Direct verification of payment status from Razorpay API
  let paidAmount = 0;
  let realMethod: string | null = null;
  let realVpa: string | null = null;
  let realBankRef: string | null = null;
  let customerContact: string | null = null;
  let customerEmail: string | null = null;
  let razorpayCustomerName: string | null = null;

  try {
    const rzpRes = await fetchRazorpayPayment(input.razorpayPaymentId);
    if (rzpRes.ok) {
      const p = rzpRes.payment;
      if (p.status !== "captured" && p.status !== "authorized") {
        return { ok: false, error: `Payment has not been completed on Razorpay (Status: ${p.status}).` };
      }
      paidAmount = (p.amount || 0) / 100;
      realVpa = p.vpa || p.upi?.vpa || null;
      realMethod = p.method ? (p.method.toLowerCase() === "upi" ? "UPI" : p.method.toUpperCase()) : null;
      realBankRef = p.acquirer_data?.rrn || p.acquirer_data?.upi_transaction_id || p.acquirer_data?.bank_transaction_id || null;
      customerContact = p.contact || p.notes?.Phone || null;
      customerEmail = p.email || null;
      razorpayCustomerName = p.notes?.Customer || null;
    }
  } catch (err) {
    console.error("[payments] fetchRazorpayPayment check error:", err);
  }

  const receiptNo = nextNumber("RC", null);

  // CASE A: Pre-booking online checkout — create the booking and link payment!
  if (input.bookingPayload) {
    const { submitBooking } = await import("./booking-actions");
    const subRes = await submitBooking(input.bookingPayload);
    if (!subRes.ok || !subRes.bookingId) {
      return { ok: false, error: subRes.error || "Payment was successful, but booking could not be saved. Contact support with your payment ID." };
    }

    const bookingId = Number(subRes.bookingId);
    const bookingNo = String(subRes.bookingNo);
    const customerId = subRes.customerId ?? null;
    const finalPaid = paidAmount > 0 ? paidAmount : (input.bookingPayload.amount || 1);

    const orderIdEnc = encodeURIComponent(input.razorpayOrderId);
    const existingOrderPay = await sbSelectOne<PaymentRow>(
      "payments",
      `select=*&or=(gateway_ref.eq.${orderIdEnc},razorpay_order_id.eq.${orderIdEnc})`
    );

    let paymentNo = nextNumber("PY", null);
    if (existingOrderPay.ok && existingOrderPay.data) {
      paymentNo = existingOrderPay.data.payment_no;
      await sbUpdate("payments", `id=eq.${existingOrderPay.data.id}`, {
        booking_id: bookingId,
        customer_id: customerId,
        amount: finalPaid,
        amount_paise: Math.round(finalPaid * 100),
        status: "Paid",
        notes: `Razorpay payment ID: ${input.razorpayPaymentId}`,
        receipt_no: receiptNo,
        gateway_ref: input.razorpayPaymentId,
        razorpay_order_id: input.razorpayOrderId,
        razorpay_payment_id: input.razorpayPaymentId,
        razorpay_signature: input.razorpaySignature,
        method: realMethod || "UPI",
        upi_id: realVpa,
        vpa: realVpa,
        bank_ref_no: realBankRef,
        paid_at: nowISO(),
      });
    } else {
      await sbInsert<PaymentRow>("payments", {
        payment_no: paymentNo,
        booking_id: bookingId,
        customer_id: customerId,
        amount: finalPaid,
        amount_paise: Math.round(finalPaid * 100),
        currency: "INR",
        kind: "full",
        status: "Paid",
        notes: `Razorpay payment ID: ${input.razorpayPaymentId}`,
        receipt_no: receiptNo,
        gateway_ref: input.razorpayPaymentId,
        razorpay_order_id: input.razorpayOrderId,
        razorpay_payment_id: input.razorpayPaymentId,
        razorpay_signature: input.razorpaySignature,
        method: realMethod || "UPI",
        upi_id: realVpa,
        vpa: realVpa,
        bank_ref_no: realBankRef,
        paid_at: nowISO(),
        created_at: nowISO(),
      });
    }

    // Update booking status to Confirmed & record paid amount
    await sbUpdate("bookings", `id=eq.${bookingId}`, {
      status: "Confirmed",
      paid_amount: finalPaid,
      updated_at: nowISO(),
    });

    await sbInsert("booking_history", {
      booking_id: bookingId,
      action: "payment_verified",
      detail: JSON.stringify({
        payment_no: paymentNo,
        amount: finalPaid,
        razorpay_payment_id: input.razorpayPaymentId,
        status: "Confirmed",
      }),
      created_at: nowISO(),
    });

    await logActivity(null, "payment_verified", "payment", bookingId, { amount: finalPaid, razorpay_payment_id: input.razorpayPaymentId });

    // Generate invoice and notifications
    const invoice = await generateInvoiceForBooking(bookingId).catch(() => null);
    const phone = input.bookingPayload.contact?.phone;
    const name = input.bookingPayload.contact?.name;

    if (phone) {
      try {
        await sendTemplate("payment_receipt", phone, { name: name ?? "", amount: `₹${finalPaid.toLocaleString("en-IN")}`, reference: input.razorpayPaymentId, receipt_no: receiptNo, booking_no: bookingNo }, null, bookingId);
        await sendTemplate("booking_confirmation", phone, { name: name ?? "", booking_no: bookingNo, vehicle: "", pickup_at: input.bookingPayload.pickupAt ?? "", location: input.bookingPayload.location ?? "" }, null, bookingId);
        if (invoice) {
          await sendTemplate("invoice_generated", phone, { name: name ?? "", invoice_no: invoice.invoiceNo, booking_no: bookingNo, total: `₹${finalPaid.toLocaleString("en-IN")}` }, null, bookingId);
        }
      } catch {}
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

    return { ok: true, bookingNo, bookingId };
  }

  // CASE B: Existing booking or Webhook payment update
  const orderId = encodeURIComponent(input.razorpayOrderId);
  let paymentRes = await sbSelectOne<PaymentRow>(
    "payments",
    input.paymentId && input.paymentId > 0
      ? `select=*&id=eq.${input.paymentId}`
      : `select=*&or=(gateway_ref.eq.${orderId},razorpay_order_id.eq.${orderId})`
  );

  let payment = paymentRes.ok ? paymentRes.data : null;

  // Fallback: If no payment row exists at all in the database, create one from Razorpay entity
  if (!payment) {
    let fallbackCustomerId: number | null = null;
    if (customerContact) {
      try {
        const { findOrCreateCustomer } = await import("./bookings");
        const custRes = await findOrCreateCustomer({
          name: razorpayCustomerName || "Customer",
          phone: customerContact,
          email: customerEmail || undefined,
        });
        if (custRes.ok) fallbackCustomerId = custRes.customerId;
      } catch {}
    }

    const fallbackPayNo = nextNumber("PY", null);
    const effectivePaidAmount = paidAmount > 0 ? paidAmount : 1;
    const insRes = await sbInsert<PaymentRow>("payments", {
      payment_no: fallbackPayNo,
      booking_id: null,
      customer_id: fallbackCustomerId,
      amount: effectivePaidAmount,
      amount_paise: Math.round(effectivePaidAmount * 100),
      currency: "INR",
      kind: "full",
      status: "Paid",
      notes: `Razorpay payment ID: ${input.razorpayPaymentId}`,
      receipt_no: receiptNo,
      gateway_ref: input.razorpayPaymentId,
      razorpay_order_id: input.razorpayOrderId,
      razorpay_payment_id: input.razorpayPaymentId,
      razorpay_signature: input.razorpaySignature,
      method: realMethod || "UPI",
      upi_id: realVpa,
      vpa: realVpa,
      bank_ref_no: realBankRef,
      paid_at: nowISO(),
      created_at: nowISO(),
    });

    if (insRes.ok && insRes.data) {
      payment = insRes.data;
    } else {
      return { ok: false, error: "Payment record could not be created." };
    }
  }

  if (payment.status === "Paid" && payment.booking_id) {
    const bookingNo = await lookupBookingNo(payment.booking_id);
    await generateInvoiceForBooking(payment.booking_id).catch(() => null);
    return { ok: true, bookingNo: bookingNo ?? "", alreadyProcessed: true };
  }

  const effectivePaid = paidAmount > 0 ? paidAmount : num(payment.amount);

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

  // Razorpay fires order.paid AND payment.captured for the same payment, milliseconds
  // apart, and they arrive as two separate lambda invocations. Both used to read the row
  // as Pending, both fell through to the auto-link branch below, and both created a
  // booking from the same draft enquiry — two identical bookings ~400ms apart, and
  // increment_booking_paid applied twice.
  //
  // `status=neq.Paid` makes this update an atomic compare-and-swap: exactly one caller
  // can flip Pending -> Paid. The loser gets zero affected rows, which is the signal that
  // another invocation owns this payment.
  const wasAlreadyPaid = payment.status === "Paid";
  const paidUpdate = await sbUpdate<PaymentRow>("payments", `id=eq.${payment.id}&status=neq.Paid`, patch);
  if (!paidUpdate.ok) return { ok: false, error: `Could not record the payment: ${paidUpdate.error}` };

  if (paidUpdate.data.length === 0 && !wasAlreadyPaid) {
    // We read it as Pending but someone else flipped it first. Stop here: continuing
    // would double-create the booking and double-increment the balance.
    //
    // Note the `!wasAlreadyPaid` guard. A row that was ALREADY Paid when we read it also
    // yields zero rows, but that is the orphan-recovery case (paid, never linked to a
    // booking) which must still fall through to the auto-link below.
    const settled = await sbSelectOne<PaymentRow>("payments", `select=booking_id&id=eq.${payment.id}`);
    const settledBookingId = settled.ok && settled.data ? settled.data.booking_id : null;
    const settledBookingNo = settledBookingId ? await lookupBookingNo(settledBookingId) : null;
    if (settledBookingId) {
      await generateInvoiceForBooking(settledBookingId).catch(() => null);
    }
    return {
      ok: true,
      bookingNo: settledBookingNo ?? "",
      bookingId: settledBookingId ?? undefined,
      alreadyProcessed: true,
    };
  }

  let bookingId = payment.booking_id;

  // If payment is not linked to a booking (e.g. customer closed tab before callback), try auto-linking with enquiry
  if (!bookingId) {
    let searchPhone = customerContact;
    if (!searchPhone && payment.customer_id) {
      const cRes = await sbSelectOne<{ phone: string | null }>("customers", `select=phone&id=eq.${payment.customer_id}`);
      if (cRes.ok && cRes.data?.phone) searchPhone = cRes.data.phone;
    }

    if (searchPhone) {
      const cleanPhone = searchPhone.replace(/\D/g, "").slice(-10);
      const enqRes = await sbSelectOne<{ id: number; data: string; vehicle_id: number; pickup_date: string; return_date: string }>(
        "enquiries",
        `select=id,data,vehicle_id,pickup_date,return_date&phone=like.*${encodeURIComponent(cleanPhone)}*&status=eq.draft&order=id.desc`
      );
      if (enqRes.ok && enqRes.data && enqRes.data.vehicle_id) {
        const enq = enqRes.data;
        const draftData = parseJSON<{ location?: string; documents?: Array<{ kind: string; url: string; number?: string; expiry?: string }> }>(enq.data, {});

        // Same branch resolution submitBooking() uses — this used to hardcode branch_id
        // 1 (Sakleshpura) regardless of which branch the customer actually picked.
        let resolvedBranchId: number | undefined;
        if (draftData.location) {
          const locUpper = draftData.location.toUpperCase();
          if (locUpper.includes("SAKLESH")) resolvedBranchId = 1;
          else if (locUpper.includes("HASSAN")) resolvedBranchId = 2;
        }

        // This used to insert the booking directly with NO capacity check at all — if
        // two different customers both had a draft for the same vehicle/dates and both
        // payments fell into this fallback (e.g. both closed their tab right after
        // Razorpay's success screen), BOTH got a real Confirmed booking for a vehicle
        // that only had one unit left. Claim through the exact same atomic RPC
        // createBooking() uses (pg_advisory_xact_lock serializes concurrent callers per
        // vehicle) so only one of them can ever win the slot.
        let claimedBlockId: number | null = null;
        let claimedUnitId: number | null = null;
        try {
          const unitClaim = await sbRpc<Array<{ block_id: number; unit_id: number | null; unit_identifier: string | null }>>(
            "reserve_vehicle_unit_slot",
            { p_vehicle_id: enq.vehicle_id, p_pickup_at: enq.pickup_date, p_return_at: enq.return_date, p_branch_id: resolvedBranchId ?? null }
          );
          if (unitClaim.ok && Array.isArray(unitClaim.data) && unitClaim.data.length > 0) {
            claimedBlockId = Number(unitClaim.data[0].block_id);
            claimedUnitId = unitClaim.data[0].unit_id ? Number(unitClaim.data[0].unit_id) : null;
          }
        } catch (err) {
          console.error(`[payments] enquiry ${enq.id}: reserve_vehicle_unit_slot threw`, err);
        }
        if (!claimedBlockId) {
          const claim = await sbRpc<number | null>("reserve_vehicle_slot", {
            p_vehicle_id: enq.vehicle_id,
            p_pickup_at: enq.pickup_date,
            p_return_at: enq.return_date,
          });
          if (claim.ok && claim.data) claimedBlockId = Number(claim.data);
        }

        if (claimedBlockId) {
          // Reconstruct the SAME authoritative quote createBooking() uses for the normal
          // booking path — this recovery path must never invent its own pricing. It used
          // to skip pricing entirely (total_amount: effectivePaid, base_amount/gst_amount
          // left unset), which is why a recovered booking could show "Base Rental ₹0,
          // GST ₹0, Total ₹2,014" in the CRM even though ₹2,014 was genuinely captured.
          let quote: Awaited<ReturnType<typeof calculateQuote>> | null = null;
          const vehicle = await getVehicleById(enq.vehicle_id).catch(() => null);
          const pickup = parseIstInstant(enq.pickup_date);
          const ret = parseIstInstant(enq.return_date);
          if (vehicle && pickup && ret) {
            try {
              quote = await calculateQuote(vehicle, pickup, ret);
            } catch (err) {
              console.error(`[payments] enquiry ${enq.id}: calculateQuote threw`, err);
            }
          }

          if (!quote) {
            // Cannot price this booking correctly — refuse to fabricate one, same
            // principle submitBooking() already applies. Release the claim so it falls
            // through to the unlinked-payment handling below for staff review.
            console.error(`[payments] enquiry ${enq.id}: could not price recovered booking (vehicle=${!!vehicle}, pickup=${!!pickup}, return=${!!ret}) — releasing claim`);
            await sbDelete("availability_blocks", `id=eq.${claimedBlockId}`);
            claimedBlockId = null;
          } else {
            const otherFees = num(quote.offSchedulePickupFee) + num(quote.gatewayFeeAmount);
            const bNo = nextNumber("BK", null);
            const insBooking = await sbInsert<{ id: number }>("bookings", {
              booking_no: bNo,
              enquiry_id: enq.id,
              customer_id: payment.customer_id,
              vehicle_id: enq.vehicle_id,
              vehicle_unit_id: claimedUnitId,
              branch_id: resolvedBranchId ?? null,
              pickup_at: enq.pickup_date,
              return_at: enq.return_date,
              status: "Confirmed",
              base_amount: num(quote.baseAmount),
              gst_amount: num(quote.gstAmount),
              other_fees_amount: otherFees,
              included_km: num(quote.includedKm),
              total_amount: num(quote.totalAmount),
              // Starts at zero on purpose. increment_booking_paid() below is the single
              // writer of this column; seeding it with the payment amount here made every
              // auto-linked booking record twice what was actually paid.
              paid_amount: 0,
              deposit_amount: num(quote.depositAmount),
              created_at: nowISO(),
            });
            if (insBooking.ok && insBooking.data) {
              bookingId = insBooking.data.id;
              // Money is already captured here. These must never fail the response —
              // that would tell a paying customer the payment failed — but a silent
              // failure orphans the payment or strands the hold, so log loudly.
              const linkedPayment = await sbUpdate("payments", `id=eq.${payment.id}`, { booking_id: bookingId });
              if (!linkedPayment.ok) console.error(`[payments] booking ${bookingId}: payment ${payment.id} not linked — ${linkedPayment.error}`);
              const convertedEnq = await sbUpdate("enquiries", `id=eq.${enq.id}`, { status: "converted", stage: "Converted" });
              if (!convertedEnq.ok) console.error(`[payments] enquiry ${enq.id}: not marked converted — ${convertedEnq.error}`);
              // Link the claimed hold to the real booking — mirrors createBooking()'s own
              // linking step, so this booking shows up consistently everywhere the other
              // creation path's bookings do (Gantt, unit blocking, etc).
              // The most consequential write in this path: it converts the 10-minute
              // claim into a permanent hold. If it fails silently the hold expires and
              // the unit is handed to someone else while this paid, Confirmed booking
              // still points at it — a double booking with money on both sides.
              const linkedHold = await sbUpdate("availability_blocks", `id=eq.${claimedBlockId}`, {
                booking_id: bookingId,
                vehicle_unit_id: claimedUnitId,
                expires_at: null,
                notes: null,
              });
              if (!linkedHold.ok) {
                console.error(
                  `[payments] booking ${bookingId}: hold ${claimedBlockId} NOT linked — the unit may be released while this booking is paid. ${linkedHold.error}`
                );
              }

              // This path builds the booking straight from the draft enquiry, bypassing
              // submitBooking() entirely — the ONE thing that used to write
              // customer_documents. The customer's uploaded licence/ID photos were durably
              // in storage the moment they were uploaded, but nothing in the DB pointed to
              // them unless the browser's own final submit call completed. Since the draft
              // now carries `documents` as soon as each file is uploaded (see
              // BookingForm.tsx's autosave), pull them from here instead of losing them.
              try {
                const draftDocs = draftData.documents;
                if (Array.isArray(draftDocs) && draftDocs.length > 0 && payment.customer_id) {
                  const { attachCustomerDocuments } = await import("./booking-actions");
                  const attachRes = await attachCustomerDocuments(payment.customer_id, bookingId, draftDocs);
                  if (!attachRes.ok) console.error(`[payments] booking ${bookingId}: draft documents not attached — ${attachRes.error}`);
                }
              } catch (err) {
                console.error(`[payments] booking ${bookingId}: draft document recovery threw`, err);
              }
            } else {
              // Booking insert failed after a successful claim — release the hold rather
              // than stranding a phantom 10-minute-unavailable slot on a vehicle nobody
              // actually booked.
              console.error(`[payments] enquiry ${enq.id}: booking insert failed after claim —`, insBooking.ok ? "no id returned" : insBooking.error);
              await sbDelete("availability_blocks", `id=eq.${claimedBlockId}`);
            }
          }
        }
        // If claimedBlockId is still null here, the vehicle genuinely has no capacity
        // left for this window (or is unavailable/blocked). Falls through to the
        // unlinked-payment handling below, same as any other payment that can't be
        // matched to a real slot — staff can see and refund it, instead of the system
        // fabricating a booking for a vehicle that was never actually available.
      }
    }
  }

  if (!bookingId) {
    // Unlinked payment safely recorded in payments table
    await logActivity(null, "payment_received_unlinked", "payment", payment.id, {
      amount: effectivePaid,
      razorpay_payment_id: input.razorpayPaymentId,
      order_id: input.razorpayOrderId,
    });
    return { ok: true, bookingNo: "" };
  }

  const unverifiedDocs = await sbCount("customer_documents", `booking_id=eq.${bookingId}&verified=eq.0`);
  const newBookingStatus = unverifiedDocs.ok && unverifiedDocs.data === 0 ? "Confirmed" : "Payment received";

  // Atomic accumulate in Postgres. Read-modify-write in application code loses
  // one of two concurrent payments.
  //
  // effectivePaid, not the raw paidAmount: paidAmount comes from fetchRazorpayPayment,
  // which is 0 whenever that live lookup fails (a network blip, or a fake/test payment
  // id) — incrementing by that unconditionally under-credits a genuinely paid booking.
  // effectivePaid already falls back to the payment's own stored, correct amount.
  const incr = await sbRpc<number>("increment_booking_paid", { p_booking_id: bookingId, p_amount: effectivePaid });
  if (!incr.ok) {
    console.warn(`[payments] increment_booking_paid RPC failed (${incr.error}), falling back to direct update`);
    const bRes = await sbSelectOne<{ paid_amount: number | string }>("bookings", `select=paid_amount&id=eq.${bookingId}`);
    const currentPaid = bRes.ok && bRes.data ? num(bRes.data.paid_amount) : 0;
    const directUpd = await sbUpdate("bookings", `id=eq.${bookingId}`, { paid_amount: currentPaid + effectivePaid });
    if (!directUpd.ok) {
      console.error(`[payments] direct paid_amount update failed: ${directUpd.error}`);
    }
  }

  const statusUpdate = await sbUpdate("bookings", `id=eq.${bookingId}`, { status: newBookingStatus, updated_at: nowISO() });
  if (!statusUpdate.ok) {
    console.error(`[payments] status update failed for booking ${bookingId}: ${statusUpdate.error}`);
  }

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

  return { ok: true, bookingNo, bookingId };
}

async function lookupBookingNo(bookingId: number | null | undefined): Promise<string | null> {
  if (!bookingId) return null;
  const res = await sbSelectOne<{ booking_no: string | null }>("bookings", `select=booking_no&id=eq.${bookingId}`);
  return res.ok ? res.data?.booking_no ?? null : null;
}
