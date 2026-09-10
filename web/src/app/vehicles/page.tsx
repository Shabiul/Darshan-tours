import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { getVehicles, getVehicleCategories, getBranches, getPricingRules } from "@/lib/data";
import { toCanonicalIstIso } from "@/lib/rental-clock";
import { formatINR, formatDate } from "@/lib/utils";
import { EmptyState } from "@/components/ui";
import { Reveal } from "@/components/ui/Reveal";
import { isWeekend } from "@/lib/pricing";
import { BookingBar } from "@/components/BookingBar";
import { getCachedVehicleSearchPrice } from "@/lib/search-pricing";
import { absoluteUrl, breadcrumbJsonLd, jsonLdGraph, BUSINESS_ID } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Browse Vehicles",
  description: "Browse our full fleet of self-drive bikes, scooters and cars with fixed, transparent pricing across Hassan & Sakleshpura branches.",
  alternates: { canonical: "/vehicles" },
  openGraph: {
    title: "Browse Vehicles | Darshh Holiday",
    description: "Browse our full fleet of self-drive bikes, scooters and cars with fixed, transparent pricing across Hassan & Sakleshpura branches.",
    type: "website",
    images: [{ url: "/logo.jpeg", width: 792, height: 685, alt: "Darshh Holiday vehicle fleet" }],
  },
};
export const dynamic = "force-dynamic";
export const revalidate = 0;

const FLEET_VIDEO = "https://videos.pexels.com/video-files/5061405/5061405-sd_640_360_30fps.mp4";

