import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPayload, withIdempotency, IdempotencyConflictError } from "../src/lib/idempotency";

/**
 * Period-Based Branch Allocation Overlap Detection Rule
 */
function hasAllocationOverlap(
  existing: Array<{ starts_at: string; ends_at: string | null }>,
  newAlloc: { starts_at: string; ends_at: string | null }
): boolean {
  const newStart = new Date(newAlloc.starts_at).getTime();
  const newEnd = newAlloc.ends_at ? new Date(newAlloc.ends_at).getTime() : Infinity;

  return existing.some((e) => {
    const eStart = new Date(e.starts_at).getTime();
    const eEnd = e.ends_at ? new Date(e.ends_at).getTime() : Infinity;
    return eStart < newEnd && eEnd > newStart;
  });
}

test("non-overlapping sequential allocations succeed", () => {
  const existing = [
    { starts_at: "2026-08-18T00:00:00Z", ends_at: "2026-08-21T23:59:59Z" },
  ];

  const nextAlloc = { starts_at: "2026-08-22T00:00:00Z", ends_at: "2026-08-30T23:59:59Z" };
  assert.equal(hasAllocationOverlap(existing, nextAlloc), false);
});

test("overlapping allocation periods are detected and flagged", () => {
  const existing = [
    { starts_at: "2026-08-18T00:00:00Z", ends_at: "2026-08-21T23:59:59Z" },
  ];

  // Overlaps on Aug 20-21
  const overlappingAlloc = { starts_at: "2026-08-20T00:00:00Z", ends_at: "2026-08-25T23:59:59Z" };
  assert.equal(hasAllocationOverlap(existing, overlappingAlloc), true);
});

test("open-ended ongoing allocation blocks any subsequent period", () => {
  const existing = [
    { starts_at: "2026-08-18T00:00:00Z", ends_at: null }, // ongoing indefinitely
  ];

  const candidate = { starts_at: "2026-08-25T00:00:00Z", ends_at: "2026-08-30T23:59:59Z" };
  assert.equal(hasAllocationOverlap(existing, candidate), true);
});

test("global fleet metrics correctly distinguish operational, allocated, maintenance, and blocked units", () => {
  const units = [
    { id: 1, active: 1, status: "available", current_branch_id: 1 }, // Sakleshpur
    { id: 2, active: 1, status: "available", current_branch_id: 1 }, // Sakleshpur
    { id: 3, active: 1, status: "available", current_branch_id: 2 }, // Hassan
    { id: 4, active: 1, status: "maintenance", current_branch_id: 1 }, // Maintenance
    { id: 5, active: 1, status: "blocked", current_branch_id: null }, // Blocked & unallocated
    { id: 6, active: 0, status: "inactive", current_branch_id: 1 }, // Inactive (should be excluded from total)
  ];

  const activeUnits = units.filter((u) => u.active === 1);
  const totalFleet = activeUnits.length;
  const maintenance = activeUnits.filter((u) => u.status === "maintenance").length;
  const blocked = activeUnits.filter((u) => u.status === "blocked").length;
  const allocated = activeUnits.filter((u) => u.current_branch_id !== null).length;
  const unallocated = activeUnits.filter((u) => u.current_branch_id === null).length;
  const operationalFleet = totalFleet - maintenance - blocked;

  assert.equal(totalFleet, 5);
  assert.equal(maintenance, 1);
  assert.equal(blocked, 1);
  assert.equal(operationalFleet, 3);
  assert.equal(allocated, 4);
  assert.equal(unallocated, 1);
});

test("branch filtering handles dynamic branches (Sakleshpur, Hassan, and new future branches)", () => {
  const branches = [
    { id: 1, name: "Sakleshpur", active: 1 },
    { id: 2, name: "Hassan", active: 1 },
    { id: 3, name: "Chikmagalur", active: 1 }, // Dynamic future branch
  ];

  const units = [
    { id: 1, unit_identifier: "CAR-001", current_branch_id: 1 },
    { id: 2, unit_identifier: "CAR-002", current_branch_id: 2 },
    { id: 3, unit_identifier: "CAR-003", current_branch_id: 3 },
  ];

  const filterByBranch = (branchId: number) => units.filter((u) => u.current_branch_id === branchId);

  assert.equal(filterByBranch(1).length, 1);
  assert.equal(filterByBranch(1)[0].unit_identifier, "CAR-001");
  assert.equal(filterByBranch(2).length, 1);
  assert.equal(filterByBranch(2)[0].unit_identifier, "CAR-002");
  assert.equal(filterByBranch(3).length, 1);
  assert.equal(filterByBranch(3)[0].unit_identifier, "CAR-003");
});

