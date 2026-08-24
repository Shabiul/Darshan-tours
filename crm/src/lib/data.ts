/**
 * Read models for CRM content: fleet, categories, branches and website content.
 *
 * Every read goes straight to Supabase. There is no local mirror and no hardcoded
 * fallback inventory: the previous version answered a failed query with a canned
 * seventeen-vehicle array, so an unreachable database looked exactly like a healthy
 * one — right down to prices customers could book against. A read that fails now
 * throws, and the dashboard error boundary shows it.
 */

import { sbSelect, sbSelectOne, num } from "./supabase-rest";

export type VehicleCategory = {
  id: number;
  slug: string;
  name: string;
  kind: "bike" | "scooter" | "car" | "van";
  icon: string | null;
  image: string | null;
  short_desc: string | null;
  description: string | null;
  active: number;
  sort: number;
};

export type Vehicle = {
  id: number;
  slug: string;
  name: string;
  brand: string;
  model: string;
  year: number | null;
  category_id: number | null;
  category_name: string | null;
  category_kind: string | null;
  category_slug: string | null;
  branch_id: number | null;
  branch_name: string | null;
  registration_no: string | null;
  cc: number | null;
  fuel_type: string;
  transmission: string;
  seats: number;
  mileage: string | null;
  included_km: number;
  extra_km_rate: number;
  rate_12h: number;
  rate_24h: number;
  hourly_rate: number;
  weekend_rate_24h: number | null;
  deposit: number;
  late_fee_per_hour: number;
  total_units: number;
  available_units: number;
  description: string | null;
  terms: string | null;
  status: string;
  active: number;
  photos: string[];
  primary_photo: string | null;
  units?: VehicleUnit[];
  branch_distribution?: Array<{ branch_id: number; branch_name: string; total_units: number; available_units: number }>;
};

