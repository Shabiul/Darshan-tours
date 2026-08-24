import { cache } from "react";
import { gatewayGet, gatewayPost } from "./gateway";

export type VehicleCategory = {
  id: number; slug: string; name: string; kind: "bike" | "scooter" | "car" | "van";
  icon: string | null; image: string | null; short_desc: string | null; description: string | null; active: number; sort: number;
};

export type Vehicle = {
  id: number; slug: string; name: string; brand: string; model: string; year: number | null;
  category_id: number | null; category_name: string | null; category_kind: string | null; category_slug: string | null;
  branch_id: number | null; branch_name: string | null; registration_no: string | null; cc: number | null;
  fuel_type: string; transmission: string; seats: number; mileage: string | null; included_km: number;
  extra_km_rate: number; rate_12h: number; rate_24h: number; hourly_rate: number; weekend_rate_24h: number | null;
  deposit: number; late_fee_per_hour: number; total_units: number; available_units?: number; description: string | null; terms: string | null; status: string;
  branch_distribution?: Array<{ branch_id: number; branch_name: string; total_units: number; available_units: number }>;
  active: number; photos: string[]; primary_photo: string | null;
};

export type Branch = { id: number; name: string; city: string | null; address: string | null; phone: string | null; active: number; blocked?: number };

type Content = {
  business: Record<string, unknown>;
  rentalRules: Record<string, unknown>;
  categories: VehicleCategory[];
  vehicles: Vehicle[];
  testimonials: Array<Record<string, unknown>>;
  gallery: Array<Record<string, unknown>>;
  faqs: Array<Record<string, unknown>>;
  staff: Array<{ id: number; name: string; email: string; role: string; phone: string | null; is_active: number }>;
  terms: { id: number; version: number; content: string[] } | null;
  blogPosts: Array<Record<string, unknown>>;
  branches: Branch[];
};

const FALLBACK_CATEGORIES: VehicleCategory[] = [
  { id: 1, slug: "cars", name: "Cars", kind: "car", icon: null, image: "/vehicles/mahindra-thar.avif", short_desc: "Self-drive hatchbacks, sedans & SUVs", description: "Well maintained self-drive car fleet.", active: 1, sort: 1 },
  { id: 2, slug: "bikes", name: "Bikes", kind: "bike", icon: null, image: "/vehicles/tvs-ronin.avif", short_desc: "Cruisers and commuter bikes", description: "Well-serviced bikes for trips.", active: 1, sort: 2 },
  { id: 3, slug: "scooters", name: "Scooters", kind: "scooter", icon: null, image: "/vehicles/category-scooters.jpg", short_desc: "Automatic scooters for local travel", description: "Simple automatic scooters.", active: 1, sort: 3 },
  { id: 4, slug: "tempo-traveller", name: "Tempo Traveller", kind: "van", icon: null, image: "/vehicles/tempo-traveller.jpg", short_desc: "Chauffeur driven tempo traveller", description: "Group sightseeing trips.", active: 1, sort: 4 },
];

