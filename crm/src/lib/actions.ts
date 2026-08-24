"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireUser, requireAdmin, assertCan } from "./auth";
import { logActivity, pushNotification } from "./activity";
import { slugify, normalizePhone } from "./utils";
import { sendTemplate } from "./messaging";
import { getSetting, setSetting } from "./settings";
import { calculateLateFee, calculateExtraKm } from "./pricing";
import type { SessionUser } from "./auth";
import { issueRazorpayRefund } from "./razorpay";
import { sbSelect, sbSelectOne, sbInsert, sbUpdate, sbUpsert, sbDelete, sbRpc, num } from "./supabase-rest";
import type { RestResult } from "./supabase-rest";
import { cacheInvalidatePrefix } from "./redis";
import { withIdempotency } from "./idempotency";

export async function invalidateContentCaches(): Promise<void> {
  // 1. Invalidate Redis Cache prefixes
  await Promise.all([
    cacheInvalidatePrefix("vehicles:"),
    cacheInvalidatePrefix("vehicle_categories:"),
    cacheInvalidatePrefix("branches:"),
    cacheInvalidatePrefix("web:gateway:"),
    cacheInvalidatePrefix("testimonials:"),
    cacheInvalidatePrefix("faqs:"),
  ]).catch(() => {});

  // 2. Trigger instant On-Demand Revalidation on the Web frontend (< 200ms)
  try {
    const webUrl =
      process.env.WEB_URL ||
      process.env.NEXT_PUBLIC_WEB_URL ||
      (process.env.NODE_ENV === "production" || process.env.VERCEL ? "https://selfdrive.bike" : "http://localhost:3000");

    const gatewayKey = process.env.GATEWAY_API_KEY;
    if (webUrl && gatewayKey) {
      void fetch(`${webUrl.replace(/\/$/, "")}/api/revalidate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-gateway-key": gatewayKey,
        },
        body: JSON.stringify({ paths: ["/", "/vehicles", "/booking"] }),
        cache: "no-store",
      }).catch((err) => {
        console.warn("[revalidate] Web frontend webhook warning:", err?.message);
      });
    }
  } catch {
    // Non-blocking best-effort
  }
}

function refresh(path = "/dashboard") {
  revalidatePath(path, "layout");
  void invalidateContentCaches().catch(() => {});
}

/* ----------------------------- Write plumbing ------------------------------ */
/*
 * Every mutation below writes straight to Supabase and awaits the result. The old
 * shape — write to a per-lambda SQLite file, then `syncEntityToSupabase(...).catch(() => {})`
 * — lost writes twice over: the SQLite file is wiped on cold start (and degrades to a
 * mock that fakes `lastInsertRowid`), and the un-awaited sync never runs because the
 * lambda freezes the moment the response is returned.
 */

type ActionError = { ok: false; error: string };

/** Turns a failed REST result into the file's error shape. */
function fail(res: { error: string }, what: string): ActionError {
  return { ok: false, error: `${what} failed: ${res.error}` };
}

/**
 * Builds a human-facing document number from the row's own primary key.
 *
 * The previous `nextNumber()` combined a module-level counter (reset on every cold
 * start) with a timestamp, so two lambdas minted the same ENQ/PY/RC number routinely
 * — and those columns are UNIQUE, so the loser's insert simply failed. Deriving from
 * the BIGSERIAL id makes collisions impossible.
 */
function docNumber(prefix: string, id: number): string {
  return `${prefix}-${new Date().getFullYear()}-${String(id).padStart(6, "0")}`;
}

/**
 * Inserts a row whose UNIQUE "number" column must be derived from its own id.
 *
 * Two steps by necessity: a provisional UUID-backed value satisfies the NOT NULL /
 * UNIQUE constraint, then the real number is written once the id exists.
 */
async function insertWithNumber<T extends { id: number }>(
  table: string,
  numberColumn: string,
  prefix: string,
  record: Record<string, unknown>
): Promise<RestResult<{ row: T; number: string }>> {
  const provisional = `${prefix}-TMP-${randomUUID()}`;
  const inserted = await sbInsert<T>(table, { ...record, [numberColumn]: provisional });
  if (!inserted.ok) return inserted;

  const id = Number((inserted.data as { id: number }).id);
  const finalNumber = docNumber(prefix, id);
  const renamed = await sbUpdate<T>(table, `id=eq.${id}`, { [numberColumn]: finalNumber });
  if (!renamed.ok) return renamed;

  return { ok: true, data: { row: renamed.data[0] ?? inserted.data, number: finalNumber } };
}

const nowIso = () => new Date().toISOString();

export async function staffUser(): Promise<SessionUser> {
  return requireUser();
}

export async function adminUser(): Promise<SessionUser> {
  return requireAdmin();
}

/* -------------------------------- Enquiries -------------------------------- */

export async function createManualEnquiry(input: {
  name: string; phone: string; email?: string; categoryId?: number | null; vehicleId?: number | null;
  location?: string; pickupDate?: string; returnDate?: string; passengers?: number; source?: string; notes?: string;
}): Promise<{ id: number; enquiryNo: string } | ActionError> {
  const user = await staffUser();
  const phone = normalizePhone(input.phone);

  const res = await insertWithNumber<{ id: number }>("enquiries", "enquiry_no", "ENQ", {
    category_id: input.categoryId ?? null,
    vehicle_id: input.vehicleId ?? null,
    pickup_date: input.pickupDate ?? null,
    return_date: input.returnDate ?? null,
    location: input.location ?? null,
    passengers: input.passengers ?? null,
    name: input.name,
    phone,
    email: input.email ?? null,
    source: input.source ?? "Manual",
    notes: input.notes ?? null,
    assigned_to: user.id,
    status: "submitted",
    submitted_at: nowIso(),
  });
  if (!res.ok) return fail(res, "Creating the enquiry");

  const id = Number(res.data.row.id);
  await logActivity(user.id, "enquiry_created", "enquiry", id, { enquiry_no: res.data.number });
  refresh();
  return { id, enquiryNo: res.data.number };
}

export async function assignEnquiry(id: number, assigneeId: number | null) {
  const user = await staffUser();

  const updated = await sbUpdate<{ enquiry_no: string; name: string | null }>("enquiries", `id=eq.${id}`, {
    assigned_to: assigneeId,
    updated_at: nowIso(),
  });
  if (!updated.ok) return fail(updated, "Assigning the enquiry");

  const row = updated.data[0];
  if (assigneeId && row) await pushNotification(assigneeId, `Enquiry ${row.enquiry_no} assigned`, row.name ?? "", id);

  await logActivity(user.id, "enquiry_assigned", "enquiry", id, { assignee_id: assigneeId });
  refresh();
  return { ok: true as const };
}

export async function changeEnquiryStage(id: number, stage: string) {
  const user = await staffUser();
  const stages = await getSetting<string[]>("enquiry_stages", []);
  if (!stages.includes(stage)) return { ok: false as const, error: "Unknown stage" };

  const updated = await sbUpdate("enquiries", `id=eq.${id}`, { stage, updated_at: nowIso() });
  if (!updated.ok) return fail(updated, "Changing the enquiry stage");

  const history = await sbInsert("enquiry_history", { enquiry_id: id, user_id: user.id, action: "stage_change", detail: stage });
  if (!history.ok) return fail(history, "Recording the stage change");

  await logActivity(user.id, "enquiry_stage", "enquiry", id, { stage });
  refresh();
  return { ok: true as const };
}

export async function addEnquiryNote(id: number, note: string) {
  const user = await staffUser();
  const res = await sbInsert("enquiry_history", { enquiry_id: id, user_id: user.id, action: "note", detail: note });
  if (!res.ok) return fail(res, "Saving the note");

  await logActivity(user.id, "enquiry_note", "enquiry", id, { note });
  refresh();
  return { ok: true as const };
}

/* -------------------------------- Vehicles --------------------------------- */

export async function saveVehicle(input: {
  id?: number;
  name: string;
  brand: string;
  model: string;
  year?: number;
  categoryId?: number | null;
  branchId?: number | null;
  registrationNo?: string;
  cc?: number;
  fuelType?: string;
  transmission?: string;
  seats?: number;
  mileage?: string;
  includedKm?: number;
  extraKmRate?: number;
  rate12h?: number;
  rate24h?: number;
  hourlyRate?: number;
  deposit?: number;
  lateFeePerHour?: number;
  totalUnits?: number;
  description?: string;
  terms?: string;
  status?: string;
  active?: boolean;
  photoUrl?: string;
  branchAllocations?: Array<{ branchId: number; quantity: number }>;
  unallocatedUnits?: number;
  physicalUnits?: Array<{ id?: number; unit_identifier?: string; registration_no?: string; current_branch_id?: number | null; status?: string }>;
  idempotencyKey?: string;
}) {
  return withIdempotency(input.idempotencyKey, "save_vehicle", input, async () => {
    const user = await staffUser();
    assertCan(user, "staff");

    if (!input.branchId) {
      return { ok: false as const, error: "Please assign a primary branch to the vehicle." };
    }

    const activeVal = input.active === false ? 0 : 1;
    const units = Math.max(1, input.totalUnits ?? 1);

    // Validate branch allocations if provided
    if (input.branchAllocations && input.branchAllocations.length > 0) {
      const sumBranchQty = input.branchAllocations.reduce((sum, a) => sum + Math.max(0, Number(a.quantity) || 0), 0);
      const unallocated = Math.max(0, Number(input.unallocatedUnits) || 0);
      if (sumBranchQty + unallocated > units) {
        return {
          ok: false as const,
          error: `Total branch allocations (${sumBranchQty} + ${unallocated} unallocated = ${sumBranchQty + unallocated}) cannot exceed total units (${units}).`,
        };
      }
    }

    const primaryRegNo = input.physicalUnits && input.physicalUnits[0]?.registration_no
      ? input.physicalUnits[0].registration_no
      : input.registrationNo ?? null;

    const isVehicleUnavailableInput = input.status === "unavailable" || input.status === "blocked";
    let calculatedVehicleStatus = input.status ?? "available";

    if (input.physicalUnits && input.physicalUnits.length > 0) {
      const allUnitsUnavailable = input.physicalUnits.every(
        (u) => u.status === "unavailable" || u.status === "blocked"
      );
      if (allUnitsUnavailable || isVehicleUnavailableInput) {
        calculatedVehicleStatus = isVehicleUnavailableInput ? input.status! : "unavailable";
      } else if (input.physicalUnits.some((u) => u.status === "available")) {
        calculatedVehicleStatus = "available";
      }
    }

    const fields = {
      name: input.name,
      brand: input.brand,
      model: input.model,
      year: input.year ?? null,
      category_id: input.categoryId ?? null,
      branch_id: input.branchId ?? null,
      registration_no: primaryRegNo,
      cc: input.cc ?? null,
      fuel_type: input.fuelType ?? "Petrol",
      transmission: input.transmission ?? "Manual",
      seats: input.seats ?? 2,
      mileage: input.mileage ?? null,
      included_km: input.includedKm ?? 100,
      extra_km_rate: input.extraKmRate ?? 5,
      rate_12h: input.rate12h ?? 0,
      rate_24h: input.rate24h ?? 0,
      hourly_rate: input.hourlyRate ?? 0,
      deposit: input.deposit ?? 0,
      late_fee_per_hour: input.lateFeePerHour ?? 0,
      total_units: units,
      description: input.description ?? null,
      terms: input.terms ?? null,
      status: calculatedVehicleStatus,
      active: activeVal,
    };

    let vehicleId = input.id;

    if (vehicleId) {
      const updated = await sbUpdate("vehicles", `id=eq.${vehicleId}`, { ...fields, updated_at: nowIso() });
      if (!updated.ok) return fail(updated, "Saving the vehicle");
      if (updated.data.length === 0) return { ok: false as const, error: `Vehicle ${vehicleId} no longer exists.` };
      await logActivity(user.id, "vehicle_updated", "vehicle", vehicleId, { name: input.name });
    } else {
      const slug = `${slugify(input.name)}-${randomUUID().slice(0, 6)}`;
      const inserted = await sbInsert<{ id: number }>("vehicles", { slug, ...fields });
      if (!inserted.ok) return fail(inserted, "Creating the vehicle");
      vehicleId = Number(inserted.data.id);
      await logActivity(user.id, "vehicle_created", "vehicle", vehicleId, { name: input.name });
    }

    if (input.photoUrl) {
      const photo = await sbInsert("vehicle_photos", { vehicle_id: vehicleId, url: input.photoUrl, is_primary: 1 });
      if (!photo.ok) return fail(photo, "Saving the vehicle photo");
    }

    // Physical units synchronization & branch segregation
    try {
      const existingUnitsRes = await sbSelect<{ id: number; unit_identifier: string; registration_no: string | null; current_branch_id: number | null; status: string }>(
        "vehicle_units",
        `select=id,unit_identifier,registration_no,current_branch_id,status&vehicle_id=eq.${vehicleId}&active=eq.1&order=id.asc`
      );

      const existingUnits = existingUnitsRes.ok ? existingUnitsRes.data : [];
      const prefix = UPPER_SLUG(input.name);

      if (input.physicalUnits && input.physicalUnits.length > 0) {
        // Save units from the explicit physical units list
        for (let i = 0; i < units; i++) {
          const uInput = input.physicalUnits[i];
          const unitIdent = uInput?.unit_identifier?.trim() || `${prefix}-${String(i + 1).padStart(3, "0")}`;
          const regNo = uInput?.registration_no?.trim() || (i === 0 ? input.registrationNo ?? null : null);
          const branch = uInput?.current_branch_id ?? input.branchId ?? null;
          const status = isVehicleUnavailableInput
            ? input.status!
            : (uInput?.status || "available");

          if (i < existingUnits.length) {
            const existing = existingUnits[i];
            const branchChanged = existing.current_branch_id !== branch;

            await sbUpdate("vehicle_units", `id=eq.${existing.id}`, {
              unit_identifier: unitIdent,
              registration_no: regNo,
              current_branch_id: branch,
              status,
              updated_at: nowIso(),
            });

            if (branchChanged) {
              await sbUpdate("branch_allocations", `vehicle_unit_id=eq.${existing.id}&ends_at=is.null`, { ends_at: nowIso() });
              if (branch) {
                await sbInsert("branch_allocations", {
                  vehicle_unit_id: existing.id,
                  branch_id: branch,
                  starts_at: nowIso(),
                  ends_at: null,
                  notes: "Updated unit branch allocation",
                });
              }
            }
          } else {
            const newUnit = await sbInsert<{ id: number }>("vehicle_units", {
              vehicle_id: vehicleId,
              unit_identifier: unitIdent,
              registration_no: regNo,
              status,
              current_branch_id: branch,
              active: 1,
            });

            if (newUnit.ok && newUnit.data && branch) {
              await sbInsert("branch_allocations", {
                vehicle_unit_id: Number(newUnit.data.id),
                branch_id: branch,
                starts_at: nowIso(),
                ends_at: null,
                notes: "Initial unit creation allocation",
              });
            }
          }
        }

        // Deactivate excess units if totalUnits decreased
        if (existingUnits.length > units) {
          for (let i = units; i < existingUnits.length; i++) {
            const excess = existingUnits[i];
            await sbUpdate("branch_allocations", `vehicle_unit_id=eq.${excess.id}&ends_at=is.null`, { ends_at: nowIso() });
            await sbUpdate("vehicle_units", `id=eq.${excess.id}`, { active: 0, updated_at: nowIso() });
          }
        }
      } else {
        // Fallback: sync existing unit statuses if overall vehicle status changed
        if (existingUnits.length > 0 && isVehicleUnavailableInput) {
          await sbUpdate("vehicle_units", `vehicle_id=eq.${vehicleId}&active=eq.1`, {
            status: input.status,
            updated_at: nowIso(),
          });
        } else if (existingUnits.length > 0 && input.status === "available") {
          await sbUpdate("vehicle_units", `vehicle_id=eq.${vehicleId}&active=eq.1&status=eq.unavailable`, {
            status: "available",
            updated_at: nowIso(),
          });
        }

        if (existingUnits.length < units) {
          for (let i = existingUnits.length + 1; i <= units; i++) {
            const unitIdent = `${prefix}-${String(i).padStart(3, "0")}`;
            const newUnit = await sbInsert<{ id: number }>("vehicle_units", {
              vehicle_id: vehicleId,
              unit_identifier: unitIdent,
              registration_no: i === 1 ? input.registrationNo ?? null : null,
              status: input.status ?? "available",
              current_branch_id: input.branchId ?? null,
              active: 1,
            });

            if (newUnit.ok && newUnit.data && input.branchId) {
              await sbInsert("branch_allocations", {
                vehicle_unit_id: Number(newUnit.data.id),
                branch_id: input.branchId,
                starts_at: nowIso(),
                ends_at: null,
                notes: "Initial creation allocation",
              });
            }
          }
        }
      }
    } catch {
      // Non-critical if vehicle_units table is not yet migrated
    }

    await invalidateContentCaches();
    revalidatePath("/dashboard/vehicles");
    revalidatePath(`/dashboard/vehicles/${vehicleId}`);
    revalidatePath("/dashboard/allocations");
    revalidatePath("/dashboard/bookings");
    revalidatePath("/dashboard");
    revalidatePath("/vehicles");
    revalidatePath("/");
    return { ok: true as const, id: vehicleId };
  });
}

function UPPER_SLUG(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return clean.slice(0, 6) || "UNIT";
}

export async function deleteVehicle(id: number, idempotencyKey?: string) {
  return withIdempotency(idempotencyKey, "delete_vehicle", { id }, async () => {
    const user = await staffUser();
    assertCan(user, "admin");

    // Soft-delete vehicle: mark active = 0 and status = 'archived'
    // Preserves booking history, invoices, inspection history, and relationships
    const vehicle = await sbUpdate("vehicles", `id=eq.${id}`, {
      active: 0,
      status: "archived",
      updated_at: nowIso(),
    });
    if (!vehicle.ok) return fail(vehicle, "Archiving the vehicle");

    // Also deactivate associated physical units
    try {
      await sbUpdate("vehicle_units", `vehicle_id=eq.${id}`, {
        active: 0,
        status: "inactive",
        updated_at: nowIso(),
      });
      // Clear any pending unlinked reservation blocks for this vehicle
      await sbDelete("availability_blocks", `vehicle_id=eq.${id}&booking_id=is.null`);
    } catch {
      // Best-effort if table not present
    }

    await logActivity(user.id, "vehicle_deleted", "vehicle", id);
    await invalidateContentCaches();
    revalidatePath("/dashboard/vehicles");
    revalidatePath("/dashboard/vehicles/[id]", "page");
    revalidatePath("/dashboard/allocations");
    revalidatePath("/dashboard/problem-tickets");
    revalidatePath("/dashboard", "layout");
    revalidatePath("/");
    return { ok: true as const };
  });
}

export async function bulkUpdateUnitStatus(
  unitIds: number[],
  status: "available" | "unavailable" | "blocked",
  reason?: string
) {
  const user = await staffUser();
  assertCan(user, "staff");

  if (!unitIds || unitIds.length === 0) {
    return { ok: false as const, error: "Please select at least one vehicle unit." };
  }

  const effDate = nowIso();
  const idPredicate = `in.(${unitIds.join(",")})`;

  // 1. Update only the selected physical vehicle units
  const updateRes = await sbUpdate(
    "vehicle_units",
    `id=${encodeURIComponent(idPredicate)}`,
    {
      status,
      notes: reason ? reason.trim() : null,
      updated_at: effDate,
    }
  );

  if (!updateRes.ok) {
    return fail(updateRes, "Updating unit status");
  }

  // 2. Fetch affected vehicle_ids so we can sync parent vehicle status
  const unitsRes = await sbSelect<{ id: number; vehicle_id: number; status: string }>(
    "vehicle_units",
    `select=id,vehicle_id,status&id=${encodeURIComponent(idPredicate)}`
  );

  if (unitsRes.ok && unitsRes.data) {
    const parentVehicleIds = Array.from(new Set(unitsRes.data.map((u) => Number(u.vehicle_id))));

    for (const vId of parentVehicleIds) {
      const allUnitsRes = await sbSelect<{ id: number; status: string }>(
        "vehicle_units",
        `select=id,status&vehicle_id=eq.${vId}&active=eq.1`
      );

      if (allUnitsRes.ok && allUnitsRes.data) {
        const allUnits = allUnitsRes.data;
        const anyAvailable = allUnits.some((u) => u.status === "available");
        const newVehicleStatus = anyAvailable ? "available" : "unavailable";

        await sbUpdate("vehicles", `id=eq.${vId}`, {
          status: newVehicleStatus,
          updated_at: effDate,
        });
      }
    }
  }

  await logActivity(user.id, "bulk_units_status_updated", "vehicle_units", unitIds[0], {
    count: unitIds.length,
    unitIds,
    status,
    reason,
  });

  await invalidateContentCaches();
  revalidatePath("/dashboard/vehicles");
  revalidatePath("/dashboard/allocations");
  revalidatePath("/dashboard/bookings");
  revalidatePath("/dashboard");
  revalidatePath("/vehicles");
  revalidatePath("/");

  return { ok: true as const, count: unitIds.length };
}

export async function bulkUpdateVehicleStatus(
  vehicleIds: number[],
  status: "available" | "unavailable" | "blocked"
) {
  const user = await staffUser();
  assertCan(user, "staff");

  if (!vehicleIds || vehicleIds.length === 0) {
    return { ok: false as const, error: "Please select at least one vehicle." };
  }

  const effDate = nowIso();
  const idPredicate = `in.(${vehicleIds.join(",")})`;

  // Update vehicles table
  const updateRes = await sbUpdate(
    "vehicles",
    `id=${encodeURIComponent(idPredicate)}`,
    {
      status,
      updated_at: effDate,
    }
  );

  if (!updateRes.ok) {
    return fail(updateRes, "Updating vehicles status");
  }

  // Also update physical units for these vehicles
  await sbUpdate(
    "vehicle_units",
    `vehicle_id=${encodeURIComponent(idPredicate)}&active=eq.1`,
    {
      status,
      updated_at: effDate,
    }
  );

  await logActivity(user.id, "bulk_vehicles_status_updated", "vehicles", vehicleIds[0], {
    count: vehicleIds.length,
    vehicleIds,
    status,
  });

  await invalidateContentCaches();
  revalidatePath("/dashboard/vehicles");
  revalidatePath("/dashboard/allocations");
  revalidatePath("/dashboard/bookings");
  revalidatePath("/dashboard");
  revalidatePath("/vehicles");
  revalidatePath("/");

  return { ok: true as const, count: vehicleIds.length };
}

export async function transferVehicleUnit(input: {
  unitId: number;
  toBranchId: number;
  effectiveDate: string;
  reason?: string;
  idempotencyKey?: string;
}) {
  return withIdempotency(input.idempotencyKey, "transfer_vehicle_unit", input, async () => {
    const user = await staffUser();
    assertCan(user, "staff");

    const unitRes = await sbSelectOne<{ id: number; vehicle_id: number; current_branch_id: number | null; unit_identifier: string }>(
      "vehicle_units",
      `select=id,vehicle_id,current_branch_id,unit_identifier&id=eq.${input.unitId}&active=eq.1`
    );
    if (!unitRes.ok || !unitRes.data) {
      return { ok: false as const, error: "Vehicle unit not found." };
    }
    const unit = unitRes.data;

    const branchRes = await sbSelectOne<{ id: number; name: string; blocked: number }>(
      "branches",
      `select=id,name,blocked&id=eq.${input.toBranchId}&active=eq.1`
    );
    if (!branchRes.ok || !branchRes.data) {
      return { ok: false as const, error: "Target branch not found." };
    }

    const effDate = new Date(input.effectiveDate).toISOString();

    // Close previous open allocation
    await sbUpdate("branch_allocations", `vehicle_unit_id=eq.${unit.id}&ends_at=is.null`, { ends_at: effDate });

    // Insert new allocation
    const newAlloc = await sbInsert("branch_allocations", {
      vehicle_unit_id: unit.id,
      branch_id: input.toBranchId,
      starts_at: effDate,
      ends_at: null,
      notes: input.reason || "Branch transfer",
    });
    if (!newAlloc.ok) return fail(newAlloc, "Creating branch allocation");

    // Update current branch on unit
    await sbUpdate("vehicle_units", `id=eq.${unit.id}`, {
      current_branch_id: input.toBranchId,
      updated_at: nowIso(),
    });

    // Write audit record
    await sbInsert("branch_transfers", {
      vehicle_unit_id: unit.id,
      from_branch_id: unit.current_branch_id,
      to_branch_id: input.toBranchId,
      effective_date: effDate,
      reason: input.reason || null,
      performed_by: user.id,
    });

    await logActivity(user.id, "unit_transferred", "vehicle_unit", unit.id, {
      unit_identifier: unit.unit_identifier,
      to_branch: branchRes.data.name,
    });

    await invalidateContentCaches();
    refresh("/dashboard/allocations");
    refresh("/dashboard/vehicles");
    return { ok: true as const };
  });
}

export async function updateVehicleFleetAllocations(input: {
  vehicleId: number;
  branchAllocations: Array<{ branchId: number; quantity: number }>;
  effectiveDate?: string;
  reason?: string;
  idempotencyKey?: string;
}) {
  return withIdempotency(input.idempotencyKey, "update_vehicle_fleet_allocations", input, async () => {
    const user = await staffUser();
    assertCan(user, "staff");

    const vehicleRes = await sbSelectOne<{ id: number; name: string; total_units: number }>(
      "vehicles",
      `select=id,name,total_units&id=eq.${input.vehicleId}&active=eq.1`
    );
    if (!vehicleRes.ok || !vehicleRes.data) {
      return { ok: false as const, error: "Vehicle not found." };
    }
    const vehicle = vehicleRes.data;
    const totalUnits = Number(vehicle.total_units) || 1;

    // Validate quantities
    const sumAllocated = input.branchAllocations.reduce((sum, a) => sum + Math.max(0, Number(a.quantity) || 0), 0);
    if (sumAllocated > totalUnits) {
      return {
        ok: false as const,
        error: `Total allocated units (${sumAllocated}) cannot exceed vehicle total fleet units (${totalUnits}).`,
      };
    }

    const effDate = input.effectiveDate ? new Date(input.effectiveDate).toISOString() : nowIso();

    // Fetch existing active units for this vehicle
    const unitsRes = await sbSelect<{ id: number; unit_identifier: string; current_branch_id: number | null }>(
      "vehicle_units",
      `select=id,unit_identifier,current_branch_id&vehicle_id=eq.${input.vehicleId}&active=eq.1&order=id.asc`
    );
    const units = unitsRes.ok ? unitsRes.data : [];

    let unitIdx = 0;
    for (const alloc of input.branchAllocations) {
      const qty = Math.max(0, Number(alloc.quantity) || 0);
      for (let q = 0; q < qty && unitIdx < units.length; q++, unitIdx++) {
        const u = units[unitIdx];
        if (u.current_branch_id !== alloc.branchId) {
          // Close previous open allocation
          await sbUpdate("branch_allocations", `vehicle_unit_id=eq.${u.id}&ends_at=is.null`, { ends_at: effDate });
          // Insert new allocation
          await sbInsert("branch_allocations", {
            vehicle_unit_id: u.id,
            branch_id: alloc.branchId,
            starts_at: effDate,
            ends_at: null,
            notes: input.reason || "Fleet re-allocation update",
          });
          // Update unit
          await sbUpdate("vehicle_units", `id=eq.${u.id}`, { current_branch_id: alloc.branchId, updated_at: nowIso() });
          // Audit
          await sbInsert("branch_transfers", {
            vehicle_unit_id: u.id,
            from_branch_id: u.current_branch_id,
            to_branch_id: alloc.branchId,
            effective_date: effDate,
            reason: input.reason || "Bulk fleet re-allocation",
            performed_by: user.id,
          });
        }
      }
    }

    // Remaining units become unallocated (null branch)
    while (unitIdx < units.length) {
      const u = units[unitIdx++];
      if (u.current_branch_id !== null) {
        await sbUpdate("branch_allocations", `vehicle_unit_id=eq.${u.id}&ends_at=is.null`, { ends_at: effDate });
        await sbUpdate("vehicle_units", `id=eq.${u.id}`, { current_branch_id: null, updated_at: nowIso() });
        await sbInsert("branch_transfers", {
          vehicle_unit_id: u.id,
          from_branch_id: u.current_branch_id,
          to_branch_id: null,
          effective_date: effDate,
          reason: input.reason || "Unallocated fleet inventory",
          performed_by: user.id,
        });
      }
    }

    await logActivity(user.id, "fleet_reallocated", "vehicle", vehicle.id, {
      vehicle_name: vehicle.name,
      allocations: input.branchAllocations,
    });

    await invalidateContentCaches();
    refresh("/dashboard/allocations");
    refresh("/dashboard/vehicles");
    refresh("/");
    return { ok: true as const };
  });
}

export async function updateVehicleUnitDetails(input: {
  unitId: number;
  registrationNo?: string;
  status?: string;
  branchId?: number | null;
  effectiveDate?: string;
  notes?: string;
  idempotencyKey?: string;
}) {
  return withIdempotency(input.idempotencyKey, "update_vehicle_unit_details", input, async () => {
    const user = await staffUser();
    assertCan(user, "staff");

    const unitRes = await sbSelectOne<{ id: number; vehicle_id: number; current_branch_id: number | null; unit_identifier: string }>(
      "vehicle_units",
      `select=id,vehicle_id,current_branch_id,unit_identifier&id=eq.${input.unitId}&active=eq.1`
    );
    if (!unitRes.ok || !unitRes.data) {
      return { ok: false as const, error: "Vehicle unit not found." };
    }
    const unit = unitRes.data;

    const effDate = input.effectiveDate ? new Date(input.effectiveDate).toISOString() : nowIso();

    // If branch changed
    if (input.branchId !== undefined && input.branchId !== unit.current_branch_id) {
      // Close previous allocation
      await sbUpdate("branch_allocations", `vehicle_unit_id=eq.${unit.id}&ends_at=is.null`, { ends_at: effDate });
      if (input.branchId !== null) {
        await sbInsert("branch_allocations", {
          vehicle_unit_id: unit.id,
          branch_id: input.branchId,
          starts_at: effDate,
          ends_at: null,
          notes: input.notes || "Unit branch assignment edit",
        });
      }
      await sbInsert("branch_transfers", {
        vehicle_unit_id: unit.id,
        from_branch_id: unit.current_branch_id,
        to_branch_id: input.branchId,
        effective_date: effDate,
        reason: input.notes || "Unit edit",
        performed_by: user.id,
      });
    }

    const updates: Record<string, unknown> = {
      updated_at: nowIso(),
    };
    if (input.registrationNo !== undefined) updates.registration_no = input.registrationNo.trim().toUpperCase() || null;
    if (input.status !== undefined) updates.status = input.status;
    if (input.branchId !== undefined) updates.current_branch_id = input.branchId;

    const res = await sbUpdate("vehicle_units", `id=eq.${unit.id}`, updates);
    if (!res.ok) return fail(res, "Updating vehicle unit");

    // Sync parent vehicle status based on remaining available units
    const allUnitsRes = await sbSelect<{ id: number; status: string }>(
      "vehicle_units",
      `select=id,status&vehicle_id=eq.${unit.vehicle_id}&active=eq.1`
    );
    if (allUnitsRes.ok && allUnitsRes.data) {
      const anyAvailable = allUnitsRes.data.some((u) => u.status === "available");
      const parentVehicleStatus = anyAvailable ? "available" : "unavailable";
      await sbUpdate("vehicles", `id=eq.${unit.vehicle_id}`, {
        status: parentVehicleStatus,
        updated_at: effDate,
      });
    }

    await logActivity(user.id, "unit_updated", "vehicle_unit", unit.id, updates);
    await invalidateContentCaches();
    revalidatePath("/dashboard/allocations");
    revalidatePath("/dashboard/vehicles");
    revalidatePath(`/dashboard/vehicles/${unit.vehicle_id}`);
    revalidatePath("/dashboard/bookings");
    revalidatePath("/dashboard");
    revalidatePath("/vehicles");
    revalidatePath("/");
    return { ok: true as const };
  });
}

export async function addVehiclePhoto(vehicleId: number, url: string, isPrimary = false) {
  const user = await staffUser();
  assertCan(user, "staff");

  if (isPrimary) {
    const cleared = await sbUpdate("vehicle_photos", `vehicle_id=eq.${vehicleId}`, { is_primary: 0 });
    if (!cleared.ok) return fail(cleared, "Clearing the previous primary photo");
  }

  const inserted = await sbInsert("vehicle_photos", { vehicle_id: vehicleId, url, is_primary: isPrimary ? 1 : 0 });
  if (!inserted.ok) return fail(inserted, "Adding the photo");

  refresh("/");
  refresh();
  return { ok: true as const };
}

export async function removeVehiclePhoto(id: number) {
  const user = await staffUser();
  assertCan(user, "manager");

  const res = await sbDelete("vehicle_photos", `id=eq.${id}`);
  if (!res.ok) return fail(res, "Removing the photo");

  refresh("/");
  refresh();
  return { ok: true as const };
}

export async function saveVehicleCategory(input: { id?: number; name: string; kind: string; icon?: string; image?: string; shortDesc?: string; description?: string; active?: boolean; sort?: number }) {
  const user = await staffUser();
  assertCan(user, "admin");

  const fields = {
    name: input.name,
    kind: input.kind,
    icon: input.icon ?? null,
    image: input.image ?? null,
    short_desc: input.shortDesc ?? null,
    description: input.description ?? null,
    active: input.active === false ? 0 : 1,
    sort: input.sort ?? 0,
  };

  const res = input.id
    ? await sbUpdate("vehicle_categories", `id=eq.${input.id}`, fields)
    : await sbInsert("vehicle_categories", { slug: slugify(input.name), ...fields });
  if (!res.ok) return fail(res, "Saving the category");

  await logActivity(user.id, "category_saved", "vehicle_category", input.id ?? null, { name: input.name });
  refresh("/");
  refresh();
  return { ok: true as const };
}

export async function saveBranch(input: { id?: number; name: string; city?: string; address?: string; phone?: string; active?: boolean }) {
  const user = await staffUser();
  assertCan(user, "admin");

  const fields = {
    name: input.name,
    city: input.city ?? null,
    address: input.address ?? null,
    phone: input.phone ?? null,
    active: input.active === false ? 0 : 1,
  };

  const res = input.id ? await sbUpdate("branches", `id=eq.${input.id}`, fields) : await sbInsert("branches", fields);
  if (!res.ok) return fail(res, "Saving the branch");

  refresh();
  return { ok: true as const };
}

/**
 * Takes a whole branch in or out of service.
 *
 * Blocking sets available_units to zero for every vehicle at the branch, so the
 * public cards grey out and reserve_vehicle_slot refuses the claim in the database.
 * Nothing on the vehicles themselves is touched, so unblocking restores each one's
 * previous state exactly — a vehicle already in maintenance stays in maintenance.
 *
 * Existing bookings are deliberately left alone: this is an inventory control, not
 * a cancellation. Admin only, matching saveBranch.
 */
export async function setBranchBlocked(branchId: number, blocked: boolean, reason?: string) {
  const user = await staffUser();
  assertCan(user, "admin");

  const effDate = nowIso();

  // 1. Update the branch blocked flag
  const res = await sbUpdate("branches", `id=eq.${branchId}`, {
    blocked: blocked ? 1 : 0,
    blocked_at: blocked ? effDate : null,
    blocked_by: blocked ? user.id : null,
    blocked_reason: blocked ? (reason?.trim() || null) : null,
  });
  if (!res.ok) return fail(res, blocked ? "Blocking the branch" : "Unblocking the branch");

  // 2. Fetch all active units allocated to this branch
  const unitsRes = await sbSelect<{ id: number; vehicle_id: number; status: string }>(
    "vehicle_units",
    `select=id,vehicle_id,status&current_branch_id=eq.${branchId}&active=eq.1`
  );

  if (unitsRes.ok && unitsRes.data && unitsRes.data.length > 0) {
    const parentVehicleIds = Array.from(new Set(unitsRes.data.map((u) => Number(u.vehicle_id))));

    if (blocked) {
      // Mark all available units at this branch as 'blocked'
      await sbUpdate(
        "vehicle_units",
        `current_branch_id=eq.${branchId}&active=eq.1&status=eq.available`,
        {
          status: "blocked",
          notes: reason ? `Branch blocked: ${reason.trim()}` : "Branch temporarily blocked by admin",
          updated_at: effDate,
        }
      );
    } else {
      // Restore previously blocked units at this branch back to 'available'
      await sbUpdate(
        "vehicle_units",
        `current_branch_id=eq.${branchId}&active=eq.1&status=eq.blocked`,
        {
          status: "available",
          notes: "Branch unblocked by admin",
          updated_at: effDate,
        }
      );
    }

    // Sync parent vehicles: if all units of a vehicle are unavailable/blocked, mark vehicle as unavailable
    for (const vId of parentVehicleIds) {
      const allUnitsRes = await sbSelect<{ id: number; status: string }>(
        "vehicle_units",
        `select=id,status&vehicle_id=eq.${vId}&active=eq.1`
      );

      if (allUnitsRes.ok && allUnitsRes.data) {
        const anyAvailable = allUnitsRes.data.some((u) => u.status === "available");
        const newVehicleStatus = anyAvailable ? "available" : "unavailable";

        await sbUpdate("vehicles", `id=eq.${vId}`, {
          status: newVehicleStatus,
          updated_at: effDate,
        });
      }
    }
  }

  await logActivity(user.id, blocked ? "branch_blocked" : "branch_unblocked", "branch", branchId, { reason: reason ?? null });
  await invalidateContentCaches();
  revalidatePath("/dashboard/vehicles");
  revalidatePath("/dashboard/allocations");
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/bookings");
  revalidatePath("/dashboard");
  revalidatePath("/vehicles");
  revalidatePath("/");
  return { ok: true as const };
}

/* ------------------------------ Pricing rules ------------------------------ */

export async function savePricingRule(input: {
  id?: number; name: string; vehicleId?: number | null; categoryId?: number | null; dayType: string; startDate: string; endDate: string;
  rate24h?: number | null; rate12h?: number | null; deposit?: number | null; includedKm?: number | null; extraKmRate?: number | null;
  minDays?: number; priority?: number; active?: boolean;
}) {
  const user = await staffUser();
  assertCan(user, "admin");

  const fields = {
    name: input.name,
    vehicle_id: input.vehicleId ?? null,
    category_id: input.categoryId ?? null,
    day_type: input.dayType,
    start_date: input.startDate,
    end_date: input.endDate,
    rate_24h: input.rate24h ?? null,
    rate_12h: input.rate12h ?? null,
    deposit: input.deposit ?? null,
    included_km: input.includedKm ?? null,
    extra_km_rate: input.extraKmRate ?? null,
    min_days: input.minDays ?? 1,
    priority: input.priority ?? 0,
    active: input.active === false ? 0 : 1,
  };

  const res = input.id ? await sbUpdate("pricing_rules", `id=eq.${input.id}`, fields) : await sbInsert("pricing_rules", fields);
  if (!res.ok) return fail(res, "Saving the pricing rule");

  await logActivity(user.id, "pricing_rule_saved", "pricing_rule", input.id ?? null, { name: input.name });
  refresh();
  return { ok: true as const };
}

export async function deletePricingRule(id: number) {
  const user = await staffUser();
  assertCan(user, "admin");

  const res = await sbDelete("pricing_rules", `id=eq.${id}`);
  if (!res.ok) return fail(res, "Deleting the pricing rule");

  refresh();
  return { ok: true as const };
}

/* -------------------------------- Bookings --------------------------------- */

/** Shared tail for the several actions that flip a booking's status and log it. */
async function setBookingStatus(
  bookingId: number,
  status: string,
  patch: Record<string, unknown>,
  history: { userId: number; action: string; detail: unknown }
): Promise<ActionError | null> {
  const updated = await sbUpdate("bookings", `id=eq.${bookingId}`, { status, updated_at: nowIso(), ...patch });
  if (!updated.ok) return fail(updated, "Updating the booking");
  if (updated.data.length === 0) return { ok: false as const, error: `Booking ${bookingId} no longer exists.` };

  const logged = await sbInsert("booking_history", {
    booking_id: bookingId,
    user_id: history.userId,
    action: history.action,
    detail: JSON.stringify(history.detail),
  });
  if (!logged.ok) return fail(logged, "Recording the booking history");

  try {
    const { cacheInvalidatePrefix } = await import("./redis");
    await cacheInvalidatePrefix("web:gateway:");
    await cacheInvalidatePrefix("vehicles:");
    await cacheInvalidatePrefix("fleet:");
  } catch {}

  return null;
}

export async function updateBookingStatus(id: number, status: string) {
  const user = await staffUser();

  const before = await sbSelectOne<{ status: string }>("bookings", `select=status&id=eq.${id}`);
  if (!before.ok) return fail(before, "Reading the booking");
  if (!before.data) return { ok: false as const, error: `Booking ${id} no longer exists.` };
  const previous = before.data.status;

  const failed = await setBookingStatus(id, status, {}, { userId: user.id, action: "status_change", detail: { from: previous, to: status } });
  if (failed) return failed;

  await logActivity(user.id, "booking_status", "booking", id, { from: previous, to: status });

  if (status === "Confirmed") {
    const booking = await sbSelectOne<{
      booking_no: string;
      pickup_at: string;
      vehicles: { name: string } | null;
      customers: { name: string; phone: string | null } | null;
    }>("bookings", `select=booking_no,pickup_at,vehicles(name),customers(name,phone)&id=eq.${id}`);

    const row = booking.ok ? booking.data : null;
    if (row?.customers?.phone) {
      // Awaited: an un-awaited send never completes once the lambda freezes.
      await sendTemplate(
        "booking_confirmation",
        row.customers.phone,
        { name: row.customers.name, booking_no: row.booking_no, vehicle: row.vehicles?.name ?? "", pickup_at: row.pickup_at },
        null,
        id
      ).catch(() => null);
    }
  }

  refresh();
  return { ok: true as const };
}

export async function assignBookingManager(id: number, managerId: number | null) {
  const user = await staffUser();

  const res = await sbUpdate("bookings", `id=eq.${id}`, { manager_id: managerId, updated_at: nowIso() });
  if (!res.ok) return fail(res, "Assigning the booking manager");

  await logActivity(user.id, "booking_assigned", "booking", id, { manager_id: managerId });
  refresh();
  return { ok: true as const };
}

export async function approveAfterHours(id: number, approve: boolean, note?: string) {
  const user = await staffUser();
  assertCan(user, "manager");

  const existing = await sbSelectOne<{ notes: string | null }>("bookings", `select=notes&id=eq.${id}`);
  if (!existing.ok) return fail(existing, "Reading the booking");
  if (!existing.data) return { ok: false as const, error: `Booking ${id} no longer exists.` };

  const line = `After-hours pickup ${approve ? "approved" : "declined"}${note ? `: ${note}` : ""}`;
  const notes = existing.data.notes ? `${existing.data.notes}\n${line}` : line;

  const res = await sbUpdate("bookings", `id=eq.${id}`, {
    after_hours_approved_by: approve ? user.id : null,
    notes,
    updated_at: nowIso(),
  });
  if (!res.ok) return fail(res, "Recording the after-hours decision");

  await logActivity(user.id, "after_hours_decision", "booking", id, { approve, note });
  refresh();
  return { ok: true as const };
}

export async function addManualAdjustment(input: { bookingId: number; type: string; amount: number; reason: string }) {
  const user = await staffUser();
  assertCan(user, "manager");

  const inserted = await sbInsert("manual_adjustments", {
    booking_id: input.bookingId,
    type: input.type,
    amount: input.amount,
    reason: input.reason,
    employee_id: user.id,
    approved_by: user.id,
  });
  if (!inserted.ok) return fail(inserted, "Saving the adjustment");

  const field = input.type === "damage_charge" ? "damage_amount" : input.type.startsWith("late_fee") ? "late_fee_amount" : "other_fees_amount";

  // The per-category bucket has no dedicated Postgres accumulator, so it stays a
  // read-modify-write; `total_amount` — the one two staff can race on — goes through
  // the atomic RPC.
  const current = await sbSelectOne<Record<string, unknown>>("bookings", `select=${field}&id=eq.${input.bookingId}`);
  if (!current.ok) return fail(current, "Reading the booking totals");
  if (!current.data) return { ok: false as const, error: `Booking ${input.bookingId} no longer exists.` };

  const bucket = await sbUpdate("bookings", `id=eq.${input.bookingId}`, {
    [field]: num(current.data[field]) + input.amount,
    updated_at: nowIso(),
  });
  if (!bucket.ok) return fail(bucket, "Updating the booking charges");

  const total = await sbRpc("increment_booking_total", { p_booking_id: input.bookingId, p_amount: input.amount });
  if (!total.ok) return fail(total, "Updating the booking total");

  await logActivity(user.id, "manual_adjustment", "booking", input.bookingId, input);
  refresh();
  return { ok: true as const };
}

/* ------------------------------- Inspections -------------------------------- */

export async function recordInspection(input: {
  bookingId: number; kind: "handover" | "return"; odometer?: number; fuelLevel?: string; notes?: string;
  photos: Array<{ side: string; url: string; notes?: string }>;
  geo?: { lat: number; lng: number; accuracyM?: number } | null;
}) {
  const user = await staffUser();

  const inspection = await sbInsert<{ id: number }>("inspections", {
    booking_id: input.bookingId,
    kind: input.kind,
    employee_id: user.id,
    odometer: input.odometer ?? null,
    fuel_level: input.fuelLevel ?? null,
    notes: input.notes ?? null,
    // Best-effort: geolocation may be denied, unavailable, or absent (desktop CRM
    // without a GPS). Never block the inspection on it — just record what we have.
    geo_lat: input.geo?.lat ?? null,
    geo_lng: input.geo?.lng ?? null,
    geo_accuracy_m: input.geo?.accuracyM ?? null,
  });
  if (!inspection.ok) return fail(inspection, "Recording the inspection");
  const inspectionId = Number(inspection.data.id);

  if (input.photos.length > 0) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { getWritableUploadsDir } = await import("./uploads-dir");
    const { supabaseAdmin } = await import("./supabase");

    const processedPhotos = await Promise.all(
      input.photos.map(async (p) => {
        let finalUrl = p.url;
        if (p.url && typeof p.url === "string" && p.url.startsWith("data:image/")) {
          try {
            const match = p.url.match(/^data:image\/([a-z0-9+]+);base64,(.+)$/i);
            if (match && match[2]) {
              const ext = match[1] === "jpeg" ? "jpg" : match[1];
              const buf = Buffer.from(match[2], "base64");
              const dateStr = new Date().toISOString().slice(0, 7);
              const fileName = `inspection_${p.side}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
              const targetSubfolder = `inspections/${dateStr}`;
              const baseUploadDir = getWritableUploadsDir();
              const localTargetDir = path.join(baseUploadDir, targetSubfolder);
              fs.mkdirSync(localTargetDir, { recursive: true });
              fs.writeFileSync(path.join(localTargetDir, fileName), buf);

              finalUrl = `/api/files/${targetSubfolder}/${fileName}`;

              if (supabaseAdmin) {
                try {
                  const { data: uploadData } = await supabaseAdmin.storage
                    .from("vehicle-photos")
                    .upload(`${targetSubfolder}/${fileName}`, buf, { contentType: `image/${match[1]}`, upsert: true });
                  if (uploadData) {
                    const { data: pubUrl } = supabaseAdmin.storage.from("vehicle-photos").getPublicUrl(`${targetSubfolder}/${fileName}`);
                    if (pubUrl?.publicUrl) finalUrl = pubUrl.publicUrl;
                  }
                } catch {}
              }
            }
          } catch (e) {
            console.error("Base64 photo persist error:", e);
          }
        }
        return { inspection_id: inspectionId, side: p.side, url: finalUrl, notes: p.notes ?? null };
      })
    );

    const photos = await sbInsert("inspection_photos", processedPhotos);
    if (!photos.ok) return fail(photos, "Saving the inspection photos");
  }

  const booking = await sbSelectOne<{ vehicle_id: number | null; return_at: string; start_odometer: number | string | null; included_km: number }>(
    "bookings",
    `select=vehicle_id,return_at,start_odometer,included_km&id=eq.${input.bookingId}`
  );
  if (!booking.ok) return fail(booking, "Reading the booking");
  if (!booking.data) return { ok: false as const, error: `Booking ${input.bookingId} no longer exists.` };
  const vehicleId = booking.data.vehicle_id;

  if (input.kind === "handover") {
    const updated = await sbUpdate("bookings", `id=eq.${input.bookingId}`, {
      status: "Vehicle handed over",
      actual_pickup_at: nowIso(),
      start_odometer: input.odometer ?? null,
      updated_at: nowIso(),
    });
    if (!updated.ok) return fail(updated, "Updating the booking");

    if (vehicleId) {
      const vehicle = await sbUpdate("vehicles", `id=eq.${vehicleId}`, { status: "booked", updated_at: nowIso() });
      if (!vehicle.ok) return fail(vehicle, "Updating the vehicle status");
    }
  } else {
    const vehicle = vehicleId
      ? await sbSelectOne<{ rate_24h: string | number; extra_km_rate: string | number }>("vehicles", `select=rate_24h,extra_km_rate&id=eq.${vehicleId}`)
      : null;
    if (vehicle && !vehicle.ok) return fail(vehicle, "Reading the vehicle");

    // NUMERIC arrives from PostgREST as a string; `num()` before any arithmetic.
    const rate24h = vehicle?.ok && vehicle.data ? num(vehicle.data.rate_24h, 900) : 900;
    const extraKmRate = vehicle?.ok && vehicle.data ? num(vehicle.data.extra_km_rate) : 0;

    const late = calculateLateFee(new Date(booking.data.return_at), new Date(), rate24h);
    const startOdo = booking.data.start_odometer;
    const km = input.odometer != null && startOdo != null
      ? calculateExtraKm(num(booking.data.included_km), num(startOdo), input.odometer, extraKmRate)
      : { extraKm: 0, amount: 0 };

    const updated = await sbUpdate("bookings", `id=eq.${input.bookingId}`, {
      status: "Inspection pending",
      actual_return_at: nowIso(),
      end_odometer: input.odometer ?? null,
      late_fee_amount: late.fee,
      extra_km_amount: km.amount,
      updated_at: nowIso(),
    });
    if (!updated.ok) return fail(updated, "Updating the booking");

    const total = await sbRpc("increment_booking_total", { p_booking_id: input.bookingId, p_amount: late.fee + km.amount });
    if (!total.ok) return fail(total, "Updating the booking total");

    if (vehicleId) {
      const freed = await sbUpdate("vehicles", `id=eq.${vehicleId}`, { status: "available", updated_at: nowIso() });
      if (!freed.ok) return fail(freed, "Updating the vehicle status");
    }

    const history = await sbInsert("booking_history", {
      booking_id: input.bookingId,
      user_id: user.id,
      action: "return_inspection",
      detail: JSON.stringify({ lateFee: late, extraKm: km }),
    });
    if (!history.ok) return fail(history, "Recording the booking history");
  }

  await logActivity(user.id, `inspection_${input.kind}`, "booking", input.bookingId, { inspection_id: inspectionId });
  refresh();
  return { ok: true as const, inspectionId };
}

