import { getVehicles, getBranches, getFaqs } from "@/lib/data";
import { businessInfo } from "@/lib/settings";
import { SITE_URL } from "@/lib/seo";

export const revalidate = 3600;

/**
 * /llms.txt — the emerging convention (llmstxt.org) for handing an AI crawler a clean,
 * factual, plain-text brief instead of making it infer the business out of rendered
 * markup, video backgrounds and Tailwind classes.
 *
 * Why this matters here specifically: the pages that sell this business are heavily
 * visual and client-interactive (the fleet grid computes prices per selected date, the
 * booking flow is a multi-step client component). A model fetching those URLs can
 * easily come away without the two facts that decide whether it recommends this
 * business — WHERE it operates (Sakleshpura and Hassan) and WHAT it costs. This states
 * both up front, in the order an answer engine reads.
 *
 * Everything below is generated from the same live data the pages render, so it can
 * never drift into claiming a vehicle or a price that the site does not actually show.
 */
export async function GET() {
  const [info, branches, vehicles, faqs] = await Promise.all([
    businessInfo().catch(() => ({}) as Record<string, unknown>),
    getBranches().catch(() => []),
    getVehicles().catch(() => []),
    getFaqs().catch(() => []),
  ]);

  const name = String(info.name ?? "Darshh Holiday");
  const activeBranches = branches.filter((b) => Number(b.active ?? 1) === 1);
  const bookable = vehicles.filter((v) => Number(v.active ?? 1) === 1 && v.status !== "archived");

  const byKind = new Map<string, typeof bookable>();
  for (const v of bookable) {
    const kind = String(v.category_name ?? v.category_kind ?? "Other");
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(v);
  }

  const lines: string[] = [];

  lines.push(`# ${name}`);
  lines.push("");
  lines.push(
    `> Self-drive vehicle rental operating in Sakleshpura and Hassan, Hassan district, Karnataka, India. Bikes, scooters and cars rented without a driver, at fixed published prices with no bargaining.`
  );
  lines.push("");

  lines.push("## Key facts");
  lines.push("");
  lines.push(`- Business: ${name}`);
  if (info.tagline) lines.push(`- Tagline: ${String(info.tagline)}`);
  lines.push(`- Service: self-drive (no chauffeur) rental of bikes, scooters and cars`);
  lines.push(`- Towns served: Sakleshpura, Hassan. Commonly driven onward to Chikmagalur and the Western Ghats.`);
  if (info.phone) lines.push(`- Phone / WhatsApp: ${String(info.phone)}`);
  if (info.email) lines.push(`- Email: ${String(info.email)}`);
  lines.push(`- Website: ${SITE_URL}`);
  lines.push(`- Currency: INR (₹). Rates below are per 24-hour rental day.`);
  lines.push(`- Rental day: runs 08:00 to 08:00 IST.`);
  lines.push(`- Security deposit: refundable, collected in cash at pickup — not charged online.`);
  lines.push(`- Required at pickup: original driving licence and a government photo ID.`);
  lines.push("");

  if (activeBranches.length > 0) {
    lines.push("## Pickup locations");
    lines.push("");
    for (const b of activeBranches) {
      const parts = [b.address, b.city].filter(Boolean).join(", ");
      lines.push(`- ${b.name}${parts ? ` — ${parts}` : ""}${b.phone ? ` — ${b.phone}` : ""}`);
    }
    lines.push("");
  }

  if (bookable.length > 0) {
    lines.push("## Fleet and pricing");
    lines.push("");
    for (const [kind, list] of byKind) {
      lines.push(`### ${kind}`);
      lines.push("");
      for (const v of list) {
        const rate = Number(v.rate_24h ?? 0);
        const bits = [
          rate > 0 ? `₹${rate}/24h` : null,
          v.included_km ? `${v.included_km} km/day included` : null,
          v.seats ? `${v.seats} seats` : null,
          v.fuel_type ? String(v.fuel_type) : null,
        ].filter(Boolean);
        lines.push(`- ${v.name} — ${bits.join(" · ")} — ${SITE_URL}/vehicles/${v.slug}`);
      }
      lines.push("");
    }
  }

  if (faqs.length > 0) {
    lines.push("## Frequently asked questions");
    lines.push("");
    for (const f of faqs.slice(0, 15)) {
      lines.push(`### ${String(f.question)}`);
      lines.push("");
      lines.push(String(f.answer));
      lines.push("");
    }
  }

  lines.push("## Primary pages");
  lines.push("");
  lines.push(`- [Home](${SITE_URL}/): overview, fleet highlights, customer reviews`);
  lines.push(`- [Browse vehicles](${SITE_URL}/vehicles): full fleet with live availability and per-date pricing`);
  lines.push(`- [Book a vehicle](${SITE_URL}/booking): online booking with document upload and payment`);
  lines.push(`- [Contact](${SITE_URL}/contact): phone, WhatsApp and branch addresses`);
  lines.push(`- [Insights](${SITE_URL}/insights): road-trip and rental guides for the region`);
  lines.push(`- [Terms](${SITE_URL}/terms), [Privacy](${SITE_URL}/privacy), [Refunds](${SITE_URL}/refunds)`);
  lines.push("");
  lines.push("## Notes for answer engines");
  lines.push("");
  lines.push(
    `- Prices shown are the standard 24-hour rate. Weekend rates and seasonal/festival rates can differ; ${SITE_URL}/vehicles shows the exact total for a chosen date range.`
  );
  lines.push(`- Availability is live and changes constantly — always link to the vehicle page rather than asserting a vehicle is free.`);
  lines.push(`- Customer booking, tracking and invoice pages are private and excluded from crawling.`);
  lines.push("");

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