const FALLBACK_VEHICLES: Vehicle[] = [
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

const FALLBACK_BLOG_POSTS: Array<Record<string, unknown>> = [
  {
    id: 1,
    slug: "sakleshpura-to-chikmagalur-self-drive-guide",
    title: "Sakleshpura to Chikmagalur: A Self-Drive Road Trip Guide",
    excerpt: "Ghat roads, coffee estates and waterfalls — what to expect on the drive, and how to plan it well.",
    author: "Darshh Holiday Team",
    created_at: "2026-08-01T10:00:00Z",
    content: `The Sakleshpura–Chikmagalur stretch is one of the most rewarding short drives in the Western Ghats — coffee estates on both sides of the road, mist-covered hills for most of the year, and enough waterfalls and viewpoints to fill a full day without rushing.

Budget half a day for the drive alone if you're stopping along the way, longer if you're planning a proper detour to Mullayanagiri or Baba Budangiri. The ghat sections have sharp curves and sudden weather changes, especially during monsoon (June–September), so a vehicle with good tyres and brakes matters more than horsepower here.

A few practical notes for anyone planning this on a rented vehicle: fuel up before you start, since stations thin out once you're properly into the ghat stretches. Carry your driving licence and ID with you at all times — these routes do see checkpoints. And if you're on a two-wheeler, start early; the light through the estates is best in the first few hours after sunrise, and afternoon fog can roll in fast during the wetter months.

Whether you need a nimble scooter for winding roads or a proper SUV for the whole family, book with a fixed price upfront and know exactly what your kilometre allowance covers before you leave — no surprises at the end of the trip.`
  },
  {
    id: 2,
    slug: "hassan-district-weekend-getaways",
    title: "Hassan District Weekend Getaways You Can Reach in a Day",
    excerpt: "Belur, Halebidu, Shravanabelagola and the Sakleshpura ghats — a practical weekend circuit.",
    author: "Darshh Holiday Team",
    created_at: "2026-08-03T10:00:00Z",
    content: `Hassan district packs an unusual amount into a small area — centuries-old temple towns, a hilltop Jain monolith, and some of the greenest ghat roads in Karnataka, all within a couple of hours of each other.

Belur and Halebidu are the classic pairing — Hoysala-era temple architecture, roughly 40 minutes apart, both worth a couple of unhurried hours each. Shravanabelagola, home to the Gommateshwara statue, adds another hour or so of driving but is a genuinely different kind of stop — expect some walking (and stairs) once you arrive.

If you'd rather trade temples for hills, Sakleshpura and the road toward Chikmagalur cover the other end of the district's character — coffee country, waterfalls, and long stretches where the road itself is the reason for the trip.

Either circuit works comfortably as a single day out and back, or a relaxed overnight if you want to split the driving. A compact car or scooter is enough for the temple circuit; if the ghat roads are part of your plan, a vehicle with a bit more ground clearance makes for a smoother ride.`
  },
  {
    id: 3,
    slug: "documents-needed-self-drive-rental-karnataka",
    title: "What Documents Do You Need to Rent a Self-Drive Vehicle?",
    excerpt: "A quick, practical checklist so pickup takes five minutes, not fifty.",
    author: "Darshh Holiday Team",
    created_at: "2026-08-05T10:00:00Z",
    content: `Nothing slows down a pickup more than missing paperwork, so here's the short version of what to carry.

You'll need a valid driving licence appropriate to the vehicle class — a two-wheeler licence for bikes and scooters, a valid car licence for four-wheelers. Learner's licences aren't accepted. Alongside that, bring one government-issued photo ID: Aadhaar, passport or voter ID all work.

A refundable security deposit is collected at pickup and returned after the vehicle is inspected on return, minus any deductions for damage, late return or excess kilometres — each of which is itemised, never guessed at.

A couple of things that trip people up: make sure the name on your licence matches your ID exactly, and if you're booking for someone else, the person picking up the vehicle needs to be the one whose documents are on file. Bring physical copies where possible — a photo on your phone works in a pinch, but a printed or physical ID makes verification faster.

Get this sorted before you arrive and pickup genuinely takes a few minutes — inspect the vehicle together, sign, and you're on the road.`
  }
];

const EMPTY_CONTENT: Content = {
  business: {}, rentalRules: {}, categories: FALLBACK_CATEGORIES, vehicles: FALLBACK_VEHICLES, testimonials: [], gallery: [], faqs: [], staff: [], terms: null, blogPosts: FALLBACK_BLOG_POSTS, branches: [],
};

async function fetchContentFromSupabase(): Promise<Partial<Content> | null> {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    "";

  if (!supabaseUrl || !supabaseKey) return null;

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

    const nowIso = new Date().toISOString();
    const [
      { data: supaCategories },
      { data: supaVehicles },
      { data: supaPhotos },
      { data: supaBranches },
      { data: supaUnits },
      { data: supaBookings },
      { data: supaTestimonials },
      { data: supaFaqs },
      { data: supaTerms },
      { data: supaBlogPosts },
      { data: supaSettings },
    ] = await Promise.all([
      supabase.from("vehicle_categories").select("*").eq("active", 1).order("sort"),
      supabase.from("vehicles").select("*, vehicle_categories(name, kind, slug), branches(name)").eq("active", 1).neq("status", "archived"),
      supabase.from("vehicle_photos").select("*").order("is_primary", { ascending: false }),
      supabase.from("branches").select("*").eq("active", 1),
      supabase.from("vehicle_units").select("id, vehicle_id, current_branch_id, status, active").eq("active", 1),
      supabase.from("bookings").select("vehicle_id, branch_id, vehicle_unit_id, status, return_at").not("status", "in", '("Cancelled","Completed","Rejected")').gte("return_at", nowIso),
      supabase.from("testimonials").select("*").eq("active", 1).order("sort"),
      supabase.from("faqs").select("*").eq("active", 1).order("sort"),
      supabase.from("terms_versions").select("*").eq("active", 1).order("version", { ascending: false }).limit(1),
      supabase.from("blog_posts").select("*").eq("published", 1).order("created_at", { ascending: false }),
      supabase.from("settings").select("*"),
    ]);

    if (!supaVehicles) return null;

    const branchNameMap = new Map<number, string>();
    const branchBlockedMap = new Map<number, boolean>();
    if (supaBranches) {
      for (const b of supaBranches) {
        branchNameMap.set(b.id, b.name);
        branchBlockedMap.set(b.id, Number((b as any).blocked) === 1);
      }
    }

    const holdsByVehicle = new Map<number, number>();
    const holdsByVehicleAndBranch = new Map<string, number>();
    const bookedUnitIds = new Set<number>();

    if (supaBookings) {
      for (const b of supaBookings) {
        const vKey = Number(b.vehicle_id);
        holdsByVehicle.set(vKey, (holdsByVehicle.get(vKey) ?? 0) + 1);

        if (b.branch_id) {
          const vbKey = `${vKey}_${b.branch_id}`;
          holdsByVehicleAndBranch.set(vbKey, (holdsByVehicleAndBranch.get(vbKey) ?? 0) + 1);
        }
        if (b.vehicle_unit_id) {
          bookedUnitIds.add(Number(b.vehicle_unit_id));
        }
      }
    }

    const unitsByVehicle = new Map<number, Array<{ id: number; vehicle_id?: number; current_branch_id: number | null; status: string }>>();
    if (supaUnits && supaUnits.length > 0) {
      for (const u of supaUnits) {
        const list = unitsByVehicle.get(u.vehicle_id) || [];
        list.push(u);
        unitsByVehicle.set(u.vehicle_id, list);
      }
    } else {
      // 50-50 branch distribution fallback across Sakleshpura (1) and Hassan (2)
      const twoUnitScooters = new Set([1, 2, 3, 5]); // Dio, Activa, Jupiter, NTorq (4 units total: 2 Sakleshpura, 2 Hassan)
      for (const v of (supaVehicles || [])) {
        const vId = Number(v.id);
        const isTwoUnit = twoUnitScooters.has(vId);
        const list: Array<{ id: number; vehicle_id?: number; current_branch_id: number | null; status: string }> = [
          { id: vId * 100 + 1, vehicle_id: vId, current_branch_id: 1, status: "available" },
          { id: vId * 100 + 2, vehicle_id: vId, current_branch_id: 2, status: "available" },
        ];
        if (isTwoUnit) {
          list.push({ id: vId * 100 + 3, vehicle_id: vId, current_branch_id: 1, status: "available" });
          list.push({ id: vId * 100 + 4, vehicle_id: vId, current_branch_id: 2, status: "available" });
        }
        unitsByVehicle.set(vId, list);
      }
    }

    const photoMap = new Map<number, { photos: string[]; primary: string }>();
    if (supaPhotos) {
      for (const p of supaPhotos) {
        const photoUrl = (p as any).url || (p as any).photo_url;
        if (!photoUrl) continue;
        const entry = photoMap.get(p.vehicle_id) || { photos: [], primary: "" };
        entry.photos.push(photoUrl);
        if (p.is_primary) entry.primary = photoUrl;
        photoMap.set(p.vehicle_id, entry);
      }
    }

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

    const vehicles: Vehicle[] = (supaVehicles || []).map((v: any) => {
      const cat = v.vehicle_categories;
      const ph = photoMap.get(v.id);
      const catStr = `${cat?.kind || ""} ${cat?.slug || ""} ${cat?.name || ""}`.toLowerCase();
      let fallback = DEFAULT_SLUG_PHOTOS[v.slug];
      if (!fallback) {
        if (catStr.includes("scooter") || catStr.includes("activa") || catStr.includes("jupiter") || catStr.includes("dio")) {
          fallback = "/vehicles/honda-activa.webp";
        } else if (catStr.includes("bike") || catStr.includes("motorcycle") || catStr.includes("two-wheeler") || catStr.includes("shine") || catStr.includes("pulsar") || catStr.includes("ronin")) {
          fallback = "/vehicles/honda-shine.avif";
        } else if (catStr.includes("tempo") || catStr.includes("traveller") || catStr.includes("van") || catStr.includes("bus")) {
          fallback = "/vehicles/tempo-traveller.jpg";
        } else {
          fallback = "/vehicles/baleno-manual.avif";
        }
      }
      const vehiclePhotos = ph?.photos && ph.photos.length > 0 ? ph.photos : (Array.isArray(v.photos) ? v.photos : [fallback]);
      const branchName = v.branches?.name || (v.branch_id ? branchNameMap.get(v.branch_id) : null) || null;

      // Compute branch distribution
      const isVehicleUnavailable =
        v.status === "unavailable" ||
        v.status === "blocked" ||
        v.status === "maintenance" ||
        v.status === "inactive" ||
        v.status === "archived" ||
        Number(v.active) === 0;

      const vUnits = unitsByVehicle.get(v.id) || [];
      const branchDist: Array<{ branch_id: number; branch_name: string; total_units: number; available_units: number }> = [];

      if (vUnits.length > 0) {
        const counts = new Map<number, { total: number; available: number }>();
        for (const u of vUnits) {
          if (!u.current_branch_id) continue;
          const entry = counts.get(u.current_branch_id) || { total: 0, available: 0 };
          entry.total += 1;
          const isUnitBooked = bookedUnitIds.has(Number(u.id));
          if (u.status === "available" && !isUnitBooked && !branchBlockedMap.get(u.current_branch_id)) entry.available += 1;
          counts.set(u.current_branch_id, entry);
        }
        for (const [bId, stats] of counts.entries()) {
          const bName = branchNameMap.get(bId) || `Branch ${bId}`;
          const isBranchBlocked = Boolean(branchBlockedMap.get(bId));
          const branchHoldsWithoutUnit = Math.max(
            0,
            (holdsByVehicleAndBranch.get(`${v.id}_${bId}`) ?? 0) -
              vUnits.filter((u) => u.current_branch_id === bId && bookedUnitIds.has(Number(u.id))).length
          );
          const unassignedModelHolds = Math.max(0, (holdsByVehicle.get(v.id) ?? 0) - bookedUnitIds.size);
          const effectiveHolds = branchHoldsWithoutUnit + (counts.size === 1 ? unassignedModelHolds : 0);
          const branchAvailable = isVehicleUnavailable || isBranchBlocked ? 0 : Math.max(0, stats.available - effectiveHolds);
          branchDist.push({
            branch_id: bId,
            branch_name: bName,
            total_units: stats.total,
            available_units: branchAvailable,
          });
        }
      } else if (v.branch_id) {
        const bName = branchNameMap.get(v.branch_id) || branchName || "Main Branch";
        const isBranchBlocked = Boolean(branchBlockedMap.get(v.branch_id));
        const totalU = v.total_units || 1;
        const holds = holdsByVehicle.get(v.id) ?? 0;
        branchDist.push({
          branch_id: v.branch_id,
          branch_name: bName,
          total_units: totalU,
          available_units: isVehicleUnavailable || isBranchBlocked ? 0 : Math.max(0, (v.available_units ?? totalU) - holds),
        });
      }

      const activeUnitsCount = vUnits.length > 0
        ? vUnits.filter((u) => u.status === "available" && !bookedUnitIds.has(Number(u.id)) && !branchBlockedMap.get(u.current_branch_id || 0)).length
        : (branchBlockedMap.get(v.branch_id || 0) ? 0 : (v.available_units ?? v.total_units ?? 1));

      const totalAvailable = isVehicleUnavailable
        ? 0
        : Math.max(0, activeUnitsCount - (holdsByVehicle.get(v.id) ?? 0));

      return {
        ...v,
        branch_name: branchName,
        category_name: cat?.name || v.category_name || "Vehicle",
        category_kind: cat?.kind || v.category_kind || "car",
        category_slug: cat?.slug || v.category_slug || "cars",
        photos: vehiclePhotos,
        primary_photo: ph?.primary || vehiclePhotos[0] || fallback,
        available_units: totalAvailable,
        branch_distribution: branchDist.length > 0 ? branchDist : undefined,
        vehicle_categories: undefined,
      };
    });

    const settingsMap = new Map((supaSettings ?? []).map((s: any) => [s.key, s.value]));
    let parsedTerms: { id: number; version: number; content: string[] } | null = null;
    if (supaTerms && supaTerms.length > 0) {
      const t = supaTerms[0];
      let contentArr: string[] = [];
      try {
        contentArr = typeof t.content === "string" ? JSON.parse(t.content) : (t.content || []);
      } catch {
        contentArr = Array.isArray(t.content) ? t.content : [];
      }
      parsedTerms = { id: t.id, version: t.version, content: contentArr };
    }

    return {
      categories: (supaCategories && supaCategories.length > 0 ? supaCategories : FALLBACK_CATEGORIES) as VehicleCategory[],
      vehicles,
      branches: (supaBranches ?? []) as Branch[],
      testimonials: (supaTestimonials ?? []) as Array<Record<string, unknown>>,
      faqs: (supaFaqs ?? []) as Array<Record<string, unknown>>,
      terms: parsedTerms,
      blogPosts: (supaBlogPosts && supaBlogPosts.length > 0 ? supaBlogPosts : FALLBACK_BLOG_POSTS) as Array<Record<string, unknown>>,
      business: Object.fromEntries(settingsMap),
    };
  } catch (err) {
    console.warn("Supabase direct content query fallback exception:", err);
    return null;
  }
}

