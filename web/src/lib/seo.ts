/**
 * Centralised SEO / structured-data helpers.
 *
 * Everything Google, Bing and the AI answer engines (ChatGPT Search, Perplexity,
 * Gemini/AI Overviews, Claude) read about this site is generated from here, so the
 * facts live in ONE place and cannot drift between pages the way hand-written JSON-LD
 * blocks do. All of it is <head>/<script> metadata — none of it renders visible copy.
 *
 * Canonical host is www: the apex 308-redirects to https://www.selfdrive.bike, so every
 * canonical, sitemap entry and @id must use www or Google sees two competing URLs for
 * the same page and splits the ranking signals between them.
 */

export const SITE_URL = "https://www.selfdrive.bike";
export const SITE_NAME = "Darshh Holiday";

/** Stable @id anchors. Schema.org nodes reference each other by these, which is what
 * lets a crawler understand "this AutoRental IS this Organization" rather than treating
 * them as two unrelated businesses that happen to share a name. */
export const ORG_ID = `${SITE_URL}/#organization`;
export const WEBSITE_ID = `${SITE_URL}/#website`;
export const BUSINESS_ID = `${SITE_URL}/#autorental`;

export function absoluteUrl(path = "/"): string {
  return path.startsWith("http") ? path : `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

type BranchLike = {
  id: number;
  name: string;
  city?: string | null;
  address?: string | null;
  phone?: string | null;
  active?: number;
};

/** Approximate town-centre coordinates for the two towns served. Deliberately
 * town-level rather than invented door-level precision — a wrong rooftop pin is worse
 * for local ranking than an honest town centroid. */
const BRANCH_GEO: Record<string, { lat: number; lng: number }> = {
  sakleshpura: { lat: 12.9585, lng: 75.7859 },
  hassan: { lat: 13.0072, lng: 76.0962 },
};

function geoFor(branch: BranchLike) {
  const key = String(branch.city ?? branch.name ?? "").toLowerCase();
  if (key.includes("sakl")) return BRANCH_GEO.sakleshpura;
  if (key.includes("hassan")) return BRANCH_GEO.hassan;
  return null;
}

/** The site itself, with the search action that makes Google eligible to render a
 * sitelinks searchbox under the main result. */
export function websiteJsonLd() {
  return {
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    url: SITE_URL,
    name: SITE_NAME,
    publisher: { "@id": ORG_ID },
    inLanguage: "en-IN",
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${SITE_URL}/vehicles?kind={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  };
}

export function organizationJsonLd(info: Record<string, unknown>) {
  const social = (info.social ?? {}) as Record<string, unknown>;
  const sameAs = [social.instagram, social.facebook, social.youtube]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);

  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: String(info.name ?? SITE_NAME),
    url: SITE_URL,
    logo: { "@type": "ImageObject", url: absoluteUrl("/logo.jpeg"), width: 792, height: 685 },
    image: absoluteUrl("/logo.jpeg"),
    email: info.email ? String(info.email) : undefined,
    telephone: info.phone ? String(info.phone) : undefined,
    ...(sameAs.length > 0 ? { sameAs } : {}),
    contactPoint: [
      {
        "@type": "ContactPoint",
        telephone: String(info.phone ?? ""),
        contactType: "reservations",
        areaServed: "IN",
        availableLanguage: ["en", "kn", "hi"],
      },
    ],
  };
}

/**
 * The rental business itself, plus one child node per physical branch.
 *
 * AutoRental is the specific schema.org type for vehicle rental, and is what makes the
 * business eligible for the local/vehicle-rental treatment rather than being read as a
 * generic company page. Each branch is its own AutoRental node with its own address,
 * geo and phone — that is the part local search (and "bike rental near me in
 * Sakleshpura" style AI answers) actually keys off.
 */
export function localBusinessJsonLd(info: Record<string, unknown>, branches: BranchLike[]) {
  const activeBranches = branches.filter((b) => Number(b.active ?? 1) === 1);
  const social = (info.social ?? {}) as Record<string, unknown>;
  const sameAs = [social.instagram, social.facebook, social.youtube]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);

  // "Pre-booking only, Mon–Sun, 8:00 AM – 8:00 AM" — the rental day runs 08:00 to 08:00,
  // so the business is contactable every day. Expressed as an all-week specification
  // rather than a guessed 9-to-5 that would be wrong.
  const openingHoursSpecification = [
    {
      "@type": "OpeningHoursSpecification",
      dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      opens: "08:00",
      closes: "20:00",
    },
  ];

  const branchNodes = activeBranches.map((b) => {
    const geo = geoFor(b);
    return {
      "@type": "AutoRental",
      "@id": `${SITE_URL}/#branch-${b.id}`,
      name: `${String(info.name ?? SITE_NAME)} — ${b.name}`,
      parentOrganization: { "@id": ORG_ID },
      url: SITE_URL,
      image: absoluteUrl("/logo.jpeg"),
      telephone: b.phone ? String(b.phone) : info.phone ? String(info.phone) : undefined,
      priceRange: "₹₹",
      currenciesAccepted: "INR",
      paymentAccepted: "Cash, UPI, Credit Card, Debit Card, Net Banking",
      address: {
        "@type": "PostalAddress",
        streetAddress: b.address ?? undefined,
        addressLocality: b.city ?? undefined,
        addressRegion: "Karnataka",
        addressCountry: "IN",
      },
      ...(geo ? { geo: { "@type": "GeoCoordinates", latitude: geo.lat, longitude: geo.lng } } : {}),
      openingHoursSpecification,
      areaServed: [
        { "@type": "City", name: "Sakleshpura" },
        { "@type": "City", name: "Hassan" },
        { "@type": "City", name: "Chikmagalur" },
      ],
    };
  });

  const main = {
    "@type": "AutoRental",
    "@id": BUSINESS_ID,
    name: String(info.name ?? SITE_NAME),
    description:
      "Self-drive bike, scooter and car rentals across Hassan district, Karnataka — fixed transparent pricing, no bargaining, well-maintained fleet.",
    url: SITE_URL,
    image: absoluteUrl("/logo.jpeg"),
    logo: absoluteUrl("/logo.jpeg"),
    telephone: info.phone ? String(info.phone) : undefined,
    email: info.email ? String(info.email) : undefined,
    priceRange: "₹₹",
    currenciesAccepted: "INR",
    paymentAccepted: "Cash, UPI, Credit Card, Debit Card, Net Banking",
    parentOrganization: { "@id": ORG_ID },
    address: {
      "@type": "PostalAddress",
      streetAddress: info.address ? String(info.address) : undefined,
      addressLocality: info.city ? String(info.city) : "Hassan",
      addressRegion: "Karnataka",
      addressCountry: "IN",
    },
    geo: { "@type": "GeoCoordinates", latitude: BRANCH_GEO.sakleshpura.lat, longitude: BRANCH_GEO.sakleshpura.lng },
    openingHoursSpecification,
    areaServed: [
      { "@type": "City", name: "Sakleshpura" },
      { "@type": "City", name: "Hassan" },
      { "@type": "City", name: "Chikmagalur" },
      { "@type": "AdministrativeArea", name: "Hassan district" },
    ],
    ...(sameAs.length > 0 ? { sameAs } : {}),
    ...(activeBranches.length > 0 ? { department: branchNodes.map((n) => ({ "@id": n["@id"] })) } : {}),
  };

  return [main, ...branchNodes];
}

/** One breadcrumb trail. Pass the trail WITHOUT the "Home" crumb — it is prepended. */
export function breadcrumbJsonLd(trail: Array<{ name: string; path: string }>) {
  const items = [{ name: "Home", path: "/" }, ...trail];
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

/** Wraps any set of nodes into one @graph document — one script tag per page instead of
 * several competing ones, which is what lets nodes cross-reference by @id. */
export function jsonLdGraph(...nodes: Array<Record<string, unknown> | Array<Record<string, unknown>>>) {
  return {
    "@context": "https://schema.org",
    "@graph": nodes.flat(),
  };
}
