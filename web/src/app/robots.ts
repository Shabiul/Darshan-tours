import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";

/**
 * Crawl policy.
 *
 * Two separate audiences, deliberately treated the same way:
 *
 *  - Classic search crawlers (Googlebot, Bingbot) index the public pages.
 *  - Answer/AI engines (ChatGPT Search, Perplexity, Claude, Gemini grounding) read the
 *    same pages to CITE this business in generated answers. They are allowed on
 *    purpose: blocking them removes the site from "self drive bike rental in
 *    Sakleshpura" style AI answers entirely, which is the opposite of the goal.
 *    Google-Extended in particular is the switch that governs whether this content can
 *    be used to ground Gemini and AI Overviews — it is listed explicitly so the intent
 *    is recorded, not left to a default that could change.
 *
 * Disallowed paths are private, not secret: customer portal, booking-tracking pages and
 * invoices carry a specific customer's PII, and /api returns JSON that would only
 * pollute the index. They are all noindex at the page level as well — robots.txt alone
 * does not remove a URL that is already indexed.
 */

const PRIVATE_PATHS = ["/api/", "/customer/", "/invoice/", "/track/", "/monitoring"];

const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot",
  "Applebot-Extended",
  "CCBot",
  "Bytespider",
  "Amazonbot",
  "meta-externalagent",
  "cohere-ai",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE_PATHS },
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: "/", disallow: PRIVATE_PATHS })),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