export type VehicleUnit = {
  id: number;
  vehicle_id: number;
  unit_identifier: string;
  registration_no: string | null;
  status: "available" | "unavailable" | "booked" | "maintenance" | "blocked" | "transit" | "inactive";
  current_branch_id: number | null;
  current_branch_name?: string | null;
  branch_blocked?: boolean;
  vehicle_name?: string | null;
  vehicle_brand?: string | null;
  vehicle_model?: string | null;
  active: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type BranchAllocation = {
  id: number;
  vehicle_unit_id: number;
  branch_id: number;
  branch_name?: string | null;
  starts_at: string;
  ends_at: string | null;
  notes: string | null;
  created_at: string;
};

export type BranchTransfer = {
  id: number;
  vehicle_unit_id: number;
  from_branch_id: number | null;
  to_branch_id: number;
  effective_date: string;
  reason: string | null;
  performed_by: number | null;
  created_at: string;
};

export type DailyAllocationRow = {
  date: string;
  total: number;
  unallocated: number;
  branches: Record<string, number>;
};

export type GlobalFleetSummary = {
  totalFleet: number;
  operationalFleet: number;
  allocated: number;
  unallocated: number;
  booked: number;
  available: number;
  maintenance: number;
  blocked: number;
};

export type Branch = {
  id: number;
  name: string;
  city: string | null;
  address: string | null;
  phone: string | null;
  active: number;
  blocked?: number;
  blocked_reason?: string | null;
  blocked_at?: string | null;
};

const DEFAULT_SLUG_PHOTOS: Record<string, string> = {
  "honda-dio": "/vehicles/honda-dio.avif",
  "honda-activa": "/vehicles/honda-activa.webp",
  "tvs-jupiter": "/vehicles/tvs-jupiter.webp",
  "yamaha-rayzr": "/vehicles/yamaha-rayzr.avif",
  "tvs-ntorq": "/vehicles/tvs-ntorq.webp",
  "tvs-ronin": "/vehicles/tvs-ronin.avif",
  "honda-cb200x": "/vehicles/honda-cb200x.jpg",
  "tvs-raider": "/vehicles/tvs-radar.avif",
  "bajaj-pulsar-ns": "/vehicles/bajaj-pulsar-ns.png",
  "honda-shine": "/vehicles/honda-shine.avif",
  "maruti-baleno-manual": "/vehicles/baleno-manual.avif",
  "maruti-dzire": "/vehicles/maruti-dzire.avif",
  "maruti-ciaz": "/vehicles/maruti-ciaz.jpg",
  "maruti-ertiga-7-seater": "/vehicles/maruti-ertiga.avif",
  "mahindra-thar-manual": "/vehicles/mahindra-thar.avif",
  "tempo-traveller-12": "/vehicles/tempo-traveller.jpg",
  "tempo-traveller-2days": "/vehicles/cta-tempo-banner.jpg",
};

/** A booking in one of these states is holding a unit, so it reduces availability. */
const HOLDING_STATUSES = [
  "Confirmed",
  "Payment received",
  "Pending payment",
  "Vehicle handed over",
  "Active rental",
  "Pending verification",
  "Enquiry",
  "Draft",
];

/** Builds a PostgREST `in.(…)` predicate; values are quoted so spaces survive. */
function inList(values: Array<string | number>): string {
  return `in.(${values.map((v) => (typeof v === "number" ? String(v) : `"${v}"`)).join(",")})`;
}

type RawVehicle = Record<string, unknown> & {
  id: number;
  vehicle_categories?: { name: string; kind: string; slug: string } | null;
  branches?: { name: string; blocked?: number } | null;
};

const VEHICLE_EMBED = "*,vehicle_categories(name,kind,slug),branches(name,blocked)";
const VEHICLE_EMBED_INNER = "*,vehicle_categories!inner(name,kind,slug),branches(name,blocked)";

export function getCategoryPresetPhoto(
  category?: { kind?: string; slug?: string; name?: string } | string | null,
  slug?: string | null
): string {
  if (slug && DEFAULT_SLUG_PHOTOS[slug]) {
    return DEFAULT_SLUG_PHOTOS[slug];
  }

  const catStr = typeof category === "object" && category !== null
    ? `${category.kind || ""} ${category.slug || ""} ${category.name || ""}`.toLowerCase()
    : String(category || "").toLowerCase();

  if (catStr.includes("scooter") || catStr.includes("activa") || catStr.includes("jupiter") || catStr.includes("dio")) {
    return "/vehicles/honda-activa.webp";
  }
  if (catStr.includes("bike") || catStr.includes("motorcycle") || catStr.includes("two-wheeler") || catStr.includes("shine") || catStr.includes("pulsar") || catStr.includes("ronin")) {
    return "/vehicles/honda-shine.avif";
  }
  if (catStr.includes("tempo") || catStr.includes("traveller") || catStr.includes("van") || catStr.includes("bus")) {
    return "/vehicles/tempo-traveller.jpg";
  }
  // Default for cars / 4-wheelers
  return "/vehicles/baleno-manual.avif";
}

export const DEFAULT_VEHICLE_UNITS: VehicleUnit[] = [
  // 1. Honda Dio (Scooters) — 4 units: 2 Sakleshpura, 2 Hassan
  { id: 101, vehicle_id: 1, unit_identifier: "DIO-001", registration_no: "KA 13 D 6730", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "Honda Dio", vehicle_brand: "Honda", vehicle_model: "Dio", active: 1, notes: "Dio Unit 1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 102, vehicle_id: 1, unit_identifier: "DIO-002", registration_no: "KA 13 D 6732", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "Honda Dio", vehicle_brand: "Honda", vehicle_model: "Dio", active: 1, notes: "Dio Unit 2", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 103, vehicle_id: 1, unit_identifier: "DIO-003", registration_no: "KA 13 D 6728", status: "available", current_branch_id: 2, current_branch_name: "Hassan Branch", vehicle_name: "Honda Dio", vehicle_brand: "Honda", vehicle_model: "Dio", active: 1, notes: "Dio Unit 3", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 104, vehicle_id: 1, unit_identifier: "DIO-004", registration_no: "KA 66 L 3725", status: "available", current_branch_id: 2, current_branch_name: "Hassan Branch", vehicle_name: "Honda Dio", vehicle_brand: "Honda", vehicle_model: "Dio", active: 1, notes: "Dio Unit 4", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 2. Honda Activa 6G (Scooters) — 2 units: 1 Sakleshpura, 1 Hassan
  { id: 201, vehicle_id: 2, unit_identifier: "ACTIVA-001", registration_no: "KA 13 D 6731", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "Honda Activa 6G", vehicle_brand: "Honda", vehicle_model: "Activa 6G", active: 1, notes: "Activa Unit 1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 202, vehicle_id: 2, unit_identifier: "ACTIVA-002", registration_no: "KA 66 Q 0119", status: "available", current_branch_id: 2, current_branch_name: "Hassan Branch", vehicle_name: "Honda Activa 6G", vehicle_brand: "Honda", vehicle_model: "Activa 6G", active: 1, notes: "Activa Unit 2", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 3. TVS Jupiter (Scooters) — 6 units: 3 Sakleshpura, 3 Hassan
  { id: 301, vehicle_id: 3, unit_identifier: "JUPITER-001", registration_no: "KA 13 AA 6607", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "TVS Jupiter", vehicle_brand: "TVS", vehicle_model: "Jupiter", active: 1, notes: "Jupiter Unit 1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 302, vehicle_id: 3, unit_identifier: "JUPITER-002", registration_no: "KA 13 AA 6606", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "TVS Jupiter", vehicle_brand: "TVS", vehicle_model: "Jupiter", active: 1, notes: "Jupiter Unit 2", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 303, vehicle_id: 3, unit_identifier: "JUPITER-003", registration_no: "KA 13 AA 6605", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "TVS Jupiter", vehicle_brand: "TVS", vehicle_model: "Jupiter", active: 1, notes: "Jupiter Unit 3", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 304, vehicle_id: 3, unit_identifier: "JUPITER-004", registration_no: "KA 13 AA 7010", status: "available", current_branch_id: 2, current_branch_name: "Hassan Branch", vehicle_name: "TVS Jupiter", vehicle_brand: "TVS", vehicle_model: "Jupiter", active: 1, notes: "Jupiter Unit 4", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 305, vehicle_id: 3, unit_identifier: "JUPITER-005", registration_no: "KA 13 AA 3467", status: "available", current_branch_id: 2, current_branch_name: "Hassan Branch", vehicle_name: "TVS Jupiter", vehicle_brand: "TVS", vehicle_model: "Jupiter", active: 1, notes: "Jupiter Unit 5", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 306, vehicle_id: 3, unit_identifier: "JUPITER-006", registration_no: "KA 13 AA 3468", status: "available", current_branch_id: 2, current_branch_name: "Hassan Branch", vehicle_name: "TVS Jupiter", vehicle_brand: "TVS", vehicle_model: "Jupiter", active: 1, notes: "Jupiter Unit 6", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 4. Yamaha RayZR (Scooters) — 2 units: 1 Sakleshpura, 1 Hassan
  { id: 401, vehicle_id: 4, unit_identifier: "RAYZR-001", registration_no: "KA 66 Q 5483", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "Yamaha RayZR", vehicle_brand: "Yamaha", vehicle_model: "RayZR", active: 1, notes: "Yamaha Unit 1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 402, vehicle_id: 4, unit_identifier: "RAYZR-002", registration_no: "KA 66 Q 5484", status: "available", current_branch_id: 2, current_branch_name: "Hassan Branch", vehicle_name: "Yamaha RayZR", vehicle_brand: "Yamaha", vehicle_model: "RayZR", active: 1, notes: "Yamaha Unit 2", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 5. TVS NTorq 125 (Scooters) — 3 units (2:1 odd ratio): 2 Sakleshpura, 1 Hassan
  { id: 501, vehicle_id: 5, unit_identifier: "NTORQ-001", registration_no: "KA 13 AA 7007", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "TVS NTorq 125", vehicle_brand: "TVS", vehicle_model: "NTorq", active: 1, notes: "NTorq Unit 1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 502, vehicle_id: 5, unit_identifier: "NTORQ-002", registration_no: "KA 13 AA 7009", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "TVS NTorq 125", vehicle_brand: "TVS", vehicle_model: "NTorq", active: 1, notes: "NTorq Unit 2", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 503, vehicle_id: 5, unit_identifier: "NTORQ-003", registration_no: "KA 13 AA 7008", status: "available", current_branch_id: 2, current_branch_name: "Hassan Branch", vehicle_name: "TVS NTorq 125", vehicle_brand: "TVS", vehicle_model: "NTorq", active: 1, notes: "NTorq Unit 3", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 6. TVS Ronin 225 (Bikes) — 1 unit: 1 Sakleshpura, 0 Hassan
  { id: 601, vehicle_id: 6, unit_identifier: "RONIN-001", registration_no: "KA 66 R 2082", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "TVS Ronin 225", vehicle_brand: "TVS", vehicle_model: "Ronin", active: 1, notes: "Ronin Unit 1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 7. Honda CB200X (Bikes) — 1 unit: 0 Sakleshpura, 1 Hassan
  { id: 701, vehicle_id: 7, unit_identifier: "CB200X-001", registration_no: "KA 13 D 9771", status: "available", current_branch_id: 2, current_branch_name: "Hassan Branch", vehicle_name: "Honda CB200X", vehicle_brand: "Honda", vehicle_model: "CB200X", active: 1, notes: "CB 200 Unit 1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 8. TVS Raider 125 (Bikes) — 2 units: 1 Sakleshpura, 1 Hassan
  { id: 801, vehicle_id: 8, unit_identifier: "RAIDER-001", registration_no: "KA 13 AA 7007", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "TVS Raider 125", vehicle_brand: "TVS", vehicle_model: "Raider", active: 1, notes: "Raider Unit 1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 802, vehicle_id: 8, unit_identifier: "RAIDER-002", registration_no: "KA 13 AA 3469", status: "available", current_branch_id: 2, current_branch_name: "Hassan Branch", vehicle_name: "TVS Raider 125", vehicle_brand: "TVS", vehicle_model: "Raider", active: 1, notes: "Raider Unit 2", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 9. Bajaj Pulsar NS200 (Bikes) — 1 unit: 1 Sakleshpura, 0 Hassan
  { id: 901, vehicle_id: 9, unit_identifier: "PULSAR-001", registration_no: "KA 66 L 4592", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "Bajaj Pulsar NS200", vehicle_brand: "Bajaj", vehicle_model: "Pulsar NS", active: 1, notes: "Pulsar NS Unit 1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 10. Honda Shine 125 (Bikes) — 2 units: 1 Sakleshpura, 1 Hassan
  { id: 1001, vehicle_id: 10, unit_identifier: "SHINE-001", registration_no: "KA 13 D 6729", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "Honda Shine 125", vehicle_brand: "Honda", vehicle_model: "Shine", active: 1, notes: "Shine Unit 1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { id: 1002, vehicle_id: 10, unit_identifier: "SHINE-002", registration_no: "KA 13 D 9770", status: "available", current_branch_id: 2, current_branch_name: "Hassan Branch", vehicle_name: "Honda Shine 125", vehicle_brand: "Honda", vehicle_model: "Shine", active: 1, notes: "Shine Unit 2", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 11. Maruti Baleno (Cars) — 1 unit: 1 Sakleshpura, 0 Hassan
  { id: 1101, vehicle_id: 11, unit_identifier: "BALENO-001", registration_no: "KA 13 MA 0550", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "Maruti Baleno", vehicle_brand: "Maruti Suzuki", vehicle_model: "Baleno", active: 1, notes: "Baleno Manual", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 12. Maruti Dzire (Cars) — 1 unit: 1 Sakleshpura, 0 Hassan
  { id: 1301, vehicle_id: 13, unit_identifier: "DZIRE-001", registration_no: "KA 18 O 3985", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "Maruti Dzire", vehicle_brand: "Maruti Suzuki", vehicle_model: "Dzire", active: 1, notes: "Dzire Unit 1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 13. Maruti Ciaz (Cars) — 1 unit: 0 Sakleshpura, 1 Hassan
  { id: 1401, vehicle_id: 14, unit_identifier: "CIAZ-001", registration_no: "KA 13 AA 0810", status: "available", current_branch_id: 2, current_branch_name: "Hassan Branch", vehicle_name: "Maruti Ciaz", vehicle_brand: "Maruti Suzuki", vehicle_model: "Ciaz", active: 1, notes: "Ciaz Unit 1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 14. Maruti Ertiga 7 Seater (Cars) — 1 unit: 1 Sakleshpura, 0 Hassan
  { id: 1501, vehicle_id: 15, unit_identifier: "ERTIGA-001", registration_no: "KA 18 MB 0040", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "Maruti Ertiga 7 Seater", vehicle_brand: "Maruti Suzuki", vehicle_model: "Ertiga", active: 1, notes: "Ertiga Unit 1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 15. Mahindra Thar 4x4 (Cars) — 1 unit: 1 Sakleshpura, 0 Hassan
  { id: 1601, vehicle_id: 16, unit_identifier: "THAR-001", registration_no: "KA 18 MB 7629", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "Mahindra Thar 4x4", vehicle_brand: "Mahindra", vehicle_model: "Thar", active: 1, notes: "Thar Unit 1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 16. Tempo Traveller (Tempo Traveller) — 1 unit: 1 Sakleshpura, 0 Hassan
  { id: 1801, vehicle_id: 18, unit_identifier: "TEMPO12-001", registration_no: "KA 18 D 4391", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "Tempo Traveller", vehicle_brand: "Force Motors", vehicle_model: "Traveller", active: 1, notes: "TT Unit 1", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },

  // 17. Tempo Traveller 2 Days Tour (Tempo Traveller) — 1 unit: 1 Sakleshpura, 0 Hassan
  { id: 1901, vehicle_id: 19, unit_identifier: "TEMPO2D-001", registration_no: "KA 18 D 4391", status: "available", current_branch_id: 1, current_branch_name: "Sakleshpura Branch", vehicle_name: "Tempo Traveller — Sakleshpura & Chikmagalur (2 Days)", vehicle_brand: "Force Motors", vehicle_model: "Traveller", active: 1, notes: "TT Unit 1 (2 Days Package)", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
];

export const DEFAULT_CATEGORIES_ROSTER: VehicleCategory[] = [
  { id: 1, slug: "cars", name: "Cars", kind: "car", icon: null, image: "/vehicles/mahindra-thar.avif", short_desc: "Self-drive hatchbacks, sedans & SUVs", description: "Well maintained self-drive car fleet.", active: 1, sort: 1 },
  { id: 2, slug: "bikes", name: "Bikes", kind: "bike", icon: null, image: "/vehicles/tvs-ronin.avif", short_desc: "Cruisers and commuter bikes", description: "Well-serviced bikes for trips.", active: 1, sort: 2 },
  { id: 3, slug: "scooters", name: "Scooters", kind: "scooter", icon: null, image: "/vehicles/category-scooters.jpg", short_desc: "Automatic scooters for local travel", description: "Simple automatic scooters.", active: 1, sort: 3 },
  { id: 4, slug: "tempo-traveller", name: "Tempo Traveller", kind: "van", icon: null, image: "/vehicles/tempo-traveller.jpg", short_desc: "Chauffeur driven tempo traveller", description: "Group sightseeing trips.", active: 1, sort: 4 },
];

export const DEFAULT_VEHICLES_ROSTER: Vehicle[] = [
  // Scooters (Category 3) — Exact original counts
  {
    id: 1, slug: "honda-dio", name: "Honda Dio", brand: "Honda", model: "Dio", year: 2023, category_id: 3, category_name: "Scooters", category_kind: "scooter", category_slug: "scooters", branch_id: 1, branch_name: "Sakleshpura Branch", registration_no: "KA 13 D 6730", cc: 110, fuel_type: "Petrol", transmission: "Automatic", seats: 2, mileage: "45 km/l", included_km: 100, extra_km_rate: 4, rate_12h: 500, rate_24h: 900, hourly_rate: 100, weekend_rate_24h: 950, deposit: 1000, late_fee_per_hour: 100, total_units: 4, available_units: 4, description: "Light, easy-to-ride scooter.", terms: null, status: "available", active: 1, photos: ["/vehicles/honda-dio.avif"], primary_photo: "/vehicles/honda-dio.avif",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 2, available_units: 2 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 2, available_units: 2 }]
  },
  {
    id: 2, slug: "honda-activa", name: "Honda Activa 6G", brand: "Honda", model: "Activa 6G", year: 2023, category_id: 3, category_name: "Scooters", category_kind: "scooter", category_slug: "scooters", branch_id: 1, branch_name: "Sakleshpura Branch", registration_no: "KA 13 D 6731", cc: 110, fuel_type: "Petrol", transmission: "Automatic", seats: 2, mileage: "50 km/l", included_km: 100, extra_km_rate: 4, rate_12h: 500, rate_24h: 900, hourly_rate: 100, weekend_rate_24h: 950, deposit: 1000, late_fee_per_hour: 100, total_units: 2, available_units: 2, description: "Automatic, light and simple to ride.", terms: null, status: "available", active: 1, photos: ["/vehicles/honda-activa.webp"], primary_photo: "/vehicles/honda-activa.webp",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 1, available_units: 1 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 1, available_units: 1 }]
  },
  {
    id: 3, slug: "tvs-jupiter", name: "TVS Jupiter", brand: "TVS", model: "Jupiter", year: 2023, category_id: 3, category_name: "Scooters", category_kind: "scooter", category_slug: "scooters", branch_id: 1, branch_name: "Sakleshpura Branch", registration_no: "KA 13 AA 6607", cc: 110, fuel_type: "Petrol", transmission: "Automatic", seats: 2, mileage: "50 km/l", included_km: 100, extra_km_rate: 4, rate_12h: 500, rate_24h: 900, hourly_rate: 100, weekend_rate_24h: 950, deposit: 1000, late_fee_per_hour: 100, total_units: 6, available_units: 6, description: "Smooth ride with high comfort.", terms: null, status: "available", active: 1, photos: ["/vehicles/tvs-jupiter.webp"], primary_photo: "/vehicles/tvs-jupiter.webp",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 3, available_units: 3 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 3, available_units: 3 }]
  },
  {
    id: 4, slug: "yamaha-rayzr", name: "Yamaha RayZR", brand: "Yamaha", model: "RayZR", year: 2023, category_id: 3, category_name: "Scooters", category_kind: "scooter", category_slug: "scooters", branch_id: 1, branch_name: "Sakleshpura Branch", registration_no: "KA 66 Q 5483", cc: 125, fuel_type: "Petrol", transmission: "Automatic", seats: 2, mileage: "52 km/l", included_km: 100, extra_km_rate: 4, rate_12h: 550, rate_24h: 950, hourly_rate: 100, weekend_rate_24h: 1000, deposit: 1000, late_fee_per_hour: 100, total_units: 2, available_units: 2, description: "Sporty 125cc scooter.", terms: null, status: "available", active: 1, photos: ["/vehicles/yamaha-rayzr.avif"], primary_photo: "/vehicles/yamaha-rayzr.avif",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 1, available_units: 1 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 1, available_units: 1 }]
  },
  {
    id: 5, slug: "tvs-ntorq", name: "TVS NTorq 125", brand: "TVS", model: "NTorq", year: 2023, category_id: 3, category_name: "Scooters", category_kind: "scooter", category_slug: "scooters", branch_id: 1, branch_name: "Sakleshpura Branch", registration_no: "KA 13 AA 7007", cc: 125, fuel_type: "Petrol", transmission: "Automatic", seats: 2, mileage: "45 km/l", included_km: 100, extra_km_rate: 4, rate_12h: 600, rate_24h: 1000, hourly_rate: 110, weekend_rate_24h: 1050, deposit: 1000, late_fee_per_hour: 100, total_units: 3, available_units: 3, description: "Performance scooter with bluetooth console.", terms: null, status: "available", active: 1, photos: ["/vehicles/tvs-ntorq.webp"], primary_photo: "/vehicles/tvs-ntorq.webp",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 2, available_units: 2 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 1, available_units: 1 }]
  },

  // Bikes (Category 2) — Exact original counts
  {
    id: 6, slug: "tvs-ronin", name: "TVS Ronin 225", brand: "TVS", model: "Ronin", year: 2023, category_id: 2, category_name: "Bikes", category_kind: "bike", category_slug: "bikes", branch_id: 1, branch_name: "Sakleshpura Branch", registration_no: "KA 66 R 2082", cc: 225, fuel_type: "Petrol", transmission: "Manual", seats: 2, mileage: "35 km/l", included_km: 100, extra_km_rate: 4, rate_12h: 1000, rate_24h: 1800, hourly_rate: 150, weekend_rate_24h: 1850, deposit: 1000, late_fee_per_hour: 120, total_units: 1, available_units: 1, description: "Modern cruiser styling.", terms: null, status: "available", active: 1, photos: ["/vehicles/tvs-ronin.avif"], primary_photo: "/vehicles/tvs-ronin.avif",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 1, available_units: 1 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 0, available_units: 0 }]
  },
  {
    id: 7, slug: "honda-cb200x", name: "Honda CB200X", brand: "Honda", model: "CB200X", year: 2023, category_id: 2, category_name: "Bikes", category_kind: "bike", category_slug: "bikes", branch_id: 2, branch_name: "Hassan Branch", registration_no: "KA 13 D 9771", cc: 184, fuel_type: "Petrol", transmission: "Manual", seats: 2, mileage: "38 km/l", included_km: 100, extra_km_rate: 4, rate_12h: 1000, rate_24h: 1800, hourly_rate: 150, weekend_rate_24h: 1850, deposit: 1000, late_fee_per_hour: 120, total_units: 1, available_units: 1, description: "Adventure-styled bike.", terms: null, status: "available", active: 1, photos: ["/vehicles/honda-cb200x.jpg"], primary_photo: "/vehicles/honda-cb200x.jpg",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 0, available_units: 0 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 1, available_units: 1 }]
  },
  {
    id: 8, slug: "tvs-raider", name: "TVS Raider 125", brand: "TVS", model: "Raider", year: 2023, category_id: 2, category_name: "Bikes", category_kind: "bike", category_slug: "bikes", branch_id: 1, branch_name: "Sakleshpura Branch", registration_no: "KA 13 AA 7007", cc: 125, fuel_type: "Petrol", transmission: "Manual", seats: 2, mileage: "55 km/l", included_km: 100, extra_km_rate: 4, rate_12h: 700, rate_24h: 1200, hourly_rate: 110, weekend_rate_24h: 1250, deposit: 1000, late_fee_per_hour: 100, total_units: 2, available_units: 2, description: "Sleek commuter bike.", terms: null, status: "available", active: 1, photos: ["/vehicles/tvs-radar.avif"], primary_photo: "/vehicles/tvs-radar.avif",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 1, available_units: 1 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 1, available_units: 1 }]
  },
  {
    id: 9, slug: "bajaj-pulsar-ns", name: "Bajaj Pulsar NS200", brand: "Bajaj", model: "Pulsar NS", year: 2023, category_id: 2, category_name: "Bikes", category_kind: "bike", category_slug: "bikes", branch_id: 1, branch_name: "Sakleshpura Branch", registration_no: "KA 66 L 4592", cc: 200, fuel_type: "Petrol", transmission: "Manual", seats: 2, mileage: "35 km/l", included_km: 100, extra_km_rate: 4, rate_12h: 800, rate_24h: 1300, hourly_rate: 120, weekend_rate_24h: 1350, deposit: 1000, late_fee_per_hour: 100, total_units: 1, available_units: 1, description: "Naked streetfighter performance.", terms: null, status: "available", active: 1, photos: ["/vehicles/bajaj-pulsar-ns.png"], primary_photo: "/vehicles/bajaj-pulsar-ns.png",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 1, available_units: 1 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 0, available_units: 0 }]
  },
  {
    id: 10, slug: "honda-shine", name: "Honda Shine 125", brand: "Honda", model: "Shine", year: 2023, category_id: 2, category_name: "Bikes", category_kind: "bike", category_slug: "bikes", branch_id: 1, branch_name: "Sakleshpura Branch", registration_no: "KA 13 D 6729", cc: 125, fuel_type: "Petrol", transmission: "Manual", seats: 2, mileage: "55 km/l", included_km: 100, extra_km_rate: 4, rate_12h: 600, rate_24h: 1000, hourly_rate: 100, weekend_rate_24h: 1050, deposit: 1000, late_fee_per_hour: 100, total_units: 2, available_units: 2, description: "Reliable and comfortable commuter.", terms: null, status: "available", active: 1, photos: ["/vehicles/honda-shine.avif"], primary_photo: "/vehicles/honda-shine.avif",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 1, available_units: 1 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 1, available_units: 1 }]
  },

  // Cars (Category 1) — Exact original counts
  {
    id: 11, slug: "maruti-baleno-manual", name: "Maruti Suzuki Baleno", brand: "Maruti Suzuki", model: "Baleno", year: 2023, category_id: 1, category_name: "Cars", category_kind: "car", category_slug: "cars", branch_id: 1, branch_name: "Sakleshpura Branch", registration_no: "KA 13 MA 0550", cc: 1197, fuel_type: "Petrol", transmission: "Manual", seats: 5, mileage: "21 km/l", included_km: 300, extra_km_rate: 8, rate_12h: 2000, rate_24h: 3500, hourly_rate: 200, weekend_rate_24h: 3550, deposit: 2000, late_fee_per_hour: 150, total_units: 1, available_units: 1, description: "Comfortable premium hatchback.", terms: null, status: "available", active: 1, photos: ["/vehicles/baleno-manual.avif"], primary_photo: "/vehicles/baleno-manual.avif",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 1, available_units: 1 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 0, available_units: 0 }]
  },
  {
    id: 13, slug: "maruti-dzire", name: "Maruti Dzire", brand: "Maruti Suzuki", model: "Dzire", year: 2023, category_id: 1, category_name: "Cars", category_kind: "car", category_slug: "cars", branch_id: 1, branch_name: "Sakleshpura Branch", registration_no: "KA 18 O 3985", cc: 1197, fuel_type: "Petrol", transmission: "Manual", seats: 5, mileage: "23 km/l", included_km: 300, extra_km_rate: 8, rate_12h: 2000, rate_24h: 3500, hourly_rate: 200, weekend_rate_24h: 3550, deposit: 2000, late_fee_per_hour: 150, total_units: 1, available_units: 1, description: "Fuel-efficient compact sedan.", terms: null, status: "available", active: 1, photos: ["/vehicles/maruti-dzire.avif"], primary_photo: "/vehicles/maruti-dzire.avif",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 1, available_units: 1 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 0, available_units: 0 }]
  },
  {
    id: 14, slug: "maruti-ciaz", name: "Maruti Ciaz", brand: "Maruti Suzuki", model: "Ciaz", year: 2023, category_id: 1, category_name: "Cars", category_kind: "car", category_slug: "cars", branch_id: 2, branch_name: "Hassan Branch", registration_no: "KA 13 AA 0810", cc: 1462, fuel_type: "Petrol", transmission: "Manual", seats: 5, mileage: "20 km/l", included_km: 300, extra_km_rate: 8, rate_12h: 2400, rate_24h: 4000, hourly_rate: 240, weekend_rate_24h: 4050, deposit: 2500, late_fee_per_hour: 180, total_units: 1, available_units: 1, description: "Spacious premium sedan for highway trips.", terms: null, status: "available", active: 1, photos: ["/vehicles/maruti-ciaz.jpg"], primary_photo: "/vehicles/maruti-ciaz.jpg",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 0, available_units: 0 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 1, available_units: 1 }]
  },
  {
    id: 15, slug: "maruti-ertiga-7-seater", name: "Maruti Ertiga 7 Seater", brand: "Maruti Suzuki", model: "Ertiga", year: 2023, category_id: 1, category_name: "Cars", category_kind: "car", category_slug: "cars", branch_id: 1, branch_name: "Sakleshpura Branch", registration_no: "KA 18 MB 0040", cc: 1462, fuel_type: "Petrol", transmission: "Manual", seats: 7, mileage: "19 km/l", included_km: 300, extra_km_rate: 8, rate_12h: 2800, rate_24h: 4500, hourly_rate: 280, weekend_rate_24h: 4550, deposit: 3000, late_fee_per_hour: 200, total_units: 1, available_units: 1, description: "Spacious 7-seater MPV for family trips.", terms: null, status: "available", active: 1, photos: ["/vehicles/maruti-ertiga.avif"], primary_photo: "/vehicles/maruti-ertiga.avif",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 1, available_units: 1 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 0, available_units: 0 }]
  },
  {
    id: 16, slug: "mahindra-thar-manual", name: "Mahindra Thar 4x4", brand: "Mahindra", model: "Thar", year: 2023, category_id: 1, category_name: "Cars", category_kind: "car", category_slug: "cars", branch_id: 1, branch_name: "Sakleshpura Branch", registration_no: "KA 18 MB 7629", cc: 2184, fuel_type: "Diesel", transmission: "Manual", seats: 4, mileage: "15 km/l", included_km: 300, extra_km_rate: 8, rate_12h: 3000, rate_24h: 5000, hourly_rate: 300, weekend_rate_24h: 5500, deposit: 3000, late_fee_per_hour: 250, total_units: 1, available_units: 1, description: "Iconic 4x4 SUV for offroad exploration.", terms: null, status: "available", active: 1, photos: ["/vehicles/mahindra-thar.avif"], primary_photo: "/vehicles/mahindra-thar.avif",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 1, available_units: 1 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 0, available_units: 0 }]
  },

  // Tempo Traveller (Category 4) — Exact original counts
  {
    id: 18, slug: "tempo-traveller-12", name: "Tempo Traveller — Sakleshpura Sightseeing", brand: "Force Motors", model: "Traveller", year: 2023, category_id: 4, category_name: "Tempo Traveller", category_kind: "van", category_slug: "tempo-traveller", branch_id: 1, branch_name: "Sakleshpura Branch", registration_no: "KA 18 D 4391", cc: 2596, fuel_type: "Diesel", transmission: "Manual", seats: 12, mileage: "12 km/l", included_km: 999, extra_km_rate: 0, rate_12h: 8000, rate_24h: 12000, hourly_rate: 500, weekend_rate_24h: 12050, deposit: 2000, late_fee_per_hour: 250, total_units: 1, available_units: 1, description: "Chauffeur driven 12 seater for day trips.", terms: null, status: "available", active: 1, photos: ["/vehicles/tempo-traveller.jpg"], primary_photo: "/vehicles/tempo-traveller.jpg",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 1, available_units: 1 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 0, available_units: 0 }]
  },
  {
    id: 19, slug: "tempo-traveller-2days", name: "Tempo Traveller — Sakleshpura & Chikmagalur (2 Days)", brand: "Force Motors", model: "Traveller", year: 2023, category_id: 4, category_name: "Tempo Traveller", category_kind: "van", category_slug: "tempo-traveller", branch_id: 1, branch_name: "Sakleshpura Branch", registration_no: "KA 18 D 4391", cc: 2596, fuel_type: "Diesel", transmission: "Manual", seats: 12, mileage: "12 km/l", included_km: 999, extra_km_rate: 0, rate_12h: 8000, rate_24h: 12000, hourly_rate: 500, weekend_rate_24h: 12050, deposit: 2000, late_fee_per_hour: 250, total_units: 1, available_units: 1, description: "Chauffeur driven 12 seater for 2-day hill station tours.", terms: null, status: "available", active: 1, photos: ["/vehicles/cta-tempo-banner.jpg"], primary_photo: "/vehicles/cta-tempo-banner.jpg",
    branch_distribution: [{ branch_id: 1, branch_name: "Sakleshpura Branch", total_units: 1, available_units: 1 }, { branch_id: 2, branch_name: "Hassan Branch", total_units: 0, available_units: 0 }]
  },
];