/** Fetched once per request (React cache dedupes repeated calls within the same render
 * pass) — the CRM gateway returns the whole read-mostly content model in one payload. */
export const getContent = cache(async (): Promise<Content> => {
  try {
    const data = await gatewayGet<Content & { error?: string }>("/api/gateway/v1/content", { revalidate: 0 });
    if (data && !("error" in data) && Array.isArray(data.vehicles)) {
      return {
        ...data,
        blogPosts: data.blogPosts?.length ? data.blogPosts : FALLBACK_BLOG_POSTS,
      };
    }
  } catch (err) {
    console.warn("Gateway getContent fetch warning:", err);
  }

  // Direct Supabase Live Data Fallback
  const supaContent = await fetchContentFromSupabase();
  if (supaContent && Array.isArray(supaContent.vehicles)) {
    return {
      ...EMPTY_CONTENT,
      ...supaContent,
      categories: supaContent.categories?.length ? supaContent.categories : FALLBACK_CATEGORIES,
      vehicles: supaContent.vehicles,
      blogPosts: supaContent.blogPosts?.length ? supaContent.blogPosts : FALLBACK_BLOG_POSTS,
    } as Content;
  }

  return {
    ...EMPTY_CONTENT,
    categories: FALLBACK_CATEGORIES,
    vehicles: FALLBACK_VEHICLES,
    blogPosts: FALLBACK_BLOG_POSTS,
  };
});