export async function addDamageReport(input: { bookingId: number; inspectionId?: number | null; description: string; chargeAmount: number }) {
  const user = await staffUser();
  assertCan(user, "manager");

  const report = await sbInsert("damage_reports", {
    booking_id: input.bookingId,
    inspection_id: input.inspectionId ?? null,
    description: input.description,
    charge_amount: input.chargeAmount,
    approved_by: user.id,
  });
  if (!report.ok) return fail(report, "Saving the damage report");

  const current = await sbSelectOne<{ damage_amount: string | number }>("bookings", `select=damage_amount&id=eq.${input.bookingId}`);
  if (!current.ok) return fail(current, "Reading the booking totals");
  if (!current.data) return { ok: false as const, error: `Booking ${input.bookingId} no longer exists.` };

  const bucket = await sbUpdate("bookings", `id=eq.${input.bookingId}`, {
    damage_amount: num(current.data.damage_amount) + input.chargeAmount,
    updated_at: nowIso(),
  });
  if (!bucket.ok) return fail(bucket, "Updating the damage charges");

  const total = await sbRpc("increment_booking_total", { p_booking_id: input.bookingId, p_amount: input.chargeAmount });
  if (!total.ok) return fail(total, "Updating the booking total");

  await logActivity(user.id, "damage_report", "booking", input.bookingId, input);
  refresh();
  return { ok: true as const };
}