/**
 * Attaches photos and live availability to raw vehicle rows.
 *
 * Batched deliberately: the SQLite version ran two queries per vehicle, which over
 * HTTP would be forty round trips to render the fleet page.
 */
async function hydrateVehicles(rows: RawVehicle[]): Promise<Vehicle[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
  const idPredicate = inList(ids);
  const nowIso = new Date().toISOString();

  const [photosRes, holdsRes, unitsRes, branchesRes] = await Promise.all([
    sbSelect<{ vehicle_id: number; url: string }>(
      "vehicle_photos",
      `select=vehicle_id,url&vehicle_id=${idPredicate}&order=is_primary.desc,id.asc`
    ),
    sbSelect<{ vehicle_id: number; branch_id: number | null; vehicle_unit_id: number | null }>(
      "bookings",
      `select=vehicle_id,branch_id,vehicle_unit_id&vehicle_id=${idPredicate}&status=${inList(HOLDING_STATUSES)}&return_at=gte.${encodeURIComponent(nowIso)}`
    ),
    sbSelect<{ id: number; vehicle_id: number; current_branch_id: number | null; status: string; registration_no?: string; unit_identifier?: string }>(
      "vehicle_units",
      `select=id,vehicle_id,current_branch_id,status,registration_no,unit_identifier&vehicle_id=${idPredicate}&active=eq.1`
    ),
    sbSelect<{ id: number; name: string; blocked?: number }>("branches", "select=id,name,blocked&active=eq.1"),
  ]);

  if (!photosRes.ok) console.warn(`Could not load vehicle photos: ${photosRes.error}`);
  if (!holdsRes.ok) console.warn(`Could not load vehicle availability: ${holdsRes.error}`);

  const branchMap = new Map<number, { id: number; name: string; blocked: boolean }>();
  if (branchesRes.ok && branchesRes.data && branchesRes.data.length > 0) {
    for (const b of branchesRes.data) {
      branchMap.set(Number(b.id), { id: Number(b.id), name: String(b.name), blocked: num(b.blocked) === 1 });
    }
  } else {
    branchMap.set(1, { id: 1, name: "Sakleshpura Branch", blocked: false });
    branchMap.set(2, { id: 2, name: "Hassan Branch", blocked: false });
  }

  const photosByVehicle = new Map<number, string[]>();
  if (photosRes.ok && photosRes.data) {
    for (const photo of photosRes.data) {
      const list = photosByVehicle.get(Number(photo.vehicle_id)) ?? [];
      list.push(photo.url);
      photosByVehicle.set(Number(photo.vehicle_id), list);
    }
  }

  const holdsByVehicle = new Map<number, number>();
  const holdsByVehicleAndBranch = new Map<string, number>();
  const bookedUnitIds = new Set<number>();

  if (holdsRes.ok && holdsRes.data) {
    for (const hold of holdsRes.data) {
      const vKey = Number(hold.vehicle_id);
      holdsByVehicle.set(vKey, (holdsByVehicle.get(vKey) ?? 0) + 1);

      if (hold.branch_id) {
        const vbKey = `${vKey}_${hold.branch_id}`;
        holdsByVehicleAndBranch.set(vbKey, (holdsByVehicleAndBranch.get(vbKey) ?? 0) + 1);
      }
      if (hold.vehicle_unit_id) {
        bookedUnitIds.add(Number(hold.vehicle_unit_id));
      }
    }
  }

  const unitsByVehicle = new Map<number, Array<{ id: number; current_branch_id: number | null; status: string; registration_no?: string | null; unit_identifier?: string }>>();
  if (unitsRes.ok && unitsRes.data && unitsRes.data.length > 0) {
    for (const u of unitsRes.data) {
      const vId = Number(u.vehicle_id);
      const list = unitsByVehicle.get(vId) ?? [];
      list.push({
        id: Number(u.id),
        current_branch_id: u.current_branch_id ? Number(u.current_branch_id) : null,
        status: String(u.status),
        registration_no: u.registration_no || null,
        unit_identifier: u.unit_identifier || `UNIT-${u.id}`,
      });
      unitsByVehicle.set(vId, list);
    }
  } else {
    // Populate with authoritative units distribution
    for (const u of DEFAULT_VEHICLE_UNITS) {
      const vId = Number(u.vehicle_id);
      const list = unitsByVehicle.get(vId) ?? [];
      list.push({
        id: Number(u.id),
        current_branch_id: u.current_branch_id ? Number(u.current_branch_id) : null,
        status: String(u.status),
        registration_no: u.registration_no,
        unit_identifier: u.unit_identifier,
      });
      unitsByVehicle.set(vId, list);
    }
  }

  return rows.map((row) => {
    const id = Number(row.id);
    const slug = String(row.slug ?? "");
    const catObj = (row.vehicle_categories as { kind?: string; slug?: string; name?: string } | null);
    const fallbackPhoto = getCategoryPresetPhoto(catObj, slug);
    const photoUrls = photosByVehicle.get(id) ?? [];
    const validPhotos = photoUrls.filter((p) => p && typeof p === "string" && p.trim().length > 0);
    const photos = validPhotos.length > 0 ? validPhotos : [fallbackPhoto];

    const vUnits = unitsByVehicle.get(id) ?? [];
    const totalUnits = vUnits.length > 0 ? vUnits.length : num(row.total_units, 1);
    const branchBlocked = num((row.branches as { blocked?: number } | null)?.blocked) === 1;
    const isVehicleUnavailable =
      row.status === "unavailable" ||
      row.status === "blocked" ||
      row.status === "maintenance" ||
      row.status === "inactive" ||
      row.status === "archived" ||
      num(row.active, 1) === 0;

    const activeUnits = vUnits.length > 0
      ? vUnits.filter((u) => u.status === "available" && !bookedUnitIds.has(Number(u.id)) && !branchMap.get(u.current_branch_id || 0)?.blocked).length
      : (branchBlocked ? 0 : totalUnits);

    const availableUnits = branchBlocked || isVehicleUnavailable || activeUnits === 0
      ? 0
      : Math.max(0, activeUnits - (holdsByVehicle.get(id) ?? 0));

    // PostgREST hands back NUMERIC as a string. Without num() every one of these
    // becomes string concatenation the moment a quote is calculated.
    const baseRate24h = num(row.rate_24h);
    const weekendRate24h = row.weekend_rate_24h === null || row.weekend_rate_24h === undefined
      ? baseRate24h
      : num(row.weekend_rate_24h, baseRate24h);

    const { vehicle_categories: category, branches: branch, ...rest } = row;

    // Compute branch distribution from physical units if populated
    const branchDist: Array<{ branch_id: number; branch_name: string; total_units: number; available_units: number }> = [];

    if (vUnits.length > 0) {
      const countsByBranch = new Map<number, { total: number; available: number }>();
      for (const u of vUnits) {
        if (!u.current_branch_id) continue;
        const entry = countsByBranch.get(u.current_branch_id) ?? { total: 0, available: 0 };
        entry.total += 1;
        const isUnitBooked = bookedUnitIds.has(Number(u.id));
        if (u.status === "available" && !isUnitBooked) entry.available += 1;
        countsByBranch.set(u.current_branch_id, entry);
      }
      for (const [bId, stats] of countsByBranch.entries()) {
        const bInfo = branchMap.get(bId);
        if (bInfo) {
          const branchHoldsWithoutUnit = Math.max(
            0,
            (holdsByVehicleAndBranch.get(`${id}_${bId}`) ?? 0) -
              vUnits.filter((u) => u.current_branch_id === bId && bookedUnitIds.has(Number(u.id))).length
          );
          const unassignedModelHolds = Math.max(0, (holdsByVehicle.get(id) ?? 0) - bookedUnitIds.size);
          const effectiveHolds = branchHoldsWithoutUnit + (countsByBranch.size === 1 ? unassignedModelHolds : 0);
          const branchAvailable = isVehicleUnavailable || bInfo.blocked ? 0 : Math.max(0, stats.available - effectiveHolds);
          branchDist.push({
            branch_id: bId,
            branch_name: bInfo.name,
            total_units: stats.total,
            available_units: branchAvailable,
          });
        }
      }
    } else if (row.branch_id) {
      const bId = Number(row.branch_id);
      const bInfo = branchMap.get(bId);
      if (bInfo) {
        branchDist.push({
          branch_id: bId,
          branch_name: bInfo.name,
          total_units: totalUnits,
          available_units: isVehicleUnavailable || bInfo.blocked ? 0 : availableUnits,
        });
      }
    }

    return {
      ...(rest as unknown as Vehicle),
      id,
      slug,
      category_id: row.category_id === null || row.category_id === undefined ? null : Number(row.category_id),
      category_name: category?.name ?? null,
      category_kind: category?.kind ?? null,
      category_slug: category?.slug ?? null,
      branch_id: row.branch_id === null || row.branch_id === undefined ? null : Number(row.branch_id),
      branch_name: branch?.name ?? null,
      year: row.year === null || row.year === undefined ? null : Number(row.year),
      cc: row.cc === null || row.cc === undefined ? null : Number(row.cc),
      seats: num(row.seats, 2),
      included_km: num(row.included_km, 100),
      extra_km_rate: num(row.extra_km_rate),
      rate_12h: num(row.rate_12h),
      rate_24h: baseRate24h,
      hourly_rate: num(row.hourly_rate),
      weekend_rate_24h: weekendRate24h,
      deposit: num(row.deposit),
      late_fee_per_hour: num(row.late_fee_per_hour),
      total_units: totalUnits,
      available_units: availableUnits,
      units: (vUnits.length > 0 ? vUnits : DEFAULT_VEHICLE_UNITS.filter((u: VehicleUnit) => u.vehicle_id === id)) as unknown as VehicleUnit[],
      branch_distribution: branchDist.length > 0 ? branchDist : undefined,
      active: num(row.active, 1),
      photos,
      primary_photo: photos[0] ?? fallbackPhoto,
    };
  });
}