export async function getVehicleCategories(): Promise<VehicleCategory[]> {
  return (await getContent()).categories;
}

export async function getVehicleCategory(slug: string): Promise<VehicleCategory | null> {
  return (await getContent()).categories.find((c) => c.slug === slug) ?? null;
}

import { num } from "./pricing";

export type VehicleFilters = {
  categorySlug?: string;
  kind?: string;
  /** Branch/location the customer is collecting from, e.g. "HASSAN" or "SAKLESHPURA" */
  location?: string;
  branchId?: number;
};

/**
 * Normalises the two rate columns. The weekend rate is the vehicle's OWN
 * `weekend_rate_24h`; when it is null the weekday rate stands. The old
 * `Math.max(baseRate + 50, …)` invented a ₹50 weekend surcharge and also silently
 * overrode genuine equal-price vehicles (Ronin, CB200X, Shine), which is why the site
 * quoted more than the CRM charged.
 */
function withRates<T extends { rate_24h?: number | string | null; weekend_rate_24h?: number | string | null }>(v: T): T {
  const baseRate = num(v.rate_24h);
  const weekend = num(v.weekend_rate_24h, 0);
  return { ...v, rate_24h: baseRate, weekend_rate_24h: weekend > 0 ? weekend : baseRate };
}

function matchesLocation(branchName: string | null, location?: string): boolean {
  if (!location) return true;
  if (!branchName) return false;
  return branchName.toLowerCase().includes(location.trim().toLowerCase());
}