/* --------------------------------- Payments --------------------------------- */

export async function addPayment(input: { bookingId: number; amount: number; kind?: string; method?: string; dueDate?: string; notes?: string }) {
  const user = await staffUser();

  const booking = await sbSelectOne<{ customer_id: number | null }>("bookings", `select=customer_id&id=eq.${input.bookingId}`);
  if (!booking.ok) return fail(booking, "Reading the booking");
  if (!booking.data) return { ok: false as const, error: `Booking ${input.bookingId} no longer exists.` };

  const payment = await insertWithNumber<{ id: number }>("payments", "payment_no", "PY", {
    booking_id: input.bookingId,
    customer_id: booking.data.customer_id,
    amount: input.amount,
    kind: input.kind ?? "advance",
    method: input.method ?? null,
    due_date: input.dueDate ?? null,
    status: "Pending",
    notes: input.notes ?? null,
  });
  if (!payment.ok) return fail(payment, "Creating the payment");

  await logActivity(user.id, "payment_created", "booking", input.bookingId, { amount: input.amount });
  refresh();
  return { ok: true as const };
}

export async function markPaymentPaid(id: number, gatewayRef?: string) {
  const user = await staffUser();

  const existing = await sbSelectOne<{
    payment_no: string; booking_id: number | null; customer_id: number | null; amount: string | number; gateway_ref: string | null; status: string;
  }>("payments", `select=payment_no,booking_id,customer_id,amount,gateway_ref,status&id=eq.${id}`);
  if (!existing.ok) return fail(existing, "Reading the payment");
  if (!existing.data) return { ok: false as const, error: `Payment ${id} no longer exists.` };

  const payment = existing.data;
  const amount = num(payment.amount);
  // Derived from the payment's own id, so two lambdas cannot mint the same receipt
  // number against the UNIQUE receipt_no column.
  const receiptNo = docNumber("RC", id);

  const updated = await sbUpdate("payments", `id=eq.${id}&status=neq.Paid`, {
    status: "Paid",
    paid_at: nowIso(),
    receipt_no: receiptNo,
    gateway_ref: gatewayRef ?? payment.gateway_ref,
  });
  if (!updated.ok) return fail(updated, "Marking the payment paid");
  // The `status=neq.Paid` filter makes this idempotent: a second click matches nothing
  // and must not increment paid_amount a second time.
  if (updated.data.length === 0) return { ok: false as const, error: "This payment has already been marked paid." };

  if (payment.booking_id) {
    const applied = await sbRpc("increment_booking_paid", { p_booking_id: payment.booking_id, p_amount: amount });
    if (!applied.ok) return fail(applied, "Applying the payment to the booking");
  }

  if (payment.customer_id) {
    const customer = await sbSelectOne<{ phone: string | null; name: string }>("customers", `select=phone,name&id=eq.${payment.customer_id}`);
    if (customer.ok && customer.data?.phone) {
      await sendTemplate(
        "invoice_generated",
        customer.data.phone,
        {
          name: customer.data.name,
          amount: `₹${amount.toLocaleString("en-IN")}`,
          total: `₹${amount.toLocaleString("en-IN")}`,
          booking_no: payment.payment_no,
        },
        null,
        payment.booking_id
      ).catch(() => null);
    }
  }

  await logActivity(user.id, "payment_paid", "payment", id, { amount, receipt: receiptNo });
  refresh();
  return { ok: true as const };
}

