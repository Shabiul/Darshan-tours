import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { sbSelect, sbSelectOne, sbInsert, sbUpdate, sbRpc } from "@/lib/supabase-rest";
import { razorpayConfigured } from "@/lib/razorpay";
import { requireGatewayKey } from "@/lib/gateway-auth";
import { epochSecondsToUtcIso, nowUtcIso } from "@/lib/time";
import { setSetting } from "@/lib/settings";

/**
 * Razorpay reconciliation sweep — the safety net behind the webhook.
 *
 * A payment captured at Razorpay whose webhook never arrived (or failed) is picked up
 * here and applied to the booking.
 *
 * The previous version matched on a `Booking No` note that no order has ever carried:
 * pre-booking checkout has no booking number yet (the booking is only created once
 * payment verifies), and the notes it does write are Customer/Phone/Base Rental/GST/
 * Deposit/Paid Online Now. Every payment therefore hit `if (!bookingNo) continue` and
 * the sweep reconciled nothing in its entire lifetime.
 *
 * Matching now uses identifiers that actually exist on the row, in descending order of
 * reliability, and a payment with no local row at all is reported as an orphan rather
 * than silently skipped — an orphan means money was captured with no booking behind it
 * and needs a human.
 */

type PaymentRow = {
  id: number;
  booking_id: number | null;
  status: string;
  payment_no: string;
};

/**
 * Resolves the local payments row for a Razorpay payment. Razorpay's `receipt` is set
 * to our payment_no at order creation, which is what makes the third lookup possible
 * for orders created through the web app's direct fallback path.
 */
async function findLocalPayment(item: {
  id: string;
  order_id?: string | null;
  receipt?: string | null;
}): Promise<PaymentRow | null> {
  const byPayment = await sbSelectOne<PaymentRow>(
    "payments",
    `select=id,booking_id,status,payment_no&razorpay_payment_id=eq.${encodeURIComponent(item.id)}`
  );
  if (byPayment.ok && byPayment.data) return byPayment.data;

  if (item.order_id) {
    const enc = encodeURIComponent(item.order_id);
    const byOrder = await sbSelectOne<PaymentRow>(
      "payments",
      `select=id,booking_id,status,payment_no&or=(razorpay_order_id.eq.${enc},gateway_ref.eq.${enc})`
    );
    if (byOrder.ok && byOrder.data) return byOrder.data;
  }

  if (item.receipt) {
    const byReceipt = await sbSelectOne<PaymentRow>(
      "payments",
      `select=id,booking_id,status,payment_no&payment_no=eq.${encodeURIComponent(item.receipt)}`
    );
    if (byReceipt.ok && byReceipt.data) return byReceipt.data;
  }

  return null;
}

/**
 * Brings a booking's stored paid_amount back in line with the payments actually
 * recorded against it, and reports whether it had drifted.
 *
 * Summed from the Paid rows rather than incremented, so re-running the sweep cannot
 * double-count and a booking settled over several payments still totals correctly.
 * Drift here is not cosmetic: a booking reading "Confirmed — ₹0 paid" against a
 * non-zero total tells counter staff to collect money the customer has already paid.
 */
async function reconcileBookingPaidAmount(
  bookingId: number
): Promise<{ changed: boolean; paidTotal: number | null }> {
  const paidRows = await sbSelect<{ amount: number | string }>(
    "payments",
    `select=amount&booking_id=eq.${bookingId}&status=eq.Paid`
  );
  if (!paidRows.ok) return { changed: false, paidTotal: null };
  const paidTotal = paidRows.data.reduce((sum, r) => sum + Number(r.amount || 0), 0);

  const booking = await sbSelectOne<{ paid_amount: number | string | null }>(
    "bookings",
    `select=paid_amount&id=eq.${bookingId}`
  );
  if (!booking.ok || !booking.data) return { changed: false, paidTotal };
  if (Number(booking.data.paid_amount || 0) === paidTotal) return { changed: false, paidTotal };

  const upd = await sbUpdate("bookings", `id=eq.${bookingId}`, {
    paid_amount: paidTotal,
    updated_at: nowUtcIso(),
  });
  return { changed: upd.ok, paidTotal };
}

/**
 * Vercel Cron cannot send custom headers — it authenticates with
 * `Authorization: Bearer $CRON_SECRET`. Accept that alongside the gateway key so the
 * sweep can be scheduled without widening the gateway secret's blast radius.
 */
function authorizeSync(req: NextRequest): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (cronSecret && auth?.startsWith("Bearer ")) {
    const given = Buffer.from(auth.slice(7));
    const expected = Buffer.from(cronSecret);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return null;
  }
  return requireGatewayKey(req);
}

/** A webhook is only as good as its last successful delivery. */
const STALE_DELIVERY_HOURS = 24;

