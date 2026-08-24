import { revalidatePath } from "next/cache";
import { randomToken, parseJSON, normalizePhone } from "./utils";
import { createBooking } from "./bookings";
import { calculateQuote } from "./pricing";
import { getVehicleById, getVehicles } from "./data";
import { sbSelect, sbSelectOne, sbInsert, sbUpdate, num } from "./supabase-rest";
import { z } from "zod";

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

export async function saveBookingDraft(input: DraftPayload & { token?: string | null }): Promise<{ token: string; savedAt: string }> {
  const token = input.token && /^[a-f0-9]{32,64}$/.test(input.token) ? input.token : randomToken(32);
  const existing = await sbSelectOne<{ id: number }>("enquiries", `select=id&draft_token=eq.${encodeURIComponent(token)}`);
  const phone = input.contact.phone ? normalizePhone(input.contact.phone) : null;
  const payload = { categoryId: input.categoryId, vehicleId: input.vehicleId, pickupAt: input.pickupAt, returnAt: input.returnAt, location: input.location, passengers: input.passengers, step: input.step, contact: input.contact, notes: input.notes };

  const common = {
    category_id: input.categoryId,
    vehicle_id: input.vehicleId,
    pickup_date: input.pickupAt,
    return_date: input.returnAt,
    location: input.location || null,
    passengers: input.passengers,
    name: input.contact.name || null,
    phone,
    email: input.contact.email?.trim() || null,
    data: JSON.stringify(payload),
    status: "draft",
    updated_at: new Date().toISOString(),
  };

  if (existing.ok && existing.data) {
    await sbUpdate("enquiries", `id=eq.${Number(existing.data.id)}`, { ...common, submitted_at: null });
  } else {
    await sbInsert("enquiries", {
      ...common,
      enquiry_no: `DR-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
      draft_token: token,
      created_at: new Date().toISOString(),
    });
  }
  return { token, savedAt: new Date().toISOString() };
}

export async function getDraft(token: string): Promise<DraftPayload | null> {
  const res = await sbSelectOne<{ data: string }>("enquiries", `select=data&draft_token=eq.${encodeURIComponent(token)}`);
  if (!res.ok || !res.data) return null;
  return parseJSON<DraftPayload>(res.data.data, {
    categoryId: null, vehicleId: null, pickupAt: null, returnAt: null, location: "", passengers: null, step: 1,
    contact: { name: "", phone: "" },
  });
}

const submitSchema = z.object({
  token: z.string().optional().or(z.literal("")),
  vehicleId: z.number().int().positive(),
  pickupAt: z.string().min(10, "Select a pickup date and time."),
  returnAt: z.string().min(10, "Select a return date and time."),
  location: z.string().optional(),
  passengers: z.number().int().nonnegative().nullable().optional(),
  contact: z.object({
    name: z.string().min(2, "Please enter your full name."),
    phone: z.string().min(10, "Enter a valid mobile number."),
    email: z.string().email("Enter a valid email.").optional().or(z.literal("")),
    address: z.string().optional(),
    dob: z.string().optional(),
    emergencyContact: z.string().optional(),
  }),
  termsAccepted: z.literal(true, { errorMap: () => ({ message: "Please accept the terms and conditions to continue." }) }),
});

function normalizeDocKind(kind: string): string {
  switch (kind) {
    case "licence":
    case "driver_licence":
      return "licence";
    case "driver_govt_id":
    case "pillion_id":
    case "govt_id":
      return "govt_id";
    case "driver_photo":
    case "pillion_photo":
    case "photo":
      return "photo";
    case "address_proof":
      return "address_proof";
    default:
      return "other";
  }
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
  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Please complete all required fields.";
    return { ok: false, error: first };
  }
  const docs = input.documents ?? [];
  const hasLicence = docs.some((d) => (d.kind === "licence" || d.kind === "driver_licence") && d.url);
  const hasGovtId = docs.some((d) => (d.kind === "govt_id" || d.kind === "driver_govt_id") && d.url);
  if (!hasLicence || !hasGovtId) {
    return { ok: false, error: "Please upload your driving licence and a government ID before confirming — this is required to hand over the vehicle." };
  }
  const draft = parsed.data.token
    ? await sbSelectOne<{ id: number }>("enquiries", `select=id&draft_token=eq.${encodeURIComponent(parsed.data.token)}`)
    : null;
  const existing = draft?.ok ? draft.data : null;

  // Resolve branch ID from location string or explicit payload
  let resolvedBranchId: number | undefined;
  if (parsed.data.location) {
    const locUpper = parsed.data.location.toUpperCase();
    if (locUpper.includes("SAKLESH")) resolvedBranchId = 1;
    else if (locUpper.includes("HASSAN")) resolvedBranchId = 2;
  }

  try {
    const { bookingNo, bookingId, customerId } = await createBooking({
      vehicleId: parsed.data.vehicleId,
      pickupAt: parsed.data.pickupAt,
      returnAt: parsed.data.returnAt,
      location: parsed.data.location,
      branchId: resolvedBranchId,
      passengers: parsed.data.passengers ?? undefined,
      customer: parsed.data.contact,
      enquiryId: existing ? Number(existing.id) : null,
    });

    // createBooking wrote straight to Supabase, so there is nothing left to sync: the
    // old syncEntityToSupabase() calls copied rows out of the ephemeral SQLite file.
    if (existing) {
      const updated = await sbUpdate("enquiries", `id=eq.${Number(existing.id)}`, {
        status: "submitted",
        stage: "Confirmed",
        submitted_at: new Date().toISOString(),
        draft_token: null,
        updated_at: new Date().toISOString(),
      });
      if (!updated.ok) console.error(`[booking] enquiry ${existing.id} not marked submitted — ${updated.error}`);
    }

    if (input.documents && input.documents.length > 0) {
      const rows = input.documents.map((d) => ({
        customer_id: customerId,
        booking_id: bookingId,
        kind: normalizeDocKind(d.kind),
        number: d.number ?? null,
        expiry_date: d.expiry ?? null,
        file_path: d.url,
        created_at: new Date().toISOString(),
      }));
      const docRes = await sbInsert("customer_documents", rows);
      if (!docRes.ok) console.error(`[booking] ${bookingNo}: documents not saved — ${docRes.error}`);
    }

    try {
      revalidatePath("/dashboard", "layout");
      revalidatePath("/dashboard/bookings", "page");
    } catch {}

    return { ok: true, bookingNo, bookingId, customerId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not create booking. Please try again." };
  }
}

export async function getAvailableVehicles(
  kind: string | null,
  pickupAt: string | null,
  returnAt: string | null,
  branchId?: number | null,
  location?: string | null
) {
  let targetBranchId: number | undefined = branchId ? Number(branchId) : undefined;
  if (!targetBranchId && location) {
    const locUpper = location.toUpperCase();
    if (locUpper.includes("SAKLESH")) targetBranchId = 1;
    else if (locUpper.includes("HASSAN")) targetBranchId = 2;
  }

  // If a specific branch is requested and is blocked, return no available vehicles for that branch
  if (targetBranchId) {
    const branchRes = await sbSelectOne<{ blocked: number }>("branches", `select=blocked&id=eq.${targetBranchId}`);
    if (branchRes.ok && num(branchRes.data?.blocked) === 1) {
      return [];
    }
  }

  const vehicles = await getVehicles({
    kind: kind || undefined,
    branchId: targetBranchId,
    onlyAvailable: true,
  });

  if (!pickupAt || !returnAt) return vehicles;

  const ids = vehicles.map((v) => Number(v.id)).filter((n) => Number.isFinite(n));
  if (ids.length === 0) return vehicles;

  // One query for every vehicle: per-vehicle counts would be one HTTP round trip each.
  const clashes = await sbSelect<{ vehicle_id: number; branch_id: number | null }>(
    "bookings",
    `select=vehicle_id,branch_id&vehicle_id=in.(${ids.join(",")})` +
      `&status=not.in.${encodeURIComponent('("Cancelled","Completed","Rejected")')}` +
      `&return_at=gt.${encodeURIComponent(pickupAt)}&pickup_at=lt.${encodeURIComponent(returnAt)}`
  );
  // A failed availability read must not read as "everything is free".
  if (!clashes.ok) throw new Error(`Could not check vehicle availability: ${clashes.error}`);

  const taken = new Map<number, number>();
  for (const row of clashes.data) {
    if (targetBranchId && row.branch_id && Number(row.branch_id) !== targetBranchId) {
      continue;
    }
    const key = Number(row.vehicle_id);
    taken.set(key, (taken.get(key) ?? 0) + 1);
  }

  return vehicles
    .map((v) => {
      const match = targetBranchId ? v.branch_distribution?.find((bd) => bd.branch_id === targetBranchId) : null;
      const baseUnits = match ? (match.available_units !== undefined ? match.available_units : match.total_units) : num(v.available_units ?? v.total_units, 1);
      const remaining = Math.max(0, baseUnits - (taken.get(Number(v.id)) ?? 0));
      return {
        ...v,
        available_units: remaining,
      };
    })
    .filter((v) => (v.available_units ?? 0) > 0 && v.status === "available" && num(v.active, 1) === 1);
}

export async function attachCustomerDocuments(customerId: number, bookingId: number, docs: Array<{ kind: string; url: string; number?: string; expiry?: string }>) {
  if (docs.length === 0) return { ok: true };
  const res = await sbInsert(
    "customer_documents",
    docs.map((d) => ({
      customer_id: customerId,
      booking_id: bookingId,
      kind: normalizeDocKind(d.kind),
      number: d.number ?? null,
      expiry_date: d.expiry ?? null,
      file_path: d.url,
      created_at: new Date().toISOString(),
    }))
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
}


import { parseIstInstant, toCanonicalIstIso } from "./rental-clock";

export async function getQuoteEstimate(vehicleId: number, pickupAt: string, returnAt: string) {
  const vehicle = await getVehicleById(vehicleId);
  if (!vehicle) return null;
  const pickup = parseIstInstant(pickupAt);
  const ret = parseIstInstant(returnAt);
  if (!pickup || !ret || ret.getTime() <= pickup.getTime()) return null;
  return calculateQuote(vehicle, pickup, ret);
}