/* --------------------------------- Refunds ----------------------------------- */

export async function decideRefund(id: number, decision: "Approved" | "Rejected" | "Partially approved", approvedAmount?: number, notes?: string) {
  const user = await staffUser();
  assertCan(user, "manager");

  const res = await sbUpdate("refunds", `id=eq.${id}`, {
    status: decision,
    approved_amount: approvedAmount ?? null,
    admin_notes: notes ?? null,
    approved_at: nowIso(),
  });
  if (!res.ok) return fail(res, "Recording the refund decision");

  await logActivity(user.id, "refund_decision", "refund", id, { decision, approvedAmount });
  refresh();
  return { ok: true as const };
}

export async function completeRefund(id: number, method: string, transactionRef: string) {
  const user = await staffUser();
  assertCan(user, "finance");

  const updated = await sbUpdate<{ booking_id: number; approved_amount: string | number | null; customer_id: number | null }>(
    "refunds",
    `id=eq.${id}`,
    { status: "Completed", method, transaction_ref: transactionRef, completed_at: nowIso() }
  );
  if (!updated.ok) return fail(updated, "Completing the refund");

  const refund = updated.data[0];
  if (refund?.customer_id) {
    const customer = await sbSelectOne<{ phone: string | null; name: string }>("customers", `select=phone,name&id=eq.${refund.customer_id}`);
    if (customer.ok && customer.data?.phone) {
      await sendTemplate(
        "refund_completed",
        customer.data.phone,
        {
          name: customer.data.name,
          amount: `₹${num(refund.approved_amount).toLocaleString("en-IN")}`,
          transaction_ref: transactionRef,
          booking_no: String(refund.booking_id),
        },
        null,
        refund.booking_id
      ).catch(() => null);
    }
  }

  await logActivity(user.id, "refund_completed", "refund", id, { method, transactionRef });
  refresh();
  return { ok: true as const };
}