/**
 * A broken webhook is the failure that hides other failures: payments quietly stop
 * being recorded and nothing says so. Reporting it on every sweep makes it visible the
 * same day instead of the next time someone audits Razorpay by hand.
 *
 * Two distinct failures are checked, because the second one caused a real 8-day outage
 * that the first would not have caught:
 *
 *   1. Razorpay has switched the endpoint off (it does this after repeated delivery
 *      failures). Visible as active === false.
 *   2. The endpoint is active but nothing is arriving — a secret that no longer matches
 *      RAZORPAY_WEBHOOK_SECRET rejects every delivery with a 400, and Razorpay simply
 *      stops trying. The dashboard still shows a healthy, enabled webhook. The only
 *      honest signal is comparing money captured against events actually received.
 */
async function webhookHealth(authHeader: string, latestCapturedAtIso: string | null) {
  try {
    const res = await fetch("https://api.razorpay.com/v1/webhooks", {
      headers: { Authorization: authHeader },
      cache: "no-store",
    });
    if (!res.ok) return { checked: false as const, reason: `Razorpay returned ${res.status}` };
    const data = await res.json();
    const hooks = Array.isArray(data?.items) ? data.items : [];
    const inactive = hooks.filter((h: any) => h.active === false).map((h: any) => h.url);

    // Newest event we have actually received and verified.
    const lastEvent = await sbSelectOne<{ created_at: string }>(
      "payment_events",
      "select=created_at&signature_verified=eq.1&order=created_at.desc&limit=1"
    );
    const lastEventAt = lastEvent.ok && lastEvent.data ? lastEvent.data.created_at : null;

    // Stalled = money came in well after the last event we received. Comparing against
    // a captured payment rather than wall-clock avoids crying wolf on a quiet day with
    // no bookings, when silence is the correct state.
    const gapHours =
      latestCapturedAtIso && lastEventAt
        ? (Date.parse(latestCapturedAtIso) - Date.parse(lastEventAt)) / 3_600_000
        : null;
    const deliveriesStalled =
      latestCapturedAtIso != null && (lastEventAt == null || (gapHours ?? 0) > STALE_DELIVERY_HOURS);

    return {
      checked: true as const,
      total: hooks.length,
      active: hooks.length - inactive.length,
      inactive,
      lastEventAt,
      lastCapturedAt: latestCapturedAtIso,
      deliveriesStalled,
      healthy: hooks.length > 0 && inactive.length === 0 && !deliveriesStalled,
    };
  } catch (err: any) {
    return { checked: false as const, reason: err?.message ?? "unreachable" };
  }
}