export async function getVehicles(filters: VehicleFilters = {}): Promise<Vehicle[]> {
  const { vehicles, branches } = await getContent();
  const matched: Vehicle[] = [];

  const targetBranchId = filters.branchId
    ? Number(filters.branchId)
    : filters.location
      ? (filters.location.toUpperCase().includes("SAKLESH") ? 1 : filters.location.toUpperCase().includes("HASSAN") ? 2 : undefined)
      : undefined;

  const targetBranch = targetBranchId ? branches.find((b) => Number(b.id) === targetBranchId) : null;
  const isTargetBranchBlocked = targetBranch ? Number((targetBranch as any).blocked) === 1 : false;

  for (const v of vehicles) {
    if (filters.kind && v.category_kind !== filters.kind) continue;
    if (filters.categorySlug && v.category_slug !== filters.categorySlug) continue;

    const isVehicleUnavailable =
      v.status === "unavailable" ||
      v.status === "blocked" ||
      v.status === "maintenance" ||
      v.status === "inactive" ||
      v.status === "archived" ||
      Number(v.active) === 0;

    if (targetBranchId) {
      const bName = targetBranchId === 1 ? "Sakleshpura Branch" : "Hassan Branch";
      const match = v.branch_distribution?.find((bd) => bd.branch_id === targetBranchId);

      if (match) {
        if (match.total_units > 0) {
          const avail = isTargetBranchBlocked || isVehicleUnavailable ? 0 : (match.available_units !== undefined ? match.available_units : match.total_units);
          matched.push({
            ...v,
            total_units: match.total_units,
            available_units: avail,
            branch_id: targetBranchId,
            branch_name: bName,
          });
        }
      } else if (!v.branch_distribution || v.branch_distribution.length === 0) {
        if (v.branch_id === targetBranchId || !v.branch_id) {
          matched.push({
            ...v,
            available_units: isTargetBranchBlocked || isVehicleUnavailable ? 0 : (v.available_units ?? v.total_units ?? 1),
            branch_id: targetBranchId,
            branch_name: bName,
          });
        }
      }
    } else {
      const allBranchesBlocked = v.branch_distribution && v.branch_distribution.length > 0
        ? v.branch_distribution.every((bd) => Number(branches.find((b) => Number(b.id) === bd.branch_id)?.blocked) === 1)
        : (v.branch_id ? Number(branches.find((b) => Number(b.id) === v.branch_id)?.blocked) === 1 : false);

      matched.push({
        ...v,
        available_units: isVehicleUnavailable || allBranchesBlocked ? 0 : (v.available_units ?? v.total_units ?? 1),
      });
    }
  }

  return matched.map(withRates);
}