export async function processOnlineRazorpayRefund(refundId: number): Promise<{ ok: true; refundId: string } | { ok: false; error: string }> {
  const user = await staffUser();
  assertCan(user, "finance");

  const refundRes = await sbSelectOne<{
    id: number; booking_id: number; status: string; approved_amount: string | number | null; requested_amount: string | number;
  }>("refunds", `select=id,booking_id,status,approved_amount,requested_amount&id=eq.${refundId}`);
  if (!refundRes.ok) return { ok: false, error: refundRes.error };
  const refund = refundRes.data;
  if (!refund) return { ok: false, error: "Refund not found." };

  // Guard against double refunds. Without this, two staff clicks issue two real
  // Razorpay refunds against the same payment — actual money out the door twice.
  if (refund.status === "Completed") {
    return { ok: false, error: "This refund has already been processed." };
  }

  // Prefer the dedicated column; fall back to the legacy free-text note only if absent.
  const paid = await sbSelect<{ razorpay_payment_id: string | null; notes: string | null }>(
    "payments",
    `select=razorpay_payment_id,notes&booking_id=eq.${refund.booking_id}&status=eq.Paid&order=id.desc`
  );
  if (!paid.ok) return { ok: false, error: paid.error };

  const razorpayPaymentId =
    paid.data.find((p) => p.razorpay_payment_id?.trim())?.razorpay_payment_id?.trim() ||
    (paid.data.find((p) => p.notes?.startsWith("Razorpay payment ID:"))?.notes ?? "").replace("Razorpay payment ID: ", "").trim();

  if (!razorpayPaymentId) {
    return { ok: false, error: "No paid Razorpay transaction found for this booking refund." };
  }

  // Claim the refund in a single UPDATE so two concurrent requests cannot both proceed.
  // PostgREST returns the affected rows, so an empty array means somebody else won.
  const claimFilter = `id=eq.${refundId}&status=not.in.${encodeURIComponent('("Completed","Processing")')}`;
  const claimed = await sbUpdate("refunds", claimFilter, { status: "Processing" });
  if (!claimed.ok) return { ok: false, error: claimed.error };
  if (claimed.data.length === 0) return { ok: false, error: "This refund is already being processed." };

  const amountToRefund = num(refund.approved_amount ?? refund.requested_amount);

  const result = await issueRazorpayRefund({
    razorpayPaymentId,
    amountInRupees: amountToRefund,
    notes: { refund_id: String(refund.id), booking_id: String(refund.booking_id) },
  });

  if (!result.ok) {
    // Release the claim, otherwise a gateway hiccup wedges the refund in "Processing".
    await sbUpdate("refunds", `id=eq.${refundId}&status=eq.Processing`, { status: "Approved" });
    return { ok: false, error: result.error };
  }

  const completed = await sbUpdate("refunds", `id=eq.${refundId}`, {
    status: "Completed",
    method: "Razorpay",
    transaction_ref: result.refundId,
    completed_at: nowIso(),
  });
  if (!completed.ok) {
    // The money left the account; surfacing the id lets someone reconcile by hand.
    return { ok: false, error: `Razorpay refund ${result.refundId} succeeded but the record could not be updated: ${completed.error}` };
  }

  await logActivity(user.id, "razorpay_refund_processed", "refund", refundId, { refundId: result.refundId, amount: amountToRefund });
  refresh();
  return { ok: true, refundId: result.refundId };
}


