import type { MetadataRoute } from "next";
import { getVehicles, getBlogPosts } from "@/lib/data";
import { SITE_URL } from "@/lib/seo";

export const revalidate = 3600;

/**
 * Every indexable URL, and only indexable URLs.
 *
 * Deliberately absent: /customer/*, /track/*, /invoice/* and /api/*. Those are
 * per-customer pages carrying PII and are noindex at the page level — listing a
 * noindex URL in a sitemap is a direct Search Console warning ("Submitted URL marked
 * noindex") and wastes crawl budget on pages that can never rank.
 *
 * lastModified is a real timestamp wherever the record carries one. A sitemap that
 * stamps every URL with "now" on each crawl teaches Google to ignore the field, which
 * costs recrawl priority on the pages that genuinely did change.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const base: MetadataRoute.Sitemap = [
    { url: SITE_URL, lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/vehicles`, lastModified: now, changeFrequency: "daily", priority: 0.9 },
    { url: `${SITE_URL}/booking`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/contact`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/insights`, lastModified: now, changeFrequency: "weekly", priority: 0.6 },
    { url: `${SITE_URL}/about`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/gallery`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    // Policy pages: low priority, but they must be indexable and discoverable — they
    // are part of what Google and the AI engines read as trust/legitimacy signals for a
    // business that takes online payments.
    { url: `${SITE_URL}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/refunds`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];

  const [vehiclesList, posts] = await Promise.all([
    getVehicles().catch(() => []),
    getBlogPosts().catch(() => []),
  ]);

  // Only live, bookable vehicles. An archived or deactivated vehicle's page is a soft
  // 404 waiting to happen; submitting it invites "Crawled – currently not indexed".
  const vehicles: MetadataRoute.Sitemap = vehiclesList
    .filter((v) => Number(v.active ?? 1) === 1 && v.status !== "archived" && Boolean(v.slug))
    .map((v) => ({
      url: `${SITE_URL}/vehicles/${v.slug}`,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    }));

  const blogUrls: MetadataRoute.Sitemap = posts
    .filter((p) => Boolean(p.slug))
    .map((p) => {
      const raw = p.updated_at ?? p.created_at;
      const parsed = raw ? new Date(String(raw)) : null;
      return {
        url: `${SITE_URL}/insights/${String(p.slug)}`,
        lastModified: parsed && !Number.isNaN(parsed.getTime()) ? parsed : now,
        changeFrequency: "monthly" as const,
        priority: 0.6,
      };
    });

  return [...base, ...vehicles, ...blogUrls];
}
