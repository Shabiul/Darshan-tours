"use server";

import { gatewayPost } from "./gateway";
import { supabaseRestInsert, supabaseRestSelect, supabaseRestUpsert } from "./supabase-rest";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export async function createBookingPaymentOrder(
  bookingId: number,
  amountDue?: number,
  quote?: {
    days?: number;
    baseAmount?: number;
    gstPct?: number;
    gstAmount?: number;
    depositAmount?: number;
    gatewayFeeAmount?: number;
    /** All-in disclosure figure (deposit included). NEVER charge this. */
    totalAmount?: number;
    /** Deposit-excluded figure — this is what may be charged online. */
    payableNow?: number;
    depositPayableAtPickup?: number;
  } | null
): Promise<
  { ok: true; orderId: string; amountPaise: number; keyId: string; paymentId: number; paymentNo: string; notes?: Record<string, string>; businessName: string } | { ok: false; error: string }
> {
  // 1. Primary Attempt via CRM Gateway
  try {
    const res = await gatewayPost<any>("/api/gateway/v1/payments/order", { bookingId, amountDue, quote });
    if (res && res.ok && res.orderId) {
      return res;
    }
  } catch (err) {
    console.warn("Gateway payment order proxy error:", err);
  }

  // 2. High-Availability Direct Razorpay Order Creation on Web Server
  const keyId = process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    return { ok: false, error: "Razorpay credentials not configured. Please choose Pay at Pickup." };
  }

  try {
    let finalAmount = Number(amountDue) || 0;
    let bookingNo = `BK-${bookingId}`;

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    if (supabaseUrl && supabaseKey) {
      try {
        const supabase = createClient(supabaseUrl, supabaseKey);
        const { data: b } = await supabase.from("bookings").select("*, vehicles(*)").eq("id", bookingId).single();
        if (b) {
          bookingNo = b.booking_no || bookingNo;
          if (finalAmount <= 0) {
            // `bookings.total_amount` is the rental total (matches payableNow).
            // The refundable security deposit is cash at pickup and tracked in deposit_amount.
            finalAmount = Number(b.total_amount || 0);
            if (finalAmount <= 0 && b.vehicles) {
              const base = Number(b.vehicles.rate_24h || 1000);
              const gst = Math.round(base * 0.06);
              finalAmount = base + gst;
            }
          }
        }
      } catch {}
    }

    if (finalAmount <= 0) {
      finalAmount = 1;
    }

    const amountPaise = Math.max(100, Math.round(finalAmount * 100)); // Minimum 100 paise = ₹1 INR
    const paymentNo = `PY-${Date.now().toString(36).toUpperCase()}`;

    // Itemized notes for Razorpay receipt and customer transparency
    const baseAmt = quote?.baseAmount ?? Math.max(0, finalAmount - (quote?.gstAmount ?? 0));
    const depAmt = quote?.depositPayableAtPickup ?? quote?.depositAmount ?? 0;
    const gstAmt = quote?.gstAmount ?? 0;

    const notes: Record<string, string> = {
      "Booking No": bookingNo,
      "Base Rental": `₹${baseAmt.toLocaleString("en-IN")}`,
      "GST (6%)": gstAmt > 0 ? `₹${gstAmt.toLocaleString("en-IN")}` : "Included",
      // Disclosed on the receipt, deliberately excluded from the charged amount.
      "Deposit (cash at pickup)": depAmt > 0 ? `₹${depAmt.toLocaleString("en-IN")} — not charged online` : "Collected at pickup",
      "Paid Online Now": `₹${finalAmount.toLocaleString("en-IN")}`,
    };

    // Call Razorpay API directly
    const authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: "INR",
        receipt: paymentNo,
        notes,
      }),
    });

    const rzpOrder = await rzpRes.json();
    if (!rzpRes.ok || !rzpOrder.id) {
      return { ok: false, error: rzpOrder.error?.description || "Could not create Razorpay order." };
    }

    return {
      ok: true,
      orderId: rzpOrder.id,
      amountPaise,
      keyId,
      paymentId: bookingId,
      paymentNo,
      businessName: "Darshh Holiday",
      notes,
    };
  } catch (err: any) {
    console.error("Direct Razorpay order creation error:", err?.message || err);
    return { ok: false, error: "Could not connect to payment gateway. Please choose Pay at Pickup or try again." };
  }
}