/* ------------------------------ Problem tickets ------------------------------ */

export async function updateProblemTicket(id: number, patch: { status?: string; assignedTo?: number | null; replacementVehicleId?: number | null; resolutionNotes?: string }) {
  const user = await staffUser();

  // COALESCE(?, col) in SQL meant "leave alone when null"; over PostgREST the same
  // thing is expressed by simply omitting the key from the patch body.
  const body: Record<string, unknown> = {};
  if (patch.status != null) body.status = patch.status;
  if (patch.assignedTo != null) body.assigned_to = patch.assignedTo;
  if (patch.replacementVehicleId != null) body.replacement_vehicle_id = patch.replacementVehicleId;
  if (patch.resolutionNotes != null) body.resolution_notes = patch.resolutionNotes;
  if (patch.status === "Resolved") body.resolved_at = nowIso();

  if (Object.keys(body).length > 0) {
    const res = await sbUpdate("problem_tickets", `id=eq.${id}`, body);
    if (!res.ok) return fail(res, "Updating the ticket");
  }

  await logActivity(user.id, "problem_ticket_updated", "problem_ticket", id, patch);

  if (patch.status === "Resolved") {
    const row = await sbSelectOne<{
      ticket_no: string;
      resolution_notes: string | null;
      customers: { name: string | null; phone: string | null } | null;
      bookings: { booking_no: string } | null;
    }>("problem_tickets", `select=ticket_no,resolution_notes,customers(name,phone),bookings(booking_no)&id=eq.${id}`);

    const ticket = row.ok ? row.data : null;
    if (ticket?.customers?.phone) {
      // Best-effort — the ticket status is already updated regardless.
      await sendTemplate(
        "problem_ticket_resolved",
        ticket.customers.phone,
        {
          name: ticket.customers.name ?? "",
          ticket_no: ticket.ticket_no,
          booking_no: ticket.bookings?.booking_no ?? "",
          notes: ticket.resolution_notes ?? "",
        },
        null,
        null
      ).catch(() => null);
    }
  }

  refresh();
  return { ok: true as const };
}

