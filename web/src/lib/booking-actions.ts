"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@supabase/supabase-js";
import { gatewayGet, gatewayPost } from "./gateway";
import { supabaseRestInsert, supabaseRestSelect, supabaseRestUpsert } from "./supabase-rest";
import type { Vehicle } from "./data";
import { normalizeDocKind } from "./doc-kind";
import { normalizePhone } from "./utils";

export type DraftPayload = {
  categoryId: number | null;
  vehicleId: number | null;
  pickupAt: string | null;
  returnAt: string | null;
  location: string;
  passengers: number | null;
  step: number;
  contact: { name: string; phone: string; email?: string; address?: string; dob?: string; emergencyContact?: string };
  notes?: string;
};

export type Quote = {
  days: number;
  weekendDaysCount?: number;
  dayBreakdown: Array<{ date: string; isWeekend: boolean; rate: number }>;
  baseAmount: number;
  offSchedulePickupFee: number;
  gstAmount: number;
  gstPct: number;
  gatewayFeeAmount: number;
  gatewayFeePct: number;
  depositAmount: number;
  includedKm: number;
  extraKmRate: number;
  afterHours: boolean;
  offSchedulePickup: boolean;
  weekendMinDays: number;
  belowWeekendMinimum: boolean;
  appliedRuleName: string | null;
  /** Pickup before 08:00 IST — the one-off ₹250 surcharge applies. */
  earlyPickup: boolean;
  /** Drop after 08:00 IST — one extra full day is already counted in `days`. */
  lateDrop: boolean;
  /**
   * ALL-IN figure, deposit INCLUDED. For disclosure and the invoice only.
   * NEVER send this to Razorpay — see `payableNow`.
   */
  totalAmount: number;
  /**
   * What the customer actually pays online: rental + surcharge + GST + gateway fee.
   * The deposit is EXCLUDED — it is collected in cash at pickup.
   */
  payableNow: number;
  /** Cash deposit collected at pickup (₹1000 two-wheelers, ₹2000 cars). Not charged online. */
  depositPayableAtPickup: number;
};

export async function saveBookingDraft(input: DraftPayload & { token?: string | null }): Promise<{ token: string; savedAt: string }> {
  return gatewayPost("/api/gateway/v1/booking/draft", input);
}

export async function getDraft(token: string): Promise<DraftPayload | null> {
  const res = await gatewayGet<{ draft: DraftPayload | null }>(`/api/gateway/v1/booking/draft?token=${encodeURIComponent(token)}`);
  return res?.draft ?? null;
}