export async function verifyBookingPayment(input: {
  paymentId: number;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}): Promise<{ ok: true; bookingNo: string } | { ok: false; error: string }> {
  // 1. Try CRM Gateway
  try {
    const res = await gatewayPost<any>("/api/gateway/v1/payments/verify", input);
    if (res && res.ok) return res;
  } catch {}

  // 2. Direct HMAC-SHA256 Signature Verification & Live Supabase / CRM Sync
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    return { ok: false, error: "Razorpay credentials not configured. Payment could not be verified." };
  }

  const expectedSignature = crypto
    .createHmac("sha256", keySecret)
    .update(`${input.razorpayOrderId}|${input.razorpayPaymentId}`)
    .digest("hex");

  if (expectedSignature !== input.razorpaySignature) {
    return { ok: false, error: "Invalid payment signature." };
  }

  let bookingNo = `BK-${input.paymentId}`;
  let paidAmount = 1000;

  // High-availability live update directly in Supabase PostgreSQL
  try {
    const rows = await supabaseRestSelect<any>("bookings", `id=eq.${input.paymentId}`);
    let b = rows && rows.length > 0 ? rows[0] : null;

    if (!b) {
      paidAmount = 954; // rental + GST only; the ₹1000 deposit is cash at pickup
      const now = new Date().toISOString();
      const tomorrow = new Date(Date.now() + 86400000).toISOString();
      await supabaseRestUpsert("bookings", {
        id: input.paymentId,
        booking_no: bookingNo,
        vehicle_id: 1,
        pickup_at: now,
        return_at: tomorrow,
        base_amount: 900,
        deposit_amount: 1000,
        gst_amount: 54,
        total_amount: 900 + 54,
        paid_amount: 900 + 54,
        status: "Confirmed",
        created_at: now,
        updated_at: now,
      });
    } else {
      bookingNo = b.booking_no || bookingNo;
      const allIn = Number(b.total_amount || 0);
      paidAmount = allIn > 0 ? allIn : Number(b.paid_amount || 0);

      // 1. Update Booking Status to Confirmed & Paid Amount
      await supabaseRestUpsert("bookings", {
        ...b,
        status: "Confirmed",
        paid_amount: paidAmount,
        updated_at: new Date().toISOString(),
      });
    }

    // 2. Record Payment Entry in CRM Payments Table
    const paymentNo = `PY-${Date.now().toString(36).toUpperCase()}`;
    await supabaseRestInsert("payments", {
      booking_id: input.paymentId,
      payment_no: paymentNo,
      kind: "online",
      amount: paidAmount,
      status: "Paid",
      method: "UPI",
      gateway_ref: input.razorpayPaymentId,
      razorpay_order_id: input.razorpayOrderId,
      razorpay_payment_id: input.razorpayPaymentId,
      notes: `Razorpay Online Payment verified. Order ID: ${input.razorpayOrderId}, Payment ID: ${input.razorpayPaymentId}`,
      created_at: new Date().toISOString(),
    });

    // 3. Record Audit Log in Booking History
    try {
      await supabaseRestInsert("booking_history", {
        booking_id: input.paymentId,
        action: "Payment Verified",
        detail: `Razorpay payment of ₹${paidAmount} verified successfully. Payment ID: ${input.razorpayPaymentId}. Status updated to Confirmed.`,
        created_at: new Date().toISOString(),
      });
    } catch {}

      // 4. Cache downloadable Invoice payload in Redis for this session
      try {
        const { cacheSet, cacheInvalidatePrefix } = await import("./redis");
        const invoicePayload = {
          bookingNo,
          paymentId: input.paymentId,
          razorpayOrderId: input.razorpayOrderId,
          razorpayPaymentId: input.razorpayPaymentId,
          amount: paidAmount,
          verifiedAt: new Date().toISOString(),
          status: "Confirmed",
        };
        await cacheSet(`session:invoice:${input.paymentId}`, invoicePayload, 86400);
        await cacheSet(`session:invoice:${bookingNo}`, invoicePayload, 86400);
        await cacheInvalidatePrefix("web:gateway:");
        await cacheInvalidatePrefix("vehicles:");
        await cacheInvalidatePrefix("fleet:");
      } catch {}

      try {
        const { revalidatePath } = await import("next/cache");
        revalidatePath("/", "layout");
        revalidatePath("/vehicles", "page");
        revalidatePath("/booking", "page");
      } catch {}

    } catch (err: any) {
      console.error("Supabase payment verification update error:", err?.message || err);
    }

  return { ok: true, bookingNo };
}