/* -------------------------------- Settings ---------------------------------- */

export async function saveBusinessInfo(info: Record<string, unknown>) {
  const user = await staffUser();
  assertCan(user, "admin");

  // `setSetting` is async and throws on failure; it used to be called un-awaited,
  // so a rejected write surfaced as an unhandled rejection long after the response.
  try {
    await setSetting("business", info);
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Could not save the business information." };
  }

  await logActivity(user.id, "settings_updated", "settings", null, { key: "business" });
  refresh("/");
  refresh();
  return { ok: true as const };
}

export async function saveSetting(key: string, value: unknown) {
  const user = await staffUser();
  assertCan(user, "admin");

  try {
    await setSetting(key, value);
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : `Could not save the setting "${key}".` };
  }

  await logActivity(user.id, "settings_updated", "settings", null, { key });
  refresh();
  return { ok: true as const };
}

export async function saveTemplate(id: number | null, input: { key: string; name: string; channel: string; subject?: string; body: string; active?: boolean }) {
  const user = await staffUser();
  assertCan(user, "admin");

  const fields = {
    name: input.name,
    channel: input.channel,
    subject: input.subject ?? null,
    body: input.body,
    active: input.active ? 1 : 0,
  };

  const res = id ? await sbUpdate("message_templates", `id=eq.${id}`, fields) : await sbInsert("message_templates", { key: input.key, ...fields });
  if (!res.ok) return fail(res, "Saving the template");

  await logActivity(user.id, "template_saved", "settings", null, { key: input.key });
  refresh();
  return { ok: true as const };
}

export async function saveTestimonial(input: { id?: number; name: string; vehicle?: string; location?: string; rating?: number; quote: string; active?: boolean }) {
  const user = await staffUser();
  assertCan(user, "admin");

  const fields = {
    name: input.name,
    vehicle: input.vehicle ?? null,
    location: input.location ?? null,
    rating: input.rating ?? 5,
    quote: input.quote,
  };

  const res = input.id
    ? await sbUpdate("testimonials", `id=eq.${input.id}`, { ...fields, active: input.active ? 1 : 0 })
    : await sbInsert("testimonials", { ...fields, active: 1 });
  if (!res.ok) return fail(res, "Saving the testimonial");

  await logActivity(user.id, "testimonial_saved", "settings", null, { name: input.name });
  refresh("/");
  refresh();
  return { ok: true as const };
}