export async function submitBooking(input: {
  token: string;
  vehicleId: number;
  pickupAt: string;
  returnAt: string;
  location?: string;
  passengers?: number | null;
  contact: DraftPayload["contact"];
  termsAccepted: boolean;
  documents?: Array<{ kind: string; url: string; number?: string; expiry?: string }>;
}): Promise<{ ok: boolean; bookingNo?: string; bookingId?: number; customerId?: number; error?: string }> {
  // Terms and mandatory documents are enforced here as well as in the CRM, so the
  // emergency path below cannot be used to skip them.
  if (!input.termsAccepted) {
    return { ok: false, error: "Please accept the rental terms and conditions to continue." };
  }
  const docKinds = new Set((input.documents ?? []).filter((d) => d.url).map((d) => normalizeDocKind(d.kind)));
  if (!docKinds.has("licence") || !docKinds.has("govt_id")) {
    return { ok: false, error: "Please upload the driver's licence and government ID before submitting." };
  }

  // 1. Primary CRM Gateway API Proxy Submission
  try {
    const res = await gatewayPost<{ ok: boolean; bookingNo?: string; bookingId?: number; customerId?: number; error?: string }>("/api/gateway/v1/booking/submit", input);
    if (res && res.ok && res.bookingId) {
      try {
        const { cacheInvalidatePrefix } = await import("./redis");
        await cacheInvalidatePrefix("web:gateway:");
        await cacheInvalidatePrefix("vehicles:");
        await cacheInvalidatePrefix("fleet:");
      } catch {}
      try {
        revalidatePath("/", "layout");
        revalidatePath("/vehicles", "page");
        revalidatePath("/booking", "page");
      } catch {}
      return res;
    }

    // The gateway answered. If it declined, that is a BUSINESS decision — vehicle
    // unavailable, below the weekend minimum, invalid dates — and it is final.
    // Falling through to the emergency path here (which is what used to happen)
    // re-attempted the booking with none of those rules applied, so every rule the
    // CRM enforced could be defeated simply by being rejected once.
    if (res && res.ok === false) {
      return { ok: false, error: res.error ?? "This booking could not be confirmed." };
    }
  } catch (err) {
    // Only a transport failure reaches here — the CRM is unreachable, not refusing.
    console.warn("Gateway POST submit fetch warning:", err);
  }

  // 2. Direct Supabase PostgreSQL High-Availability Fallback
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const supabaseKey =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    "";

  if (supabaseUrl && supabaseKey) {
    try {
      const supabase = createClient(supabaseUrl, supabaseKey);

    // Validate vehicle status and branch status directly before slot reservation
    const { getVehicleById, getBranches } = await import("./data");
    const v = await getVehicleById(input.vehicleId);
    if (
      !v ||
      v.status === "unavailable" ||
      v.status === "blocked" ||
      v.status === "maintenance" ||
      v.status === "inactive" ||
      v.status === "archived" ||
      Number(v.active) === 0
    ) {
      return { ok: false, error: "This vehicle is currently unavailable for booking." };
    }

    let branchId: number | undefined;
    if (input.location) {
      const locUpper = input.location.toUpperCase();
      if (locUpper.includes("SAKLESH")) branchId = 1;
      else if (locUpper.includes("HASSAN")) branchId = 2;
    }
    if (!branchId) {
      branchId = v.branch_id ?? undefined;
    }

    if (branchId) {
      const branches = await getBranches();
      const targetBranch = branches.find((b) => Number(b.id) === branchId);
      if (targetBranch && Number((targetBranch as any).blocked) === 1) {
        return { ok: false, error: `Bookings are temporarily suspended at ${targetBranch.name || "this branch"}.` };
      }
    }

    // Availability is claimed through the SAME database function the CRM uses. It
    // takes a per-vehicle lock, counts live holds against total_units and inserts the
    // hold in one transaction — so this path cannot double-book even while the CRM is
    // down. Previously it performed no availability check at all and created no
    // availability_blocks row, meaning bookings made here were invisible to the
    const { toCanonicalIstIso } = await import("./rental-clock");
    const canonicalPickupAt = toCanonicalIstIso(input.pickupAt) || input.pickupAt;
    const canonicalReturnAt = toCanonicalIstIso(input.returnAt) || input.returnAt;

    const claimRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/reserve_vehicle_slot`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        p_vehicle_id: input.vehicleId,
        p_pickup_at: canonicalPickupAt,
        p_return_at: canonicalReturnAt,
      }),
      cache: "no-store",
    });
    const claimedBlockId = claimRes.ok ? ((await claimRes.json()) as number | null) : null;
    if (!claimedBlockId) {
      return { ok: false, error: "This vehicle is no longer available for the selected dates and branch." };
    }

    const bookingNo = `BK-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase().slice(-6)}${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, "0")}`;
    // Same normalization the CRM uses, so both paths resolve to the same customer
    // row. This previously stripped only non-digits, producing a different key and
    // therefore a duplicate customer for the same person.
    const phone = normalizePhone(input.contact.phone ?? "");

    // Must never default to a real customer id: an unresolved lookup would attach this
    // booking to somebody else's account, and that person would see it in their portal.
    let customerId: number | null = null;
    try {
      const existingCustomers = await supabaseRestSelect<{ id: number }>("customers", `phone=eq.${encodeURIComponent(phone)}`);
      if (existingCustomers && existingCustomers.length > 0) {
        customerId = existingCustomers[0].id;
      } else {
        const newCustRes = await supabaseRestInsert<{ id: number }>("customers", {
          name: input.contact.name,
          phone,
          email: input.contact.email || null,
          source: "Website booking",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        if (newCustRes.ok && newCustRes.data?.id) customerId = newCustRes.data.id;
      }
    } catch {}

    if (!customerId) {
      console.error("submitBooking fallback: could not resolve or create a customer record");
      return {
        ok: false,
        error: "We could not confirm your booking right now. No payment has been taken. Please try again shortly.",
      };
    }

    // Quote figures start unset. Booking at an invented price is worse than not
    // booking at all — the customer would be charged an amount nobody agreed to.
    let baseAmount: number | null = null;
    let depositAmount: number | null = null;
    let gstAmount: number | null = null;
    let totalAmount: number | null = null;

    try {
      const { getVehicles } = await import("./data");
      const { calculateRentalQuoteFromStrings } = await import("./pricing");
      const allVehicles = await getVehicles();
      const v = allVehicles.find((item) => Number(item.id) === Number(input.vehicleId));
      if (v) {
        // Same shared calculation the site quoted from, so the row written here carries
        // the price the customer was actually shown.
        const [pickupDateStr, pickupTimeStr = "08:00"] = input.pickupAt.split("T");
        const [returnDateStr, returnTimeStr = "08:00"] = input.returnAt.split("T");
        const quote = calculateRentalQuoteFromStrings(v, pickupDateStr, pickupTimeStr, returnDateStr, returnTimeStr);
        if (quote) {
          baseAmount = quote.baseAmount + quote.offSchedulePickupFee;
          depositAmount = quote.depositPayableAtPickup;
          gstAmount = quote.gstAmount;
          // `total_amount` is the rental total (matches payableNow); the refundable security deposit
          // is kept in `deposit_amount` and collected in cash at pickup.
          totalAmount = quote.totalAmount;
        }
      }
    } catch (quoteErr) {
      console.error("submitBooking fallback: quote calculation failed", quoteErr);
    }

    if (totalAmount === null || baseAmount === null || depositAmount === null || gstAmount === null) {
      console.error(`submitBooking fallback: could not price vehicle ${input.vehicleId}`);
      return {
        ok: false,
        error: "We could not price this booking right now. No payment has been taken. Please try again shortly.",
      };
    }

    const insertRes = await supabaseRestInsert<{ id: number }>("bookings", {
      booking_no: bookingNo,
      customer_id: customerId,
      vehicle_id: input.vehicleId,
      pickup_at: canonicalPickupAt,
      return_at: canonicalReturnAt,
      base_amount: baseAmount,
      deposit_amount: depositAmount,
      gst_amount: gstAmount,
      total_amount: totalAmount,
      // Marked as "Pending payment" until Razorpay payment is verified or manager assigns
      status: "Pending payment",
      created_at: new Date().toISOString(),
    });

    // A failed insert previously still produced a booking id from the clock, so the
    // customer received a confirmation for a row that was never written.
    if (!insertRes.ok || !insertRes.data?.id) {
      console.error("submitBooking fallback: Supabase booking insert failed", insertRes);
      // The hold we claimed above carries a 10-minute expiry and is skipped by
      // availability counts once lapsed, so an abandoned claim frees itself.
      return {
        ok: false,
        error: "We could not confirm your booking right now. No payment has been taken. Please try again shortly.",
      };
    }

    const bookingId = Number(insertRes.data.id);

    // Link the claimed hold to the booking and clear its expiry — it is now a real
    // reservation, not a pending claim. Without this the hold would lapse in 10
    // minutes and the vehicle could be sold twice.
    const linkRes = await supabaseRestUpsert("availability_blocks", {
      id: claimedBlockId,
      booking_id: bookingId,
      expires_at: null,
      notes: null,
    });
    if (!linkRes.ok) {
      console.error(`submitBooking fallback: could not link availability hold ${claimedBlockId} to booking ${bookingId}`);
    }

    // Save all uploaded customer ID documents in Supabase
    if (input.documents && Array.isArray(input.documents)) {
      for (const doc of input.documents) {
        if (!doc.url) continue;
        try {
          await supabaseRestInsert("customer_documents", {
            customer_id: customerId,
            booking_id: bookingId,
            kind: normalizeDocKind(doc.kind || "other"),
            number: doc.number || null,
            expiry_date: doc.expiry || null,
            file_path: doc.url,
            verified: 0,
            created_at: new Date().toISOString(),
          });
        } catch {}
      }
    }

    try {
      const { cacheInvalidatePrefix } = await import("./redis");
      await cacheInvalidatePrefix("web:gateway:");
      await cacheInvalidatePrefix("vehicles:");
      await cacheInvalidatePrefix("fleet:");
    } catch {}
    try {
      revalidatePath("/", "layout");
      revalidatePath("/vehicles", "page");
      revalidatePath("/booking", "page");
    } catch {}

    return { ok: true, bookingNo, bookingId, customerId };
  } catch (supaErr) {
    console.warn("Direct Supabase booking creation fallback attempt:", supaErr);
  }
}

  // 3. Both the CRM gateway and the direct Supabase write failed.
  // Never fabricate a booking number here: doing so hands the customer a
  // confirmation for a booking that exists in no system of record.
  console.error("submitBooking failed: gateway and Supabase fallback both unavailable");
  return {
    ok: false,
    error:
      "We could not confirm your booking right now. No payment has been taken. Please try again in a moment, or call us and we will complete it for you.",
  };
}

export async function getAvailableVehicles(
  kind: string | null,
  pickupAt: string | null,
  returnAt: string | null,
  location?: string | null
): Promise<Vehicle[]> {
  // 1. Primary CRM Gateway API Request
  try {
    const qs = new URLSearchParams();
    if (kind) qs.set("kind", kind);
    if (pickupAt) qs.set("pickupAt", pickupAt);
    if (returnAt) qs.set("returnAt", returnAt);
    if (location) qs.set("location", location);
    const res = await gatewayGet<{ vehicles: Vehicle[] }>(`/api/gateway/v1/booking/available?${qs.toString()}`);
    if (res && !("error" in res) && Array.isArray(res.vehicles)) {
      return res.vehicles;
    }
  } catch (err) {
    console.warn("Gateway available vehicles fetch warning:", err);
  }

  // 2. Fetch using centralized getVehicles logic with branch segregation
  const { getVehicles } = await import("@/lib/data");
  return getVehicles({
    kind: kind || undefined,
    location: location || undefined,
  });
}

export async function getQuoteEstimate(vehicleId: number, pickupAt: string, returnAt: string): Promise<Quote | null> {
  // Reliable unified quote calculation synced with Redis search cache
  try {
    const { getVehicles } = await import("@/lib/data");
    const { getCachedVehicleSearchPrice } = await import("@/lib/search-pricing");

    const all = await getVehicles();
    const v = all.find((item) => Number(item.id) === Number(vehicleId));

    if (v && pickupAt && returnAt) {
      const pParts = pickupAt.split("T");
      const rParts = returnAt.split("T");
      const pickupDateStr = pParts[0];
      const pickupTimeStr = pParts[1] || "08:00";
      const returnDateStr = rParts[0];
      const returnTimeStr = rParts[1] || "08:00";

      const searchQuote = await getCachedVehicleSearchPrice(
        v,
        pickupDateStr,
        pickupTimeStr,
        returnDateStr,
        returnTimeStr
      );

      if (searchQuote) {
        // The search quote is already the shared calculation from ./pricing, so it is
        // passed through field-for-field. Re-deriving anything here is what let the
        // weekend minimum, the km allowance and the payable amount drift from the CRM.
        return {
          days: searchQuote.days,
          weekendDaysCount: searchQuote.weekendDaysCount,
          dayBreakdown: searchQuote.dayBreakdown.map((d) => ({ date: d.date, isWeekend: d.isWeekend, rate: d.rate })),
          baseAmount: searchQuote.baseAmount,
          offSchedulePickupFee: searchQuote.offSchedulePickupFee,
          gstAmount: searchQuote.gstAmount,
          gstPct: searchQuote.gstPct,
          gatewayFeeAmount: searchQuote.gatewayFeeAmount,
          gatewayFeePct: searchQuote.gatewayFeePct,
          depositAmount: searchQuote.depositAmount,
          includedKm: searchQuote.includedKm,
          extraKmRate: searchQuote.extraKmRate,
          afterHours: searchQuote.afterHours,
          offSchedulePickup: searchQuote.offSchedulePickup,
          weekendMinDays: searchQuote.weekendMinDays,
          belowWeekendMinimum: searchQuote.belowWeekendMinimum,
          appliedRuleName: searchQuote.appliedRuleName,
          earlyPickup: searchQuote.earlyPickup,
          lateDrop: searchQuote.lateDrop,
          totalAmount: searchQuote.totalAmount,
          // Deposit EXCLUDED: it is collected in cash at pickup, never via Razorpay.
          payableNow: searchQuote.payableNow,
          depositPayableAtPickup: searchQuote.depositPayableAtPickup,
        };
      }
    }
  } catch (err) {
    console.warn("Unified quote estimate error:", err);
  }

  // Gateway API proxy fallback if needed
  try {
    const res = await gatewayPost<{ quote: Quote | null }>("/api/gateway/v1/booking/quote", { vehicleId, pickupAt, returnAt });
    if (res && res.quote) return res.quote;
  } catch (err) {
    console.warn("Gateway quote estimate fetch warning:", err);
  }

  return null;
}

export async function getVehicleById(id: number): Promise<Vehicle | null> {
  // 1. Try Gateway API
  try {
    const res = await gatewayGet<{ vehicle: Vehicle | null }>(`/api/gateway/v1/booking/vehicle?id=${id}`);
    if (res && res.vehicle) return res.vehicle;
  } catch {}

  // 2. Direct Supabase Lookup
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
  if (supabaseUrl && supabaseKey) {
    try {
      const supabase = createClient(supabaseUrl, supabaseKey);
      const { data: v } = await supabase.from("vehicles").select("*").eq("id", id).single();
      if (v) {
        return {
          ...v,
          category_name: v.category_name || "Vehicle",
          category_kind: v.category_kind || "car",
          category_slug: v.category_slug || "cars",
          photos: Array.isArray(v.photos) ? v.photos : [v.primary_photo || "/vehicles/baleno-manual.avif"],
          primary_photo: v.primary_photo || (Array.isArray(v.photos) ? v.photos[0] : "/vehicles/baleno-manual.avif"),
          available_units: v.available_units ?? v.total_units ?? 1,
        };
      }
    } catch {}
  }

  // 3. Fallback to static dataset
  const { getVehicles } = await import("@/lib/data");
  const all = await getVehicles();
  return all.find((v) => Number(v.id) === Number(id)) ?? null;
}