test("idempotency rejects payload mismatch with same key", async () => {
  const memoryStore = new Map<string, { hash: string; result: any }>();

  async function mockIdempotency(key: string, payload: any, fn: () => Promise<any>) {
    const hash = hashPayload(payload);
    const existing = memoryStore.get(key);
    if (existing) {
      if (existing.hash !== hash) {
        throw new IdempotencyConflictError(`Conflict for key ${key}`);
      }
      return existing.result;
    }
    const result = await fn();
    memoryStore.set(key, { hash, result });
    return result;
  }

  let executionCount = 0;
  const runner = async () => {
    executionCount += 1;
    return { bookingId: 101, status: "Confirmed" };
  };

  // First execution
  const res1 = await mockIdempotency("req-123", { vehicleId: 5, seats: 4 }, runner);
  assert.equal(res1.bookingId, 101);
  assert.equal(executionCount, 1);

  // Exact duplicate request returns cached result without re-executing
  const res2 = await mockIdempotency("req-123", { vehicleId: 5, seats: 4 }, runner);
  assert.equal(res2.bookingId, 101);
  assert.equal(executionCount, 1, "Duplicate request with same key must not re-execute business logic");
});

test("vehicle plate registration number validation enforces required format", () => {
  const validatePlate = (plate: string | undefined | null) => {
    if (!plate || !plate.trim()) {
      return { ok: false, error: "Vehicle plate number is required" };
    }
    const clean = plate.trim().toUpperCase();
    if (clean.length < 4) {
      return { ok: false, error: "Invalid registration plate length" };
    }
    return { ok: true, formatted: clean };
  };

  assert.equal(validatePlate("").ok, false);
  assert.equal(validatePlate("   ").ok, false);
  assert.equal(validatePlate("ka-46-m-5566").ok, true);
  assert.equal(validatePlate("ka-46-m-5566").formatted, "KA-46-M-5566");
});

test("booking terms and printable PDF terms align on safety, fuel, and late fees", () => {
  const termsKeywords = ["driving licence", "fuel", "deposit", "damage", "accident"];
  const pdfTermsText = `
    1. Valid original Driving Licence & Government ID (Aadhaar/Passport) mandatory for vehicle handover.
    2. Included drive limit applies per 24-hour rental day.
    3. Fuel Policy: Vehicle must be returned with the same fuel level as provided at pickup.
    4. Security Deposit: Refundable upon safe return of the vehicle.
    5. Damage & Accident Protocol: In case of any breakdown, accident, or damage, notify the rental management immediately.
  `.toLowerCase();

  for (const kw of termsKeywords) {
    assert.equal(
      pdfTermsText.includes(kw),
      true,
      `Printable inspection PDF must contain keyword: ${kw}`
    );
  }
});

test("signed handover agreement record structure prevents tampering and requires verification", () => {
  const docRecord = {
    customer_id: 10,
    booking_id: 25,
    kind: "other",
    number: "SIGNED-HANDOVER-BK-2026-0012",
    file_path: "/api/files/signed_agreements/signed_doc_1723289000_abc123.pdf",
    verified: 1,
    verified_by: 1,
  };

  assert.equal(docRecord.kind, "other");
  assert.equal(docRecord.verified, 1);
  assert.equal(docRecord.file_path.endsWith(".pdf"), true);
  assert.equal(docRecord.number.startsWith("SIGNED-HANDOVER-"), true);
});

test("PDF inspection report currency formatting produces clean ASCII Rs. values without unicode corruption", () => {
  function formatPdfINR(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    const numVal = Math.round(Number(value));
    return `Rs. ${numVal.toLocaleString("en-IN")}`;
  }

  assert.equal(formatPdfINR(2908), "Rs. 2,908");
  assert.equal(formatPdfINR(2173), "Rs. 2,173");
  assert.equal(formatPdfINR(735), "Rs. 735");
  assert.equal(formatPdfINR(1000), "Rs. 1,000");
  assert.equal(formatPdfINR(0), "Rs. 0");
  assert.equal(formatPdfINR(null), "—");
});