export async function GET(req: NextRequest) {
  const denied = authorizeSync(req);
  if (denied) return denied;

  if (!razorpayConfigured()) {
    return NextResponse.json({ ok: true, skipped: "Razorpay is not configured.", syncedRazorpayCount: 0 });
  }

  const keyId = process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return NextResponse.json({ ok: false, error: "Razorpay credentials are incomplete." }, { status: 500 });
  }

  // Reservations whose 15-minute window lapsed with no payment. Runs here too so the
  // CRM self-corrects even on a day with no new bookings to trigger the sweep.
  const sweptReservations = await sbRpc<number>("release_expired_reservations", {});
  if (!sweptReservations.ok) console.error(`[sync] expired-reservation sweep failed — ${sweptReservations.error}`);

  let items: any[];
  try {
    const authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const rzpRes = await fetch("https://api.razorpay.com/v1/payments?count=100", {
      headers: { Authorization: authHeader },
      cache: "no-store",
    });
    const rzpData = await rzpRes.json();
    if (!rzpRes.ok) {
      return NextResponse.json(
        { ok: false, error: rzpData?.error?.description || "Razorpay rejected the request." },
        { status: 502 }
      );
    }
    items = Array.isArray(rzpData?.items) ? rzpData.items : [];
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Could not reach Razorpay." }, { status: 502 });
  }

  let syncedRazorpayCount = 0;
  const failures: string[] = [];
  /** Bookings whose stored paid_amount disagreed with their payments and was corrected. */
  const paidAmountRepairs: Array<{ paymentNo: string; bookingId: number; paidTotal: number | null }> = [];
  /** Captured at Razorpay with no local payment row — money in, no booking. */
  const orphans: Array<{
    razorpayPaymentId: string;
    razorpayOrderId: string | null;
    amount: number;
    capturedAt: string;
    contact: string | null;
    customer: string | null;
  }> = [];

  for (const item of items) {
    if (item?.status !== "captured" || !item.id) continue;

    const local = await findLocalPayment(item);

    if (!local) {
      orphans.push({
        razorpayPaymentId: item.id,
        razorpayOrderId: item.order_id ?? null,
        amount: Number(item.amount || 0) / 100,
        capturedAt: epochSecondsToUtcIso(item.created_at),
        contact: item.contact ?? item.notes?.Phone ?? null,
        customer: item.notes?.Customer ?? null,
      });
      continue;
    }

    if (local.status === "Paid") {
      // Already reconciled financially, but a row the webhook marked Paid before it
      // stamped the Razorpay id can only ever be matched by order id. Backfill it so
      // reconciliation stays exact — findLocalPayment tries payment id first.
      const bare = await sbSelectOne<{ id: number }>(
        "payments",
        `select=id&id=eq.${local.id}&razorpay_payment_id=is.null`
      );
      if (bare.ok && bare.data) {
        await sbUpdate("payments", `id=eq.${local.id}&razorpay_payment_id=is.null`, {
          razorpay_payment_id: item.id,
          gateway_ref: item.id,
        });
      }
      // A Paid payment row is no guarantee the booking's total was updated with it —
      // any path that marked the row Paid without touching the booking leaves the two
      // disagreeing. Heal that here rather than only on the transition to Paid.
      if (local.booking_id) {
        const healed = await reconcileBookingPaidAmount(local.booking_id);
        if (healed.changed) {
          paidAmountRepairs.push({ paymentNo: local.payment_no, bookingId: local.booking_id, paidTotal: healed.paidTotal });
        }
      }
      continue;
    }

    // Razorpay's created_at is Unix epoch seconds (UTC). Stored as ISO-8601 UTC so it
    // sorts and compares against every other timestamp in the system; rendering to IST
    // happens at the display boundary, never here.
    const capturedAtIso = epochSecondsToUtcIso(item.created_at);

    const payment = await sbUpdate<{ id: number }>("payments", `id=eq.${local.id}&status=neq.Paid`, {
      status: "Paid",
      razorpay_payment_id: item.id,
      gateway_ref: item.id,
      paid_at: capturedAtIso,
    });
    if (!payment.ok) {
      failures.push(`${local.payment_no}: ${payment.error}`);
      continue;
    }
    if (payment.data.length === 0) continue; // raced with the webhook — it won, fine

    if (local.booking_id) {
      const booking = await sbUpdate("bookings", `id=eq.${local.booking_id}`, {
        status: "Confirmed",
        updated_at: nowUtcIso(),
      });
      if (!booking.ok) {
        failures.push(`${local.payment_no}: ${booking.error}`);
        continue;
      }
      // paid_amount has to move with the status, or the booking reads
      // "Confirmed — ₹0 paid" against a non-zero total.
      const { paidTotal } = await reconcileBookingPaidAmount(local.booking_id);

      // The webhook path writes booking_history on every verified payment; without the
      // same entry here a swept payment appears in the ledger with no explanation of
      // how the booking came to be Confirmed.
      await sbInsert("booking_history", {
        booking_id: local.booking_id,
        action: "payment_reconciled",
        detail: JSON.stringify({
          payment_no: local.payment_no,
          amount: Number(item.amount || 0) / 100,
          paid_total: paidTotal,
          razorpay_payment_id: item.id,
          source: "razorpay_sync_sweep",
        }),
        created_at: nowUtcIso(),
      });
    } else {
      // Paid, but the booking was never created (verify callback never completed).
      // The payment row is now correctly marked Paid so it stops looking Pending, but
      // a human still has to build the booking — surface it rather than bury it.
      orphans.push({
        razorpayPaymentId: item.id,
        razorpayOrderId: item.order_id ?? null,
        amount: Number(item.amount || 0) / 100,
        capturedAt: capturedAtIso,
        contact: item.contact ?? item.notes?.Phone ?? null,
        customer: item.notes?.Customer ?? null,
      });
    }

    syncedRazorpayCount++;
  }

  const latestCaptured = items
    .filter((i: any) => i?.status === "captured" && i.created_at)
    .reduce<number | null>((max, i: any) => (max === null || i.created_at > max ? i.created_at : max), null);

  const webhook = await webhookHealth(
    "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64"),
    latestCaptured === null ? null : epochSecondsToUtcIso(latestCaptured)
  );
  if (webhook.checked && !webhook.healthy) {
    console.error(
      webhook.inactive.length > 0
        ? `[sync] RAZORPAY WEBHOOK DISABLED — ${webhook.inactive.join(", ")}`
        : `[sync] RAZORPAY WEBHOOK ACTIVE BUT NOT DELIVERING — last event ${webhook.lastEventAt ?? "never"}, ` +
          `money captured as recently as ${webhook.lastCapturedAt}. Check RAZORPAY_WEBHOOK_SECRET matches the dashboard.`
    );
  }

  // Persisted so the dashboard can show a banner every staff member sees on login —
  // a log line nobody reads is exactly how this went unnoticed for 8 days last time.
  // Only written when the check actually ran: a transient failure to reach Razorpay's
  // API must not overwrite a real "disabled" state with an unknown one and quietly
  // clear the banner.
  if (webhook.checked) {
    await setSetting("payment_webhook_health", { ...webhook, checkedAt: nowUtcIso() }).catch((err) =>
      console.error("[sync] could not persist webhook health for the dashboard banner:", err)
    );
  }

  return NextResponse.json({
    ok: failures.length === 0,
    webhook,
    syncedRazorpayCount,
    paidAmountRepairs,
    expiredReservationsReleased: sweptReservations.ok ? sweptReservations.data : null,
    orphanCount: orphans.length,
    orphans,
    failures,
    timestamp: nowUtcIso(),
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
