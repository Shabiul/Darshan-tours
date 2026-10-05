import { NextRequest, NextResponse, after } from "next/server";
import { verifyRazorpayWebhookSignature, fetchRazorpayOrderPayments } from "@/lib/razorpay";
import { verifyBookingPayment, recordFailedPaymentAttempt } from "@/lib/payment-actions";
import { logActivity } from "@/lib/activity";
import { sbSelectOne, sbInsert, sbUpdate } from "@/lib/supabase-rest";

/**
 * Server-to-server webhook handler for Razorpay asynchronous notifications
 * (e.g. payment.captured, order.paid, payment.failed, refund.processed).
 *
 * Everything here reads and writes Supabase directly. The previous version kept
 * the idempotency ledger in a per-lambda SQLite file that was empty on every cold
 * start (and degraded to a mock that reported "no such event"), so Razorpay's
 * retries were fully reprocessed and payments could be applied twice.
 */

/**
 * Records the event, using the UNIQUE index on payment_events.event_id as the
 * idempotency mechanism. A check-then-insert races against a concurrent retry;
 * letting Postgres reject the second insert does not.
 */
async function recordPaymentEvent(input: {
  eventId: string | null;
  eventType: string;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  payload: string;
  signatureVerified: boolean;
  transactionId: number | null;
}): Promise<{ eventDbId: number | null; duplicate: boolean; error?: string }> {
  const row = {
    transaction_id: input.transactionId,
    event_id: input.eventId,
    event_type: input.eventType,
    razorpay_order_id: input.razorpayOrderId,
    razorpay_payment_id: input.razorpayPaymentId,
    payload: input.payload,
    signature_verified: input.signatureVerified ? 1 : 0,
    processed: 0,
    created_at: new Date().toISOString(),
  };

  const res = await sbInsert<{ id: number }>("payment_events", row);
  if (res.ok) return { eventDbId: res.data.id, duplicate: false };

  // 23505 = unique_violation. PostgREST reports it with status 409.
  const isDuplicate =
    input.eventId != null && (res.status === 409 || /duplicate key|23505|already exists/i.test(res.error));

  if (isDuplicate) {
    const existing = await sbSelectOne<{ id: number; processed: number | boolean }>(
      "payment_events",
      `select=id,processed&event_id=eq.${encodeURIComponent(input.eventId!)}`
    );
    if (!existing.ok || !existing.data) return { eventDbId: null, duplicate: true };
    // Only skip if the earlier attempt actually completed. A previous run that
    // failed mid-way must be retryable, otherwise a transient error would strand
    // the payment forever behind its own idempotency record.
    const done = existing.data.processed === true || Number(existing.data.processed) === 1;
    return { eventDbId: existing.data.id, duplicate: done };
  }

  return { eventDbId: null, duplicate: false, error: res.error };
}

async function markPaymentEventProcessed(eventDbId: number | null, processingError: string | null): Promise<void> {
  if (!eventDbId) return;
  await sbUpdate("payment_events", `id=eq.${eventDbId}`, {
    processed: 1,
    processing_error: processingError,
    processed_at: new Date().toISOString(),
  });
}

/** Finds the payment row that a Razorpay order id belongs to. */
async function findPaymentByOrder(orderId: string): Promise<{ id: number } | null> {
  const enc = encodeURIComponent(orderId);
  const res = await sbSelectOne<{ id: number }>(
    "payments",
    `select=id&or=(gateway_ref.eq.${enc},razorpay_order_id.eq.${enc})`
  );
  return res.ok ? res.data : null;
}

/**
 * after() runs within the route's max duration, so the budget has to cover the whole
 * booking/invoice/WhatsApp chain rather than just the acknowledgement.
 */
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-razorpay-signature");
  if (!signature) {
    return NextResponse.json({ ok: false, error: "Missing X-Razorpay-Signature header." }, { status: 400 });
  }

  const rawBody = await req.text();
  const valid = verifyRazorpayWebhookSignature(rawBody, signature);
  if (!valid) {
    return NextResponse.json({ ok: false, error: "Invalid webhook signature." }, { status: 400 });
  }

  let event: { event?: string; payload?: Record<string, any>; event_id?: string };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON payload." }, { status: 400 });
  }

  const eventType = event.event ?? "unknown";
  const payload = event.payload ?? {};
  // Razorpay sends the event id in the x-razorpay-event-id HEADER, not in the JSON body.
  // Reading it from the body yielded null on every request, so the payment_events
  // dedupe check never fired and every webhook retry was fully reprocessed.
  const eventId =
    req.headers.get("x-razorpay-event-id") ?? (event as any).event_id ?? (event as any).id ?? null;

  const entity = payload?.payment?.entity ?? payload?.order?.entity ?? payload?.refund?.entity;
  const orderId = entity?.order_id ?? entity?.id ?? null;
  const paymentId = entity?.id ?? entity?.payment_id ?? null;

  let transactionId: number | null = null;
  if (orderId) {
    const paymentRow = await findPaymentByOrder(orderId);
    if (paymentRow) transactionId = paymentRow.id;
  }

  const { eventDbId, duplicate, error: recordError } = await recordPaymentEvent({
    eventId,
    eventType,
    razorpayOrderId: orderId,
    razorpayPaymentId: paymentId,
    payload: rawBody,
    signatureVerified: true,
    transactionId,
  });

  if (duplicate) {
    return NextResponse.json({ status: "ok", message: "Duplicate event skipped." });
  }

  // If the audit record could not be written we have no idempotency guarantee.
  // Fail loudly so Razorpay retries rather than silently processing unprotected.
  if (recordError) {
    console.error("[razorpay-webhook] could not record event", recordError);
    return NextResponse.json({ ok: false, error: "Could not record webhook event." }, { status: 500 });
  }

  // Razorpay waits 5 seconds for a response and retries on timeout. The work below —
  // a Razorpay API fetch, submitBooking, invoice generation, three WhatsApp sends and a
  // Redis invalidation — does not fit in 5 seconds. Doing it before responding meant
  // Razorpay timed out and retried while the first attempt was still running; because
  // `duplicate` only returns true once processed=1 has been committed, the retry sailed
  // past the idempotency gate and processed the same payment twice.
  //
  // The event row is already committed at this point, which is the real idempotency
  // gate, so acknowledge now and finish the work in after(). Razorpay stops retrying
  // once it has a 2xx, so a failure here no longer earns a redelivery — the /api/sync
  // sweep is the recovery path, and it reports anything left unreconciled as an orphan.
  after(async () => {
    let processingError: string | null = null;
    try {
      processingError = await processEvent(eventType, payload, signature);
    } catch (err) {
      processingError = err instanceof Error ? err.message : String(err);
      console.error("[razorpay-webhook] processing threw", err);
    }
    await markPaymentEventProcessed(eventDbId, processingError);
    if (processingError) {
      console.error(`[razorpay-webhook] ${eventType} failed to process:`, processingError);
    }
  });

  return NextResponse.json({ status: "ok" });
}