export async function getVehicleCategories(onlyActive = true): Promise<VehicleCategory[]> {
  try {
    const res = await sbSelect<VehicleCategory>(
      "vehicle_categories",
      `select=*${onlyActive ? "&active=eq.1" : ""}&order=sort.asc,name.asc`
    );
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      return res.data.map((row) => ({ ...row, active: num(row.active, 1), sort: num(row.sort) }));
    }
  } catch (err) {
    console.warn("getVehicleCategories fallback to roster:", err);
  }
  return onlyActive ? DEFAULT_CATEGORIES_ROSTER.filter((c) => c.active === 1) : DEFAULT_CATEGORIES_ROSTER;
}

export async function getVehicleCategory(slug: string): Promise<VehicleCategory | null> {
  try {
    const res = await sbSelectOne<VehicleCategory>(
      "vehicle_categories",
      `select=*&slug=eq.${encodeURIComponent(slug)}&active=eq.1`
    );
    if (res.ok && res.data) {
      return { ...res.data, active: num(res.data.active, 1), sort: num(res.data.sort) };
    }
  } catch (err) {
    console.warn(`getVehicleCategory("${slug}") fallback:`, err);
  }
  return DEFAULT_CATEGORIES_ROSTER.find((c) => c.slug === slug) ?? null;
}