export async function saveUser(input: {
  id?: number;
  name: string;
  email: string;
  phone?: string;
  role: string;
  branch?: string;
  permissions?: string[];
  password?: string;
  active?: boolean;
}) {
  const admin = await adminUser();
  const { hashPassword } = await import("./auth");
  const { supabaseAdmin } = await import("./supabase");

  const emailClean = input.email.toLowerCase().trim();
  // is_active is INTEGER 1/0 in the schema.
  const isActive = input.active !== undefined ? (input.active ? 1 : 0) : 1;
  const now = nowIso();

  let targetId = input.id;
  let actionName = "created";
  let leftAt: string | null = null;

  const fields: Record<string, unknown> = {
    name: input.name,
    email: emailClean,
    phone: input.phone ?? null,
    role: input.role,
    branch: input.branch ?? null,
    is_active: isActive,
  };
  if (input.permissions) {
    fields.permissions = JSON.stringify(input.permissions);
  }
  if (input.password) fields.password_hash = hashPassword(input.password);

  if (targetId) {
    const existing = await sbSelectOne<{ is_active: number; left_at: string | null }>("users", `select=is_active,left_at&id=eq.${targetId}`);
    if (!existing.ok) return fail(existing, "Reading the staff member");
    if (!existing.data) return { ok: false as const, error: `Staff member ${targetId} no longer exists.` };

    if (num(existing.data.is_active) === 1 && isActive === 0) {
      leftAt = now;
      actionName = "deactivated";
    } else if (num(existing.data.is_active) === 0 && isActive === 1) {
      leftAt = null;
      actionName = "reactivated";
    } else {
      leftAt = existing.data.left_at ?? null;
      actionName = "updated";
    }

    const updated = await sbUpdate("users", `id=eq.${targetId}`, { ...fields, left_at: leftAt });
    if (!updated.ok) return fail(updated, "Saving the staff member");
  } else {
    actionName = "created";
    if (!fields.password_hash) fields.password_hash = hashPassword("StaffPass123!");

    // Upsert on the UNIQUE email so re-adding a previously-created address updates
    // that row instead of failing on the constraint.
    const created = await sbUpsert<{ id: number }>("users", { ...fields, left_at: null }, "email");
    if (!created.ok) return fail(created, "Creating the staff member");
    targetId = Number(created.data.id);
  }

  // Supabase Auth is a separate system from the users table; keep the credential in sync.
  if (supabaseAdmin && input.password) {
    try {
      const { data: list } = await supabaseAdmin.auth.admin.listUsers();
      const existingAuth = list?.users.find((u) => u.email === emailClean);
      if (existingAuth) {
        await supabaseAdmin.auth.admin.updateUserById(existingAuth.id, {
          password: input.password,
          user_metadata: { name: input.name, role: input.role, branch: input.branch },
        });
      } else {
        await supabaseAdmin.auth.admin.createUser({
          email: emailClean,
          password: input.password,
          email_confirm: true,
          user_metadata: { name: input.name, role: input.role, branch: input.branch },
        });
      }
    } catch (err) {
      console.error("Supabase auth sync warning:", err instanceof Error ? err.message : err);
    }
  }

  const history = await sbInsert("staff_history", {
    staff_id: targetId,
    action: actionName,
    performed_by: admin.id,
    detail: JSON.stringify({
      name: input.name,
      email: emailClean,
      role: input.role,
      is_active: isActive,
      left_at: leftAt,
      performed_by_name: admin.name,
    }),
  });
  if (!history.ok) return fail(history, "Recording the staff history");

  await logActivity(admin.id, `staff_${actionName}`, "user", targetId, { email: emailClean, left_at: leftAt });
  refresh();
  return { ok: true as const, id: targetId };
}

/* --------------------------- Website content ------------------------------ */

export async function saveGalleryItem(input: { id?: number; title?: string; image: string; category?: string }) {
  const user = await staffUser();
  assertCan(user, "admin");

  const fields = { title: input.title ?? null, image: input.image, category: input.category ?? null };
  const res = input.id ? await sbUpdate("gallery", `id=eq.${input.id}`, fields) : await sbInsert("gallery", fields);
  if (!res.ok) return fail(res, "Saving the gallery item");

  refresh("/");
  refresh();
  return { ok: true as const };
}

export async function saveFaq(input: { id?: number; question: string; answer: string; active?: boolean }) {
  const user = await staffUser();
  assertCan(user, "admin");

  const res = input.id
    ? await sbUpdate("faqs", `id=eq.${input.id}`, { question: input.question, answer: input.answer, active: input.active ? 1 : 0 })
    : await sbInsert("faqs", { question: input.question, answer: input.answer, active: 1 });
  if (!res.ok) return fail(res, "Saving the FAQ");

  refresh("/");
  refresh();
  return { ok: true as const };
}

export async function saveBlogPost(input: { id?: number; title: string; excerpt?: string; content: string; published?: boolean }) {
  const user = await staffUser();
  assertCan(user, "admin");

  const res = input.id
    ? await sbUpdate("blog_posts", `id=eq.${input.id}`, {
        title: input.title,
        excerpt: input.excerpt ?? null,
        content: input.content,
        published: input.published ? 1 : 0,
      })
    : await sbInsert("blog_posts", {
        slug: slugify(input.title),
        title: input.title,
        excerpt: input.excerpt ?? null,
        content: input.content,
        published: 1,
      });
  if (!res.ok) return fail(res, "Saving the blog post");

  refresh("/");
  refresh();
  return { ok: true as const };
}

/* -------------------- Customer Document Verification --------------------- */

export async function verifyCustomerDocument(input: { documentId: number; approve: boolean; notes?: string }) {
  const staff = await staffUser();

  // customer_documents.verified is INTEGER 1/0.
  const verifiedVal = input.approve ? 1 : 0;
  const updated = await sbUpdate<{ booking_id: number | null; kind: string; customer_id: number | null }>(
    "customer_documents",
    `id=eq.${input.documentId}`,
    { verified: verifiedVal, verified_by: staff.id }
  );
  if (!updated.ok) return fail(updated, "Verifying the document");
  if (updated.data.length === 0) return { ok: false as const, error: `Document ${input.documentId} no longer exists.` };

  const doc = updated.data[0];
  if (doc.booking_id) {
    const history = await sbInsert("booking_history", {
      booking_id: doc.booking_id,
      user_id: staff.id,
      action: input.approve ? "document_verified" : "document_rejected",
      detail: JSON.stringify({ kind: doc.kind, staff_name: staff.name, notes: input.notes }),
    });
    if (!history.ok) return fail(history, "Recording the booking history");
  }

  await logActivity(staff.id, input.approve ? "doc_verified" : "doc_rejected", "customer_documents", input.documentId);
  refresh();
  return { ok: true as const };
}

export async function rejectBooking(input: { bookingId: number; reason: string; notes?: string }) {
  const staff = await staffUser();

  const fullReason = input.notes ? `${input.reason} — ${input.notes}` : input.reason;
  const failed = await setBookingStatus(
    input.bookingId,
    "Rejected",
    { notes: fullReason },
    { userId: staff.id, action: "rejected", detail: { staff_name: staff.name, reason: input.reason, notes: input.notes ?? null, new_status: "Rejected" } }
  );
  if (failed) return failed;

  await logActivity(staff.id, "booking_rejected", "booking", input.bookingId);
  refresh();
  return { ok: true as const };
}

export async function reopenBooking(bookingId: number) {
  const staff = await staffUser();

  const restoredStatus = "Pending verification";
  const failed = await setBookingStatus(
    bookingId,
    restoredStatus,
    {},
    { userId: staff.id, action: "booking_reopened", detail: { staff_name: staff.name, restored_status: restoredStatus } }
  );
  if (failed) return failed;

  await logActivity(staff.id, "booking_reopened", "booking", bookingId);
  refresh();
  return { ok: true as const };
}

export async function quickApproveBooking(input: { bookingId: number; approve: boolean; notes?: string }) {
  const staff = await staffUser();

  const newStatus = input.approve ? "Confirmed" : "Rejected";
  const failed = await setBookingStatus(
    input.bookingId,
    newStatus,
    {},
    {
      userId: staff.id,
      action: input.approve ? "quick_approved" : "quick_rejected",
      detail: { staff_name: staff.name, notes: input.notes ?? null, new_status: newStatus },
    }
  );
  if (failed) return failed;

  await logActivity(staff.id, input.approve ? "booking_approved" : "booking_rejected", "booking", input.bookingId);
  refresh();
  return { ok: true as const };
}

export async function revertBookingDecision(bookingId: number) {
  const staff = await staffUser();

  const restoredStatus = "Pending verification";
  const failed = await setBookingStatus(
    bookingId,
    restoredStatus,
    {},
    { userId: staff.id, action: "decision_reverted", detail: { staff_name: staff.name, restored_status: restoredStatus } }
  );
  if (failed) return failed;

  await logActivity(staff.id, "booking_decision_reverted", "booking", bookingId);
  refresh();
  return { ok: true as const };
}

export async function revertDocumentDecision(documentId: number) {
  const staff = await staffUser();

  const res = await sbUpdate("customer_documents", `id=eq.${documentId}`, { verified: 0, verified_by: null });
  if (!res.ok) return fail(res, "Reverting the document decision");

  await logActivity(staff.id, "doc_decision_reverted", "customer_documents", documentId);
  refresh();
  return { ok: true as const };
}

export async function uploadSignedHandoverDocument(input: {
  bookingId: number;
  filePath: string;
  docType?: "handover" | "return";
  notes?: string;
}) {
  const staff = await staffUser();

  const bookingRes = await sbSelectOne<{ customer_id: number; booking_no: string }>(
    "bookings",
    `select=customer_id,booking_no&id=eq.${input.bookingId}`
  );
  if (!bookingRes.ok || !bookingRes.data) {
    return { ok: false as const, error: `Booking ${input.bookingId} not found.` };
  }

  const customerId = bookingRes.data.customer_id;
  const isReturn = input.docType === "return";
  const docPrefix = isReturn ? "SIGNED-RETURN" : "SIGNED-HANDOVER";
  const actionName = isReturn ? "signed_return_uploaded" : "signed_handover_uploaded";
  const defaultNote = isReturn
    ? "Uploaded physically signed return & final settlement agreement scan/PDF"
    : "Uploaded physically signed handover document scan/PDF";

  const docRes = await sbInsert<{ id: number }>("customer_documents", {
    customer_id: customerId,
    booking_id: input.bookingId,
    kind: "other",
    number: `${docPrefix}-${bookingRes.data.booking_no}`,
    file_path: input.filePath,
    verified: 1,
    verified_by: staff.id,
  });

  if (!docRes.ok) return fail(docRes, `Saving signed ${isReturn ? "return" : "handover"} document`);

  const history = await sbInsert("booking_history", {
    booking_id: input.bookingId,
    user_id: staff.id,
    action: actionName,
    detail: JSON.stringify({
      staff_name: staff.name,
      file_path: input.filePath,
      doc_type: isReturn ? "return" : "handover",
      notes: input.notes ?? defaultNote,
    }),
  });
  if (!history.ok) return fail(history, "Recording booking history");

  await logActivity(staff.id, actionName, "booking", input.bookingId);
  refresh();
  return { ok: true as const, documentId: docRes.data?.id };
}