/** Applies a verified event. Returns an error string, or null on success. */
async function processEvent(
  eventType: string,
  payload: Record<string, any>,
  signature: string
): Promise<string | null> {
  let processingError: string | null = null;

  if (eventType === "payment.captured" || eventType === "order.paid") {
    const paymentEntity = payload?.payment?.entity;
    const orderEntity = payload?.order?.entity;
    const capturedOrderId = paymentEntity?.order_id ?? orderEntity?.id ?? null;
    let capturedPaymentId = paymentEntity?.id ?? orderEntity?.payment_id ?? null;
    const receipt = paymentEntity?.receipt ?? orderEntity?.receipt ?? null;

    if (!capturedPaymentId && capturedOrderId) {
      const orderPayRes = await fetchRazorpayOrderPayments(capturedOrderId);
      if (orderPayRes.ok && orderPayRes.payments.length > 0) {
        const successful = orderPayRes.payments.find((p) => p.status === "captured" || p.status === "authorized") ?? orderPayRes.payments[0];
        capturedPaymentId = successful?.id;
      }
    }

    if (capturedPaymentId) {
      let paymentRow: { id: number } | null = null;
      if (capturedOrderId) {
        paymentRow = await findPaymentByOrder(capturedOrderId);
      }
      if (!paymentRow) {
        const byPayment = await sbSelectOne<{ id: number }>(
          "payments",
          `select=id&razorpay_payment_id=eq.${encodeURIComponent(capturedPaymentId)}`
        );
        if (byPayment.ok && byPayment.data) paymentRow = byPayment.data;
      }
      if (!paymentRow && receipt) {
        const byReceipt = await sbSelectOne<{ id: number }>(
          "payments",
          `select=id&payment_no=eq.${encodeURIComponent(receipt)}`
        );
        if (byReceipt.ok && byReceipt.data) paymentRow = byReceipt.data;
      }

      const result = await verifyBookingPayment({
        paymentId: paymentRow?.id,
        razorpayOrderId: capturedOrderId || "",
        razorpayPaymentId: capturedPaymentId,
        razorpaySignature: signature,
        skipSignatureCheck: true,
      });
      if (!result.ok) {
        processingError = result.error;
      } else if (result.bookingId) {
        const { generateInvoiceForBooking } = await import("@/lib/invoices");
        await generateInvoiceForBooking(result.bookingId).catch(() => null);
      }
    }
  } else if (eventType === "payment.failed") {
    const paymentEntity = payload?.payment?.entity;
    if (paymentEntity?.order_id) {
      const paymentRow = await findPaymentByOrder(paymentEntity.order_id);
      if (paymentRow) {
        // Routes through the same attempt-counter + release logic the frontend's
        // dismissal path uses — this is what actually decrements toward the 3-attempt
        // limit and releases the reservation once it's exhausted, instead of just
        // flipping the row to Failed with no further consequence.
        const result = await recordFailedPaymentAttempt(paymentRow.id);
        if (!result.ok) processingError = result.error;
      }
      await logActivity(null, "payment_failed_webhook", "payment", null, {
        orderId: paymentEntity.order_id,
        reason: paymentEntity.error_description ?? "Payment failed",
      });
    }
  } else if (eventType === "refund.processed") {
    const refundEntity = payload?.refund?.entity;
    if (refundEntity?.id && refundEntity?.payment_id) {
      const encRefund = encodeURIComponent(refundEntity.id);
      const encPayment = encodeURIComponent(`*${refundEntity.payment_id}*`);
      const upd = await sbUpdate(
        "refunds",
        `status=in.(Requested,Approved,Processing)&or=(transaction_ref.eq.${encRefund},admin_notes.like.${encPayment})`,
        { status: "Completed", completed_at: new Date().toISOString(), transaction_ref: refundEntity.id }
      );
      if (!upd.ok) processingError = upd.error;
      await logActivity(null, "refund_processed_webhook", "refund", null, {
        refundId: refundEntity.id,
        amount: Number(refundEntity.amount) / 100,
      });
    }
  }

  return processingError;
}