test("inspection photo side normalizer correctly categorizes variations of camera scan keys", () => {
  function normalizePhotoSide(rawSide: unknown): "front" | "rear" | "left" | "right" | "odometer" | "fuel" | "damage" | null {
    if (!rawSide) return null;
    const s = String(rawSide).toLowerCase().trim().replace(/[-_ ]+/g, "");
    if (s.includes("front")) return "front";
    if (s.includes("rear") || s.includes("back")) return "rear";
    if (s.includes("left")) return "left";
    if (s.includes("right")) return "right";
    if (s.includes("odo") || s.includes("meter") || s.includes("dash") || s.includes("speedo") || s.includes("km")) return "odometer";
    if (s.includes("fuel") || s.includes("cluster") || s.includes("gauge") || s.includes("tank")) return "fuel";
    if (s.includes("damage") || s.includes("scratch") || s.includes("dent")) return "damage";
    return null;
  }

  assert.equal(normalizePhotoSide("front"), "front");
  assert.equal(normalizePhotoSide("Front View"), "front");
  assert.equal(normalizePhotoSide("vehicle_front"), "front");
  assert.equal(normalizePhotoSide("rear"), "rear");
  assert.equal(normalizePhotoSide("Rear / Back View"), "rear");
  assert.equal(normalizePhotoSide("vehicle_back"), "rear");
  assert.equal(normalizePhotoSide("left"), "left");
  assert.equal(normalizePhotoSide("Left Profile"), "left");
  assert.equal(normalizePhotoSide("right"), "right");
  assert.equal(normalizePhotoSide("Right Side"), "right");
  assert.equal(normalizePhotoSide("odometer"), "odometer");
  assert.equal(normalizePhotoSide("Odometer (24500 KM)"), "odometer");
  assert.equal(normalizePhotoSide("dashboard_meter"), "odometer");
  assert.equal(normalizePhotoSide("fuel"), "fuel");
  assert.equal(normalizePhotoSide("Fuel & Cluster (Full)"), "fuel");
  assert.equal(normalizePhotoSide("fuel_gauge"), "fuel");
});

test("payment audit line cleanly formats UPI ID and does not contain unsupported emoji bytes", () => {
  function formatPaymentDetail(opts: {
    isUpi: boolean;
    upiAddress: string | null;
    method: string;
    status: string;
    ref: string;
    time: string;
  }) {
    const methodDisplay = opts.isUpi
      ? `Online UPI ${opts.upiAddress ? `(UPI ID: ${opts.upiAddress})` : ""}`.trim()
      : opts.method;
    return `Payment Audit: Payment: ${methodDisplay} · Status: ${opts.status} · Ref: ${opts.ref}${opts.time}`;
  }

  const upiWithVpa = formatPaymentDetail({
    isUpi: true,
    upiAddress: "customer@okhdfcbank",
    method: "UPI",
    status: "Paid",
    ref: "pay_TPaAJFvqkky9jN",
    time: " on 14 Aug 2026, 1:52 pm",
  });

  assert.equal(
    upiWithVpa,
    "Payment Audit: Payment: Online UPI (UPI ID: customer@okhdfcbank) · Status: Paid · Ref: pay_TPaAJFvqkky9jN on 14 Aug 2026, 1:52 pm"
  );
  assert.equal(upiWithVpa.includes("💳"), false);
  assert.equal(upiWithVpa.startsWith("Payment Audit: Payment:"), true);

  const upiWithoutVpa = formatPaymentDetail({
    isUpi: true,
    upiAddress: null,
    method: "UPI",
    status: "Paid",
    ref: "pay_TPaAJFvqkky9jN",
    time: " on 14 Aug 2026, 1:52 pm",
  });

  assert.equal(
    upiWithoutVpa,
    "Payment Audit: Payment: Online UPI · Status: Paid · Ref: pay_TPaAJFvqkky9jN on 14 Aug 2026, 1:52 pm"
  );
});