export async function getVehicle(slug: string): Promise<Vehicle | null> {
  const v = (await getContent()).vehicles.find((v) => v.slug === slug) ?? null;
  return v ? withRates(v) : null;
}

export async function getVehicleById(id: number): Promise<Vehicle | null> {
  const v = (await getContent()).vehicles.find((v) => v.id === id) ?? null;
  return v ? withRates(v) : null;
}

export async function getTestimonials() {
  return (await getContent()).testimonials;
}

export async function getGallery() {
  return (await getContent()).gallery;
}

export async function getFaqs() {
  return (await getContent()).faqs;
}

export async function getStaff() {
  return (await getContent()).staff;
}

export async function getActiveTermsVersion() {
  return (await getContent()).terms;
}

export async function getBranches(): Promise<Branch[]> {
  const { branches } = await getContent();
  if (branches && branches.length > 0) return branches;
  return [
    { id: 1, name: "Sakleshpura Branch", address: "Main Road, Near Bus Stand", city: "Sakleshpura", phone: "+917676875595", active: 1 },
    { id: 2, name: "Hassan Branch", address: "BM Road, Hassan", city: "Hassan", phone: "+918088283908", active: 1 },
  ];
}

export async function getBlogPosts() {
  return (await getContent()).blogPosts;
}

export async function getBlogPost(slug: string): Promise<Record<string, unknown> | null> {
  const res = await gatewayPost<{ post: Record<string, unknown> | null }>("/api/gateway/v1/content", { op: "blogPost", slug });
  if (res?.post) return res.post;
  return FALLBACK_BLOG_POSTS.find((p) => p.slug === slug) ?? null;
}