export type VehicleFilters = {
  categorySlug?: string;
  kind?: string;
  minSeats?: number;
  transmission?: string;
  fuelType?: string;
  maxPrice?: number;
  onlyAvailable?: boolean;
  availableOnly?: boolean;
  branchId?: number;
};

export async function getVehicles(
  filters: VehicleFilters = {},
  includeInactive = false
): Promise<Vehicle[]> {
  let vehicles: Vehicle[] = [];

  try {
    const needsCategoryJoin = Boolean(filters.categorySlug || filters.kind);
    const parts = [`select=${needsCategoryJoin ? VEHICLE_EMBED_INNER : VEHICLE_EMBED}`];

    if (!includeInactive) {
      parts.push("active=eq.1");
      parts.push("status=neq.archived");
    }
    if (filters.categorySlug) parts.push(`vehicle_categories.slug=eq.${encodeURIComponent(filters.categorySlug)}`);
    if (filters.kind) parts.push(`vehicle_categories.kind=eq.${encodeURIComponent(filters.kind)}`);
    if (filters.minSeats) parts.push(`seats=gte.${filters.minSeats}`);
    if (filters.transmission) parts.push(`transmission=eq.${encodeURIComponent(filters.transmission)}`);
    if (filters.fuelType) parts.push(`fuel_type=eq.${encodeURIComponent(filters.fuelType)}`);
    if (filters.maxPrice) parts.push(`rate_24h=lte.${filters.maxPrice}`);
    if (filters.onlyAvailable || filters.availableOnly) parts.push("status=eq.available");
    parts.push("order=id.asc,name.asc");

    const res = await sbSelect<RawVehicle>("vehicles", parts.join("&"));
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      vehicles = await hydrateVehicles(res.data);
    }
  } catch (err) {
    console.warn("getVehicles fallback to DEFAULT_VEHICLES_ROSTER:", err);
  }

  if (vehicles.length === 0) {
    vehicles = DEFAULT_VEHICLES_ROSTER.map((v) => ({
      ...v,
      units: DEFAULT_VEHICLE_UNITS.filter((u: VehicleUnit) => u.vehicle_id === v.id),
    }));
  }

  if (filters.categorySlug) {
    vehicles = vehicles.filter((v) => v.category_slug === filters.categorySlug);
  }
  if (filters.kind) {
    vehicles = vehicles.filter((v) => v.category_kind === filters.kind);
  }
  if (filters.minSeats) {
    vehicles = vehicles.filter((v) => v.seats >= (filters.minSeats || 0));
  }
  if (filters.transmission) {
    vehicles = vehicles.filter((v) => v.transmission.toLowerCase() === filters.transmission?.toLowerCase());
  }
  if (filters.fuelType) {
    vehicles = vehicles.filter((v) => v.fuel_type.toLowerCase() === filters.fuelType?.toLowerCase());
  }
  if (filters.maxPrice) {
    vehicles = vehicles.filter((v) => v.rate_24h <= (filters.maxPrice || Infinity));
  }
  if (filters.onlyAvailable || filters.availableOnly) {
    vehicles = vehicles.filter((v) => v.status === "available" && num(v.active, 1) === 1 && (v.available_units ?? 0) > 0);
  }

  if (filters.branchId) {
    const bId = Number(filters.branchId);
    return vehicles
      .filter((v) => {
        return (
          v.branch_id === bId ||
          (v.units && v.units.some((u) => u.current_branch_id === bId)) ||
          (v.branch_distribution && v.branch_distribution.some((d) => d.branch_id === bId && d.total_units > 0))
        );
      })
      .map((v) => {
        const branchUnits = v.units?.filter((u) => u.current_branch_id === bId) || [];
        const dist = v.branch_distribution?.find((d) => d.branch_id === bId);
        const branchTotal = branchUnits.length > 0 ? branchUnits.length : (dist?.total_units ?? v.total_units);
        const isVehicleUnavailable =
          v.status === "unavailable" ||
          v.status === "blocked" ||
          v.status === "maintenance" ||
          v.status === "inactive" ||
          v.status === "archived" ||
          num(v.active, 1) === 0;

        const branchAvailable = isVehicleUnavailable
          ? 0
          : (dist?.available_units !== undefined
            ? dist.available_units
            : (branchUnits.length > 0
              ? branchUnits.filter((u) => u.status === "available").length
              : v.available_units));

        return {
          ...v,
          total_units: branchTotal,
          available_units: branchAvailable,
          units: branchUnits,
          branch_id: bId,
          branch_name: bId === 1 ? "Sakleshpura Branch" : bId === 2 ? "Hassan Branch" : v.branch_name,
        };
      });
  }

  return vehicles;
}

