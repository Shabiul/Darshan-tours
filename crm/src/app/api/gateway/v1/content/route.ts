import { NextRequest, NextResponse } from "next/server";
import { requireGatewayKey } from "@/lib/gateway-auth";
import {
  getVehicleCategories, getVehicles, getTestimonials, getGallery, getFaqs,
  getStaff, getActiveTermsVersion, getBlogPosts, getBlogPost, getBranches,
} from "@/lib/data";
import { businessInfo, rentalRules } from "@/lib/settings";
import { getActivePricingRules } from "@/lib/pricing";

/** One combined read model for everything the public site's static/semi-static pages
 * need (fleet, categories, testimonials, gallery, faqs, staff, terms, business info) —
 * this is small, cheap-to-read data, so serving it as one payload keeps the gateway
 * surface small instead of one endpoint per page. */
export async function GET(req: NextRequest) {
  const denied = requireGatewayKey(req);
  if (denied) return denied;

  // Optional date window from the public site's search bar (?pickupAt=...&returnAt=...,
  // canonical IST ISO strings). When present, `available_units`/`status` on each vehicle
  // reflect occupancy during THIS window only, instead of "booked at any point from now
  // on" — the same availabilityWindow mechanism already used by the booking picker.
  const pickupAt = req.nextUrl.searchParams.get("pickupAt");
  const returnAt = req.nextUrl.searchParams.get("returnAt");
  const availabilityWindow = pickupAt && returnAt ? { pickupAt, returnAt } : undefined;

  // These are all async reads now. Handing the unawaited promises to
  // NextResponse.json serialises every one of them as `{}`.
  const [
    business, rules, categories, vehicles, branches,
    testimonials, gallery, faqs, staff, terms, blogPosts, pricingRules,
  ] = await Promise.all([
    businessInfo(),
    rentalRules(),
    getVehicleCategories(),
    getVehicles({ availabilityWindow }),
    getBranches(),
    getTestimonials(),
    getGallery(),
    getFaqs(),
    getStaff(),
    getActiveTermsVersion(),
    getBlogPosts(),
    getActivePricingRules(),
  ]);

  return NextResponse.json({
    business,
    rentalRules: rules,
    categories,
    vehicles,
    branches,
    testimonials,
    gallery,
    faqs,
    staff,
    terms,
    blogPosts,
    pricingRules,
  });
}

export async function POST(req: NextRequest) {
  const denied = requireGatewayKey(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (body?.op === "blogPost" && typeof body.slug === "string") {
    const post = await getBlogPost(body.slug);
    return NextResponse.json({ post });
  }
  return NextResponse.json({ error: "Unknown operation." }, { status: 400 });
}