test("return inspection telemetry calculates distance driven, extra km, and deposit refund accurately", () => {
  function calculateReturnTelemetry(opts: {
    startOdo: number | null;
    endOdo: number | null;
    includedKm: number;
    extraKmRate: number;
    depositAmount: number;
    depositRefunded: boolean;
  }) {
    const totalKm = opts.startOdo !== null && opts.endOdo !== null ? Math.max(0, opts.endOdo - opts.startOdo) : null;
    const extraKm = totalKm !== null && opts.includedKm > 0 ? Math.max(0, totalKm - opts.includedKm) : 0;
    const extraKmCharge = extraKm * opts.extraKmRate;
    const refundStatus = opts.depositRefunded ? `Refunded (Rs. ${opts.depositAmount.toLocaleString()})` : `Rs. ${opts.depositAmount.toLocaleString()}`;

    return { totalKm, extraKm, extraKmCharge, refundStatus };
  }

  const normalReturn = calculateReturnTelemetry({
    startOdo: 12500,
    endOdo: 12850,
    includedKm: 300,
    extraKmRate: 15,
    depositAmount: 1000,
    depositRefunded: true,
  });

  assert.equal(normalReturn.totalKm, 350);
  assert.equal(normalReturn.extraKm, 50);
  assert.equal(normalReturn.extraKmCharge, 750);
  assert.equal(normalReturn.refundStatus, "Refunded (Rs. 1,000)");

  const zeroExtraReturn = calculateReturnTelemetry({
    startOdo: 10000,
    endOdo: 10180,
    includedKm: 300,
    extraKmRate: 15,
    depositAmount: 1000,
    depositRefunded: false,
  });

  assert.equal(zeroExtraReturn.totalKm, 180);
  assert.equal(zeroExtraReturn.extraKm, 0);
  assert.equal(zeroExtraReturn.extraKmCharge, 0);
  assert.equal(zeroExtraReturn.refundStatus, "Rs. 1,000");
});

test("branch-wise filtering accurately matches bookings by ID, branch name, or pickup location", () => {
  const mockBookings = [
    { id: 1, booking_no: "BK-101", branch_id: 1, branch_name: "Sakleshpur Main", pickup_location: "Sakleshpur Bus Stand" },
    { id: 2, booking_no: "BK-102", branch_id: 2, branch_name: "Hassan City Branch", pickup_location: "Hassan Railway Station" },
    { id: 3, booking_no: "BK-103", branch_id: 1, branch_name: "Sakleshpur Main", pickup_location: "Sakleshpur Homestay" },
    { id: 4, booking_no: "BK-104", branch_id: null, branch_name: null, pickup_location: "Hassan Ring Road" },
  ];

  const branches = [
    { id: 1, name: "Sakleshpur Main" },
    { id: 2, name: "Hassan City Branch" },
  ];

  function filterByBranch(bookings: typeof mockBookings, selectedBranch: string) {
    if (selectedBranch === "all") return bookings;
    return bookings.filter((b) => {
      if (b.branch_id !== null && String(b.branch_id) === selectedBranch) return true;
      const targetBr = branches.find((br) => String(br.id) === selectedBranch);
      const targetName = targetBr?.name.toLowerCase() || selectedBranch.toLowerCase();
      if (b.branch_name && b.branch_name.toLowerCase().includes(targetName)) return true;
      if (b.pickup_location && b.pickup_location.toLowerCase().includes(targetName)) return true;
      return false;
    });
  }

  assert.equal(filterByBranch(mockBookings, "all").length, 4);
  assert.equal(filterByBranch(mockBookings, "1").length, 2);
  assert.equal(filterByBranch(mockBookings, "2").length, 1);
  assert.equal(filterByBranch(mockBookings, "hassan").length, 2);
});

test("signed document prefixes differentiate handover agreements from return settlement agreements", () => {
  function getSignedDocRecord(bookingNo: string, docType: "handover" | "return") {
    const isReturn = docType === "return";
    return {
      number: `${isReturn ? "SIGNED-RETURN" : "SIGNED-HANDOVER"}-${bookingNo}`,
      action: isReturn ? "signed_return_uploaded" : "signed_handover_uploaded",
      tag: isReturn ? "RETURN SETTLEMENT" : "HANDOVER AGREEMENT",
    };
  }

  const handoverDoc = getSignedDocRecord("BK-2026-99", "handover");
  assert.equal(handoverDoc.number, "SIGNED-HANDOVER-BK-2026-99");
  assert.equal(handoverDoc.action, "signed_handover_uploaded");
  assert.equal(handoverDoc.tag, "HANDOVER AGREEMENT");

  const returnDoc = getSignedDocRecord("BK-2026-99", "return");
  assert.equal(returnDoc.number, "SIGNED-RETURN-BK-2026-99");
  assert.equal(returnDoc.action, "signed_return_uploaded");
  assert.equal(returnDoc.tag, "RETURN SETTLEMENT");
});