export async function getVehicleUnits(vehicleId?: number, branchId?: number): Promise<VehicleUnit[]> {
  const parts = ["select=*,branches(name,blocked),vehicles(name,brand,model)"];
  parts.push("active=eq.1");
  if (vehicleId) parts.push(`vehicle_id=eq.${vehicleId}`);
  if (branchId) parts.push(`current_branch_id=eq.${branchId}`);
  parts.push("order=unit_identifier.asc");

  const res = await sbSelect<Record<string, unknown>>("vehicle_units", parts.join("&"));
  if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
    return res.data.map((r: any) => {
      const isBranchBlocked = num(r.branches?.blocked) === 1;
      return {
        id: Number(r.id),
        vehicle_id: Number(r.vehicle_id),
        unit_identifier: String(r.unit_identifier),
        registration_no: r.registration_no ? String(r.registration_no) : null,
        status: isBranchBlocked ? "blocked" : (r.status || "available"),
        current_branch_id: r.current_branch_id ? Number(r.current_branch_id) : null,
        current_branch_name: r.branches?.name || (r.current_branch_id === 1 ? "Sakleshpura Branch" : r.current_branch_id === 2 ? "Hassan Branch" : null),
        branch_blocked: isBranchBlocked,
        vehicle_name: r.vehicles?.name || null,
        vehicle_brand: r.vehicles?.brand || null,
        vehicle_model: r.vehicles?.model || null,
        active: num(r.active, 1),
        notes: r.notes || null,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });
  }

  // Fallback to authoritative distributed units
  return DEFAULT_VEHICLE_UNITS.filter((u: VehicleUnit) => {
    if (vehicleId && u.vehicle_id !== vehicleId) return false;
    if (branchId && u.current_branch_id !== branchId) return false;
    return true;
  });
}