export default async function VehiclesPage(
  props: {
    searchParams: Promise<{
      kind?: string;
      location?: string;
      branch?: string;
      branchId?: string;
      pickup?: string;
      pickupTime?: string;
      return?: string;
      returnTime?: string;
    }>;
  }
) {
  const searchParams = await props.searchParams;
  const kind = searchParams.kind;
  const location = searchParams.location;
  const branchParam = searchParams.branch || searchParams.branchId || searchParams.location;

  // Resolve branch: '1' or 'SAKLESHPURA' -> 1, '2' or 'HASSAN' -> 2
  const selectedBranchId = branchParam
    ? branchParam === "1" || branchParam.toUpperCase().includes("SAKLESH")
      ? 1
      : branchParam === "2" || branchParam.toUpperCase().includes("HASSAN")
      ? 2
      : undefined
    : undefined;

  const pickupDate = searchParams.pickup;
  const pickupTime = searchParams.pickupTime || "08:00";
  const returnDate = searchParams.return;
  const returnTime = searchParams.returnTime || "08:00";

  // Same dates already used below for pricing — reused here so a hold on ONE day no
  // longer marks the vehicle Out of Stock on every day shown (was previously undated).
  const availabilityWindow = pickupDate && returnDate
    ? {
        pickupAt: toCanonicalIstIso(pickupDate, pickupTime) || `${pickupDate}T${pickupTime}:00+05:30`,
        returnAt: toCanonicalIstIso(returnDate, returnTime) || `${returnDate}T${returnTime}:00+05:30`,
      }
    : undefined;

  const [categories, branches, vehicles, pricingRules] = await Promise.all([
    getVehicleCategories(),
    getBranches(),
    getVehicles({
      kind: kind || undefined,
      branchId: selectedBranchId,
      location: branchParam || undefined,
      availabilityWindow,
    }),
    getPricingRules(),
  ]);

  const activeBranch = selectedBranchId ? branches.find((b) => b.id === selectedBranchId) : null;

  // Compute temporary Redis-cached search prices for all vehicles if dates were provided
  const hasSearchQuery = Boolean(pickupDate && returnDate);
  const searchQuotes = hasSearchQuery
    ? await Promise.all(
        vehicles.map((v) => getCachedVehicleSearchPrice(v, pickupDate, pickupTime, returnDate, returnTime, pricingRules))
      )
    : [];

  const queryParamsStr = new URLSearchParams();
  if (kind) queryParamsStr.set("kind", kind);
  if (location) queryParamsStr.set("location", location);
  else if (selectedBranchId) queryParamsStr.set("branch", String(selectedBranchId));
  if (pickupDate) queryParamsStr.set("pickup", pickupDate);
  if (pickupTime) queryParamsStr.set("pickupTime", pickupTime);
  if (returnDate) queryParamsStr.set("return", returnDate);
  if (returnTime) queryParamsStr.set("returnTime", returnTime);
  const queryString = queryParamsStr.toString() ? `?${queryParamsStr.toString()}` : "";

  function buildFilterUrl(newKind?: string) {
    const params = new URLSearchParams();
    const effectiveKind = newKind !== undefined ? newKind : kind;

    if (effectiveKind) params.set("kind", effectiveKind);
    if (location) params.set("location", location);
    else if (selectedBranchId) params.set("branch", String(selectedBranchId));
    if (pickupDate) params.set("pickup", pickupDate);
    if (pickupTime) params.set("pickupTime", pickupTime);
    if (returnDate) params.set("return", returnDate);
    if (returnTime) params.set("returnTime", returnTime);

    const str = params.toString();
    return `/vehicles${str ? `?${str}` : ""}`;
  }

  // An enumerable fleet. This is the single highest-value piece of structured data on
  // the site for answer engines: it turns "what bikes can I rent in Sakleshpura and
  // what do they cost" from something a model has to infer out of rendered HTML into a
  // list it can read, quote and cite directly, with each entry pointing at the vehicle
  // page that can be linked in the answer. Every field mirrors what is already visible
  // on the card — no new claims, no prices that differ from the page.
  const itemListJsonLd = {
    "@type": "ItemList",
    name: "Self-drive vehicle fleet — Hassan & Sakleshpura",
    numberOfItems: vehicles.length,
    itemListElement: vehicles.map((v, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: {
        "@type": "Product",
        "@id": absoluteUrl(`/vehicles/${v.slug}#product`),
        name: v.name,
        url: absoluteUrl(`/vehicles/${v.slug}`),
        ...(v.primary_photo ? { image: absoluteUrl(String(v.primary_photo)) } : {}),
        category: v.category_name ?? undefined,
        brand: v.brand ? { "@type": "Brand", name: String(v.brand) } : undefined,
        offers: {
          "@type": "Offer",
          price: Number(v.rate_24h ?? 0),
          priceCurrency: "INR",
          availability:
            (v.available_units ?? 0) > 0
              ? "https://schema.org/InStock"
              : "https://schema.org/OutOfStock",
          url: absoluteUrl(`/vehicles/${v.slug}`),
          seller: { "@id": BUSINESS_ID },
        },
      },
    })),
  };

  const vehiclesGraph = jsonLdGraph(
    itemListJsonLd,
    breadcrumbJsonLd([{ name: "Vehicles", path: "/vehicles" }])
  );

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(vehiclesGraph) }} />
      <section className="grain relative -mt-20 sm:-mt-24 overflow-hidden border-b border-ink-100 bg-ink-950 pt-20 sm:pt-24 text-white">
        <Image src="/vehicles/mahindra-thar.avif" alt="" aria-hidden fill priority className="object-cover object-center" sizes="100vw" />
        <video
          className="hero-video absolute inset-0 h-full w-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          disablePictureInPicture
          disableRemotePlayback
          preload="auto"
          poster="/vehicles/mahindra-thar.avif"
          aria-hidden
          tabIndex={-1}
        >
          <source src={FLEET_VIDEO} type="video/mp4" />
        </video>
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/60 to-ink-950/40" aria-hidden />
        <div className="container-x relative py-16 sm:py-20">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-400/30 bg-brand-500/10 px-4 py-1.5 text-xs font-bold uppercase tracking-[0.28em] text-brand-300">
              {vehicles.length} vehicles available
            </span>
            {activeBranch && (
              <span className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold backdrop-blur-md ${
                Number((activeBranch as any).blocked) === 1
                  ? "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                  : "border border-white/20 bg-white/10 text-white"
              }`}>
                🏢 {activeBranch.name} {Number((activeBranch as any).blocked) === 1 ? "🔒 (Branch Blocked)" : `(${activeBranch.id === 1 ? "KA-46" : "KA-13"})`}
              </span>
            )}
          </div>
          <h1 className="mt-5 max-w-xl font-display text-4xl font-black leading-[1.02] sm:text-5xl">
            Self-drive bike, scooter &amp; car rental fleet
          </h1>
          <p className="mt-4 max-w-lg text-base leading-relaxed text-white/70">
            Fixed pricing, 50-50 fleet distribution across Sakleshpura &amp; Hassan branches, no bargaining. Every vehicle shows its exact branch stock and complete price breakdown.
          </p>
        </div>
      </section>

      {/* Interactive Search Bar Section */}
      <section className="relative z-30 -mt-6 sm:-mt-8 mb-8 container-x">
        <BookingBar
          categories={categories}
          initialValues={{
            kind,
            location: selectedBranchId === 1 ? "SAKLESHPURA" : selectedBranchId === 2 ? "HASSAN" : (location || ""),
            pickup: pickupDate,
            pickupTime,
            return: returnDate,
            returnTime,
          }}
        />
      </section>

      <section className="container-x pb-16">
        {/* Blocked Branch Notification Banner */}
        {activeBranch && Number((activeBranch as any).blocked) === 1 && (
          <div className="mb-6 rounded-2xl border border-rose-300 bg-rose-50 p-4 text-rose-900 shadow-sm flex items-center gap-3">
            <span className="text-2xl">⚠️</span>
            <div>
              <p className="text-sm font-bold">{activeBranch.name} is Temporarily Blocked</p>
              <p className="text-xs text-rose-700 mt-0.5">
                New online bookings for vehicles at this branch are currently suspended. All vehicles below are marked out of stock.
              </p>
            </div>
          </div>
        )}

        {/* Search Pricing Notification Banner */}
        {hasSearchQuery && searchQuotes[0] && (!activeBranch || Number((activeBranch as any).blocked) !== 1) && (
          <div className="mb-6 rounded-2xl border border-brand-300 bg-brand-50/90 p-4 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded bg-brand-500 px-2 py-0.5 text-[10px] font-extrabold uppercase text-ink-950">
                  Trip Pricing
                </span>
                <span className="text-sm font-bold text-ink-900">
                  {searchQuotes[0].days} Day{searchQuotes[0].days > 1 ? "s" : ""} Duration
                </span>
              </div>
              <p className="mt-1 text-xs text-ink-700">
                Calculated for {formatDate(pickupDate)} ({pickupTime}) → {formatDate(returnDate)} ({returnTime}).
                {searchQuotes[0].weekendDaysCount > 0 && ` Includes each vehicle's own weekend rate for Sat/Sun.`}
              </p>
            </div>
            <Link
              href={buildFilterUrl(kind)}
              className="text-xs font-semibold text-brand-800 underline hover:text-brand-950 self-start sm:self-auto"
            >
              Reset to regular prices
            </Link>
          </div>
        )}

        {/* Category Pills Filter */}
        <div className="flex flex-wrap gap-2 mb-6">
          <Link
            href={buildFilterUrl("")}
            className={`badge ring-1 ring-inset transition ${!kind ? "bg-brand-500 text-ink-950 ring-brand-500" : "bg-white text-ink-600 ring-ink-200 hover:border-brand-400"}`}
          >
            All
          </Link>
          {Array.from(new Map(categories.map((c) => [c.kind, c])).values()).map((c) => {
            const isCatActive = kind === c.kind;
            return (
              <Link
                key={c.kind}
                href={buildFilterUrl(c.kind)}
                className={`badge ring-1 ring-inset transition ${isCatActive ? "bg-brand-500 text-ink-950 ring-brand-500" : "bg-white text-ink-600 ring-ink-200 hover:border-brand-400"}`}
              >
                {c.icon && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d={c.icon} />
                  </svg>
                )}
                {c.name}
              </Link>
            );
          })}
        </div>

        {vehicles.length === 0 ? (
          <div className="mt-8">
            <EmptyState
              title="No vehicles found for this branch or category"
              body="Try switching between Sakleshpura and Hassan branches or selecting all categories."
            />
          </div>
        ) : (
          <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {vehicles.map((v, i) => {
              const isBranchBlocked = activeBranch ? Number((activeBranch as any).blocked) === 1 : false;
              const totalUnits = v.total_units ?? 1;
              const isVehicleUnavailable =
                v.status === "unavailable" ||
                v.status === "blocked" ||
                v.status === "maintenance" ||
                v.status === "inactive" ||
                v.status === "archived" ||
                Number(v.active) === 0 ||
                (v.status ? v.status !== "available" && v.status !== "active" : false);

              const availableUnits = isBranchBlocked || isVehicleUnavailable ? 0 : (v.available_units ?? totalUnits);
              const isOutOfStock = isBranchBlocked || isVehicleUnavailable || availableUnits <= 0;
              const weekendActive = isWeekend();
              const quote = searchQuotes[i];

              const bookingParams = queryParamsStr.toString() ? `&${queryParamsStr.toString()}` : "";
              const cardHref = isOutOfStock
                ? `/vehicles/${v.slug}${queryString}`
                : hasSearchQuery
                  ? `/booking?vehicle=${v.id}${bookingParams}&step=3`
                  : `/vehicles/${v.slug}${queryString}`;

              const branchDisplay = activeBranch?.name || v.branch_name || (v.branch_id === 1 ? "Sakleshpura Branch" : v.branch_id === 2 ? "Hassan Branch" : null);

              return (
                <Reveal key={v.id} delay={(i % 6) * 60}>
                  <Link
                    href={cardHref}
                    aria-label={isOutOfStock ? `${v.name} — currently unavailable` : v.name}
                    className={`group card block overflow-hidden transition-all duration-300 ${
                      isOutOfStock
                        ? "opacity-60 saturate-0 grayscale-[30%]"
                        : "hover:-translate-y-1.5 hover:shadow-lift"
                    }`}
                  >
                    <div className="relative h-48 overflow-hidden bg-ink-100">
                      {v.primary_photo && (
                        <Image
                          src={v.primary_photo}
                          alt={`${v.name} self-drive rental in Hassan & Sakleshpura`}
                          fill
                          loading="lazy"
                          className={`object-contain p-4 transition-transform duration-500 ${isOutOfStock ? "" : "group-hover:scale-110"}`}
                          sizes="(max-width:768px) 100vw, 33vw"
                        />
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-ink-950/50 via-transparent to-transparent opacity-0 transition group-hover:opacity-100" aria-hidden />
                      <span className="absolute left-3 top-3 badge bg-white/95 text-ink-800 shadow-sm font-semibold">
                        {v.category_name}
                      </span>
                      <span
                        className={`absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold shadow-md ${
                          isOutOfStock
                            ? "bg-rose-600 text-white"
                            : availableUnits <= 1
                            ? "bg-amber-500 text-ink-950"
                            : "bg-ink-950/90 text-brand-300 backdrop-blur-sm"
                        }`}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" className="shrink-0" aria-hidden>
                          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                        </svg>
                        {isOutOfStock ? (isBranchBlocked ? "Branch Blocked" : "Out of Stock") : `${availableUnits}/${totalUnits} Left`}
                      </span>
                    </div>

                    <div className="p-5">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="font-display text-lg font-semibold text-ink-900">{v.name}</h3>
                        {quote && quote.weekendDaysCount > 0 ? (
                          <span className="inline-block rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-800 uppercase tracking-wider">
                            +₹50 Weekend
                          </span>
                        ) : weekendActive && !quote ? (
                          <span className="inline-block rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-800 uppercase tracking-wider">
                            +₹50 Weekend
                          </span>
                        ) : null}
                      </div>

                      {/* Branch & Registration Display */}
                      <div className="mt-1 flex items-center gap-2 flex-wrap text-xs">
                        {branchDisplay && (
                          <span className="inline-flex items-center gap-1 font-semibold text-brand-800 bg-brand-50 border border-brand-200/80 rounded-md px-2 py-0.5 text-[11px]">
                            🏢 {branchDisplay}
                          </span>
                        )}
                        {v.registration_no && (
                          <span className="font-mono text-ink-500 text-[11px] bg-ink-50 px-1.5 py-0.5 rounded border border-ink-200">
                            {v.registration_no}
                          </span>
                        )}
                      </div>

                      <p className="mt-2 text-xs text-ink-500">
                        {v.fuel_type} · {v.seats} seats · {v.included_km >= 999 ? "Unlimited KM" : `${v.included_km} km/day`}
                      </p>
                      <p className="mt-2 flex items-center gap-1 text-xs font-medium text-emerald-700">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                        {formatINR(v.deposit)} refundable deposit
                      </p>

                      <div className="mt-4 flex items-end justify-between border-t border-ink-100 pt-4">
                        <div>
                          {quote ? (
                            <div>
                              <p className="text-sm text-ink-500">
                                <span className="font-display text-xl font-bold text-ink-900">{formatINR(quote.baseAmount)}</span>
                                <span className="text-xs"> for {quote.days} day{quote.days > 1 ? "s" : ""}</span>
                              </p>
                              <p className="text-[11px] text-ink-500 font-medium">
                                Total: {formatINR(quote.totalAmount)} (incl. GST &amp; Deposit)
                              </p>
                            </div>
                          ) : (
                            <p className="text-sm text-ink-500">
                              <span className="font-display text-xl font-semibold text-ink-900">{formatINR(v.rate_24h)}</span>
                              <span className="text-xs">/24h</span>
                            </p>
                          )}
                        </div>

                        {isOutOfStock ? (
                          <span className="flex items-center gap-1 rounded-full bg-ink-100 px-3 py-1 text-sm font-semibold text-ink-500">
                            Out of Stock
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-sm font-semibold text-brand-700 transition group-hover:gap-2">
                            {quote ? "Book Now" : "View & Book"}
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                              <path d="M5 12h14M13 6l6 6-6 6" />
                            </svg>
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                </Reveal>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