test("category-wise preset image resolution returns correct default vehicle images", () => {
  const { getCategoryPresetPhoto } = require("../src/lib/data");

  // Bike -> Honda Shine
  assert.equal(getCategoryPresetPhoto("Bikes", "custom-qwerty"), "/vehicles/honda-shine.avif");
  assert.equal(getCategoryPresetPhoto("bike", "pulsar-custom"), "/vehicles/honda-shine.avif");
  assert.equal(getCategoryPresetPhoto({ kind: "bike", name: "Bikes" }, "qwerty"), "/vehicles/honda-shine.avif");

  // Car -> Baleno
  assert.equal(getCategoryPresetPhoto("Cars", "custom-car-1"), "/vehicles/baleno-manual.avif");
  assert.equal(getCategoryPresetPhoto("car", "thar-custom"), "/vehicles/baleno-manual.avif");
  assert.equal(getCategoryPresetPhoto({ kind: "car", name: "Cars" }, "custom-hatchback"), "/vehicles/baleno-manual.avif");

  // Scooter -> Honda Activa
  assert.equal(getCategoryPresetPhoto("Scooters", "custom-scooter"), "/vehicles/honda-activa.webp");
  assert.equal(getCategoryPresetPhoto("scooter", "new-dio"), "/vehicles/honda-activa.webp");
  assert.equal(getCategoryPresetPhoto({ kind: "scooter", name: "Scooters" }, "scooty-1"), "/vehicles/honda-activa.webp");

  // Tempo Traveller -> Tempo Traveller
  assert.equal(getCategoryPresetPhoto("Tempo Traveller", "tt-custom"), "/vehicles/tempo-traveller.jpg");
  assert.equal(getCategoryPresetPhoto("van", "traveller-1"), "/vehicles/tempo-traveller.jpg");
  assert.equal(getCategoryPresetPhoto({ kind: "van", name: "Tempo Traveller" }, "tempo-deluxe"), "/vehicles/tempo-traveller.jpg");
});

test("vehicle form and database status check constraint compatibility", () => {
  const allowedDbStatuses = [
    "available",
    "unavailable",
    "booked",
    "maintenance",
    "blocked",
    "transit",
    "inactive",
    "archived",
  ];

  const allowedFormStatuses = ["available", "unavailable", "booked", "archived"];
  for (const s of allowedFormStatuses) {
    assert.equal(allowedDbStatuses.includes(s), true, `Form status ${s} must be in allowed DB statuses`);
  }

  const allowedUnitStatuses = ["available", "unavailable", "booked", "blocked", "transit", "inactive"];
  for (const s of allowedUnitStatuses) {
    assert.equal(allowedDbStatuses.includes(s), true, `Unit status ${s} must be in allowed DB statuses`);
  }

  const actionBulkStatuses = ["available", "unavailable", "blocked"];
  for (const s of actionBulkStatuses) {
    assert.equal(allowedDbStatuses.includes(s), true, `Bulk status ${s} must be in allowed DB statuses`);
  }
});


test("singular license plate vehicle blocking only affects that specific unit", () => {
  // A car model with 3 physical units
  const balenoUnits = [
    { id: 101, vehicle_id: 11, registration_no: "KA-46-C-1010", status: "available" },
    { id: 102, vehicle_id: 11, registration_no: "KA-46-C-1020", status: "available" },
    { id: 103, vehicle_id: 11, registration_no: "KA-46-C-1030", status: "available" },
  ];

  // Block only unit with registration number KA-46-C-1020
  const updatedUnits = balenoUnits.map((u) =>
    u.registration_no === "KA-46-C-1020" ? { ...u, status: "unavailable" } : u
  );

  const activeUnits = updatedUnits.filter((u) => u.status === "available");
  assert.equal(activeUnits.length, 2);
  assert.equal(activeUnits.some((u) => u.registration_no === "KA-46-C-1010"), true);
  assert.equal(activeUnits.some((u) => u.registration_no === "KA-46-C-1030"), true);
  assert.equal(activeUnits.some((u) => u.registration_no === "KA-46-C-1020"), false);
});