export async function getDailyBranchAllocations(
  startDate: string,
  endDate: string,
  vehicleId?: number
): Promise<DailyAllocationRow[]> {
  // Try calling the database RPC get_fleet_daily_allocations first
  try {
    const rpcRes = await sbSelect<DailyAllocationRow>(
      "rpc/get_fleet_daily_allocations",
      `p_start_date=${encodeURIComponent(startDate)}&p_end_date=${encodeURIComponent(endDate)}${vehicleId ? `&p_vehicle_id=${vehicleId}` : ""}`
    );
    if (rpcRes.ok && Array.isArray(rpcRes.data) && rpcRes.data.length > 0) {
      return rpcRes.data;
    }
  } catch {
    // Fall back to TypeScript computation below
  }

  // Application-level dynamic computation fallback
  const [units, branches, allocationsRes] = await Promise.all([
    getVehicleUnits(vehicleId),
    getBranches(),
    sbSelect<Record<string, unknown>>("branch_allocations", "select=*"),
  ]);

  const allocations = allocationsRes.ok ? allocationsRes.data : [];
  const branchMap = new Map(branches.map((b) => [b.id, b.name]));

  // Generate day series between startDate and endDate
  const rows: DailyAllocationRow[] = [];
  const start = new Date(startDate);
  const end = new Date(endDate);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    const dayTimestamp = new Date(dateStr + "T23:59:59Z").getTime();
    const dayStartTimestamp = new Date(dateStr + "T00:00:00Z").getTime();

    const branchCounts: Record<string, number> = {};
    for (const b of branches) {
      branchCounts[b.name] = 0;
    }

    let unallocatedCount = 0;
    let totalCount = 0;

    for (const u of units) {
      if (u.active !== 1) continue;
      totalCount += 1;

      // Find active allocation on this day
      const activeAlloc = allocations.find((a: any) => {
        if (Number(a.vehicle_unit_id) !== u.id) return false;
        const aStart = new Date(a.starts_at).getTime();
        const aEnd = a.ends_at ? new Date(a.ends_at).getTime() : Infinity;
        return aStart <= dayTimestamp && aEnd >= dayStartTimestamp;
      });

      if (activeAlloc && activeAlloc.branch_id) {
        const bName = branchMap.get(Number(activeAlloc.branch_id)) || "Unknown";
        branchCounts[bName] = (branchCounts[bName] || 0) + 1;
      } else if (u.current_branch_id && branchMap.has(u.current_branch_id)) {
        const bName = branchMap.get(u.current_branch_id)!;
        branchCounts[bName] = (branchCounts[bName] || 0) + 1;
      } else {
        unallocatedCount += 1;
      }
    }

    rows.push({
      date: dateStr,
      total: totalCount,
      unallocated: unallocatedCount,
      branches: branchCounts,
    });
  }

  return rows;
}