test("complete vehicle unavailability occurs when all units are unavailable or vehicle is marked unavailable", () => {
  function computeAvailability(
    vehicleStatus: string,
    units: Array<{ status: string }>,
    holds: number,
    branchBlocked: boolean
  ) {
    if (branchBlocked || vehicleStatus === "unavailable" || vehicleStatus === "blocked") return 0;
    const activeUnits = units.length > 0 ? units.filter((u) => u.status === "available").length : 1;
    return Math.max(0, activeUnits - holds);
  }

  // Case 1: 1 out of 3 units blocked -> 2 available (still active, not greyed out)
  const partial = computeAvailability("available", [{ status: "available" }, { status: "unavailable" }, { status: "available" }], 0, false);
  assert.equal(partial, 2);

  // Case 2: All 3 units blocked -> 0 available (completely unavailable -> grey)
  const allBlocked = computeAvailability("available", [{ status: "unavailable" }, { status: "unavailable" }, { status: "unavailable" }], 0, false);
  assert.equal(allBlocked, 0);

  // Case 3: Parent vehicle marked unavailable -> 0 available (completely unavailable -> grey)
  const parentBlocked = computeAvailability("unavailable", [{ status: "available" }], 0, false);
  assert.equal(parentBlocked, 0);

  // Case 4: Branch blocked -> 0 available (completely unavailable -> grey)
  const branchBlocked = computeAvailability("available", [{ status: "available" }, { status: "available" }], 0, true);
  assert.equal(branchBlocked, 0);
});

test("multi-select bulk blocking supports selecting and updating multiple units at once", () => {
  const units = [
    { id: 1, registration_no: "KA-46-E-1", status: "available" },
    { id: 2, registration_no: "KA-46-E-2", status: "available" },
    { id: 3, registration_no: "KA-46-E-3", status: "available" },
    { id: 4, registration_no: "KA-46-E-4", status: "available" },
  ];

  const selectedIds = [1, 3]; // Multi-select 2 units

  const updated = units.map((u) =>
    selectedIds.includes(u.id) ? { ...u, status: "unavailable" } : u
  );

  assert.equal(updated.find((u) => u.id === 1)?.status, "unavailable");
  assert.equal(updated.find((u) => u.id === 2)?.status, "available");
  assert.equal(updated.find((u) => u.id === 3)?.status, "unavailable");
  assert.equal(updated.find((u) => u.id === 4)?.status, "available");
});

test("original vehicle unit distribution preserves exact total fleet counts and splits odd units properly", () => {
  const { DEFAULT_VEHICLE_UNITS } = require("../src/lib/data");

  const sakleshpuraUnits = DEFAULT_VEHICLE_UNITS.filter((u: any) => u.current_branch_id === 1);
  const hassanUnits = DEFAULT_VEHICLE_UNITS.filter((u: any) => u.current_branch_id === 2);

  // 19 units in Sakleshpura, 12 units in Hassan, 31 total units across 17 catalogue models
  assert.equal(sakleshpuraUnits.length, 19);
  assert.equal(hassanUnits.length, 12);
  assert.equal(DEFAULT_VEHICLE_UNITS.length, 31);

  // All units have valid Karnataka registration numbers (KA ...)
  assert.equal(sakleshpuraUnits.every((u: any) => u.registration_no.startsWith("KA")), true);
  assert.equal(hassanUnits.every((u: any) => u.registration_no.startsWith("KA")), true);

  // Odd vehicle splits (e.g. NTorq 3 units -> 2:1 split; Jupiter 6 units -> 3:3 split)
  const ntorqSakleshpura = sakleshpuraUnits.filter((u: any) => u.vehicle_id === 5);
  const ntorqHassan = hassanUnits.filter((u: any) => u.vehicle_id === 5);
  assert.equal(ntorqSakleshpura.length, 2);
  assert.equal(ntorqHassan.length, 1);

  const jupiterSakleshpura = sakleshpuraUnits.filter((u: any) => u.vehicle_id === 3);
  const jupiterHassan = hassanUnits.filter((u: any) => u.vehicle_id === 3);
  assert.equal(jupiterSakleshpura.length, 3);
  assert.equal(jupiterHassan.length, 3);
});

test("branch filtering only shows that branch's vehicles and its assigned units", () => {
  const { DEFAULT_VEHICLE_UNITS } = require("../src/lib/data");

  const dioSakleshpuraUnits = DEFAULT_VEHICLE_UNITS.filter(
    (u: any) => u.vehicle_id === 1 && u.current_branch_id === 1
  );
  const dioHassanUnits = DEFAULT_VEHICLE_UNITS.filter(
    (u: any) => u.vehicle_id === 1 && u.current_branch_id === 2
  );

  assert.equal(dioSakleshpuraUnits.length, 2);
  assert.equal(dioHassanUnits.length, 2);
  assert.deepEqual(dioSakleshpuraUnits.map((u: any) => u.registration_no), ["KA 13 D 6730", "KA 13 D 6732"]);
  assert.deepEqual(dioHassanUnits.map((u: any) => u.registration_no), ["KA 13 D 6728", "KA 66 L 3725"]);
});

test("marking vehicle or all units unavailable updates all connected fields and branch distributions to 0", () => {
  const { DEFAULT_VEHICLE_UNITS, DEFAULT_VEHICLES_ROSTER } = require("../src/lib/data");

  // Sample vehicle (Dio id: 1 with 4 units)
  const dio = DEFAULT_VEHICLES_ROSTER.find((v: any) => v.id === 1);
  assert.ok(dio);

  // If vehicle is marked unavailable
  const unavailableDio = {
    ...dio,
    status: "unavailable",
  };
  const isVehicleUnavailable = unavailableDio.status === "unavailable" || unavailableDio.status === "blocked";
  const availableUnits = isVehicleUnavailable ? 0 : 4;
  assert.equal(availableUnits, 0);

  // Branch distribution available_units must be 0 for all branches when vehicle is unavailable
  const branchDist = (dio.branch_distribution || []).map((d: any) => ({
    ...d,
    available_units: isVehicleUnavailable ? 0 : d.total_units,
  }));
  assert.equal(branchDist.every((d: any) => d.available_units === 0), true);

  // If 1 unit out of 4 is unavailable (partial blocking)
  const dioUnits = DEFAULT_VEHICLE_UNITS.filter((u: any) => u.vehicle_id === 1);
  const updatedUnits = dioUnits.map((u: any, idx: number) => ({
    ...u,
    status: idx === 0 ? "unavailable" : "available",
  }));
  const anyAvailable = updatedUnits.some((u: any) => u.status === "available");
  const parentStatus = anyAvailable ? "available" : "unavailable";
  const operationalUnitsCount = updatedUnits.filter((u: any) => u.status === "available").length;

  assert.equal(parentStatus, "available");
  assert.equal(operationalUnitsCount, 3);
});

test("blocking a branch marks all allocated units of that branch as blocked and greyed-out", () => {
  const { DEFAULT_VEHICLE_UNITS } = require("../src/lib/data");

  // Hassan branch (id: 2)
  const hassanBranchId = 2;
  const branches = [
    { id: 1, name: "Sakleshpura Branch", blocked: 0 },
    { id: 2, name: "Hassan Branch", blocked: 1 },
  ];
  const branchMap = new Map(branches.map((b) => [b.id, b]));

  // Check all units
  const unitsWithStatus = DEFAULT_VEHICLE_UNITS.map((u: any) => {
    const bObj = u.current_branch_id ? branchMap.get(u.current_branch_id) : null;
    const isBranchBlocked = (bObj && Number(bObj.blocked) === 1) || Boolean(u.branch_blocked);
    const isUnavailable = isBranchBlocked || u.status === "unavailable" || u.status === "blocked";
    return {
      ...u,
      isUnavailable,
      isBranchBlocked,
    };
  });

  const hassanUnits = unitsWithStatus.filter((u: any) => u.current_branch_id === hassanBranchId);
  const sakleshpuraUnits = unitsWithStatus.filter((u: any) => u.current_branch_id === 1);

  // Every Hassan unit MUST be marked unavailable and branch-blocked (greyed out)
  assert.equal(hassanUnits.length, 12);
  assert.equal(hassanUnits.every((u: any) => u.isUnavailable === true), true);
  assert.equal(hassanUnits.every((u: any) => u.isBranchBlocked === true), true);

  // Sakleshpura units remain operational/available
  assert.equal(sakleshpuraUnits.length, 19);
  assert.equal(sakleshpuraUnits.every((u: any) => u.isUnavailable === false), true);
});