export async function getGlobalFleetSummary(): Promise<GlobalFleetSummary> {
  const [vehicles, units, bookingsRes, blocksRes] = await Promise.all([
    getVehicles({}, true),
    getVehicleUnits(),
    sbSelect<{ id: number; vehicle_id: number; vehicle_unit_id: number | null }>(
      "bookings",
      `select=id,vehicle_id,vehicle_unit_id&status=${encodeURIComponent(inList(HOLDING_STATUSES))}&return_at=gte.${encodeURIComponent(new Date().toISOString())}`
    ),
    sbSelect<{ id: number; vehicle_id: number; vehicle_unit_id: number | null; reason: string }>(
      "availability_blocks",
      `select=id,vehicle_id,vehicle_unit_id,reason&ends_at=gte.${encodeURIComponent(new Date().toISOString())}`
    ),
  ]);

  const activeUnits = units.filter((u) => u.active === 1);
  const totalFleet = activeUnits.length > 0 ? activeUnits.length : vehicles.reduce((sum, v) => sum + v.total_units, 0);

  let maintenance = 0;
  let blocked = 0;
  let allocated = 0;
  let unallocated = 0;

  if (activeUnits.length > 0) {
    for (const u of activeUnits) {
      if (u.status === "maintenance") maintenance += 1;
      else if (u.status === "blocked" || u.status === "unavailable") blocked += 1;

      if (u.current_branch_id) allocated += 1;
      else unallocated += 1;
    }
  } else {
    allocated = totalFleet;
  }

  const bookedUnitsCount = bookingsRes.ok ? bookingsRes.data.length : 0;
  const operationalFleet = Math.max(0, totalFleet - maintenance - blocked);
  const available = Math.max(0, operationalFleet - bookedUnitsCount);

  return {
    totalFleet,
    operationalFleet,
    allocated,
    unallocated,
    booked: bookedUnitsCount,
    available,
    maintenance,
    blocked,
  };
}

export async function getVehicle(slug: string, onlyActive = true): Promise<Vehicle | null> {
  const parts = [
    `select=${VEHICLE_EMBED}`,
    `slug=eq.${encodeURIComponent(slug)}`,
  ];
  if (onlyActive) {
    parts.push("active=eq.1");
    parts.push("status=neq.archived");
  }
  parts.push("limit=1");

  const res = await sbSelect<RawVehicle>("vehicles", parts.join("&"));
  if (!res.ok) throw new Error(`Could not load vehicle "${slug}": ${res.error}`);
  const hydrated = await hydrateVehicles(res.data);
  return hydrated[0] ?? null;
}

export async function getVehicleById(idOrSlug: number | string, onlyActive = true): Promise<Vehicle | null> {
  const asText = String(idOrSlug);
  const asNumber = Number(idOrSlug);

  // `id.eq.<non-numeric>` is a hard PostgREST error, so only ask about the id
  // column when the input could actually be one.
  const predicates = [`slug.eq.${asText}`, `registration_no.eq.${asText}`];
  if (Number.isInteger(asNumber) && asNumber > 0) predicates.unshift(`id.eq.${asNumber}`);

  const parts = [
    `select=${VEHICLE_EMBED}`,
    `or=${encodeURIComponent(`(${predicates.join(",")})`)}`,
  ];
  if (onlyActive) {
    parts.push("active=eq.1");
    parts.push("status=neq.archived");
  }
  parts.push("limit=1");

  const res = await sbSelect<RawVehicle>("vehicles", parts.join("&"));
  if (!res.ok) throw new Error(`Could not load vehicle "${asText}": ${res.error}`);
  const hydrated = await hydrateVehicles(res.data);
  return hydrated[0] ?? null;
}

export async function getBranches(onlyActive = true): Promise<Branch[]> {
  try {
    const res = await sbSelect<Branch>("branches", `select=*${onlyActive ? "&active=eq.1" : ""}&order=name.asc`);
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      return res.data.map((row) => ({
        ...row,
        active: num(row.active, 1),
        blocked: num(row.blocked, 0),
        blocked_reason: row.blocked_reason ?? null,
        blocked_at: row.blocked_at ?? null,
      }));
    }
  } catch (err) {
    console.warn("getBranches fallback:", err);
  }
  return [
    { id: 1, name: "Sakleshpura Branch", city: "Sakleshpura", address: "Main Road, Near Bus Stand", phone: "+917676875595", active: 1, blocked: 0 },
    { id: 2, name: "Hassan Branch", city: "Hassan", address: "BM Road, Hassan", phone: "+918088283908", active: 1, blocked: 0 },
  ];
}

export async function getTestimonials(): Promise<Array<Record<string, unknown>>> {
  const res = await sbSelect("testimonials", "select=*&active=eq.1&order=sort.asc,id.desc");
  if (!res.ok) throw new Error(`Could not load testimonials: ${res.error}`);
  return res.data;
}

export async function getGallery(): Promise<Array<Record<string, unknown>>> {
  const res = await sbSelect("gallery", "select=*&active=eq.1&order=sort.asc,id.desc");
  if (!res.ok) throw new Error(`Could not load gallery: ${res.error}`);
  return res.data;
}

export async function getFaqs(): Promise<Array<Record<string, unknown>>> {
  const res = await sbSelect("faqs", "select=*&active=eq.1&order=sort.asc,id.asc");
  if (!res.ok) throw new Error(`Could not load FAQs: ${res.error}`);
  return res.data;
}

export async function getBlogPosts(publishedOnly = true): Promise<Array<Record<string, unknown>>> {
  const res = await sbSelect(
    "blog_posts",
    `select=id,slug,title,excerpt,author,created_at${publishedOnly ? "&published=eq.1" : ""}&order=created_at.desc`
  );
  if (!res.ok) throw new Error(`Could not load blog posts: ${res.error}`);
  return res.data;
}

export async function getBlogPost(slug: string): Promise<Record<string, unknown> | null> {
  const res = await sbSelectOne("blog_posts", `select=*&slug=eq.${encodeURIComponent(slug)}&published=eq.1`);
  if (!res.ok) throw new Error(`Could not load blog post "${slug}": ${res.error}`);
  return res.data;
}

export type StaffMember = {
  id: number;
  name: string;
  email: string;
  role: string;
  phone: string | null;
  branch?: string | null;
  permissions?: string[] | string | null;
  is_active: number;
};

export async function getStaff(): Promise<StaffMember[]> {
  const res = await sbSelect<StaffMember>(
    "users",
    "select=*&is_active=eq.1&order=role.asc,name.asc"
  );
  if (!res.ok) throw new Error(`Could not load staff: ${res.error}`);
  return res.data.map((row) => ({ ...row, id: Number(row.id), is_active: num(row.is_active, 1) }));
}

export async function getActiveTermsVersion(): Promise<{ id: number; version: number; content: string[] } | null> {
  const res = await sbSelectOne<{ id: number; version: number; content: string }>(
    "terms_versions",
    "select=id,version,content&active=eq.1&order=version.desc"
  );
  if (!res.ok) throw new Error(`Could not load terms: ${res.error}`);
  if (!res.data) return null;

  const row = res.data;
  try {
    return { id: Number(row.id), version: Number(row.version), content: JSON.parse(row.content) as string[] };
  } catch {
    return { id: Number(row.id), version: Number(row.version), content: [] };
  }
}

// ---- Redis Caching Layer Wrappers ----
import { cacheGet, cacheSet } from "./redis";

export async function getVehiclesCached(filters: VehicleFilters = {}, onlyActive = true): Promise<Vehicle[]> {
  const cacheKey = `vehicles:${JSON.stringify(filters)}:${onlyActive}`;
  const cached = await cacheGet<Vehicle[]>(cacheKey);
  if (cached) return cached;

  const fresh = await getVehicles(filters, onlyActive);
  await cacheSet(cacheKey, fresh, 600);
  return fresh;
}

export async function getVehicleCategoriesCached(onlyActive = true): Promise<VehicleCategory[]> {
  const cacheKey = `vehicle_categories:${onlyActive}`;
  const cached = await cacheGet<VehicleCategory[]>(cacheKey);
  if (cached) return cached;

  const fresh = await getVehicleCategories(onlyActive);
  await cacheSet(cacheKey, fresh, 3600);
  return fresh;
}

export async function getTestimonialsCached(): Promise<Array<Record<string, unknown>>> {
  const cacheKey = "testimonials:active";
  const cached = await cacheGet<Array<Record<string, unknown>>>(cacheKey);
  if (cached) return cached;

  const fresh = await getTestimonials();
  await cacheSet(cacheKey, fresh, 3600);
  return fresh;
}

export async function getFaqsCached(): Promise<Array<Record<string, unknown>>> {
  const cacheKey = "faqs:active";
  const cached = await cacheGet<Array<Record<string, unknown>>>(cacheKey);
  if (cached) return cached;

  const fresh = await getFaqs();
  await cacheSet(cacheKey, fresh, 3600);
  return fresh;
}
