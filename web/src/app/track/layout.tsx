import type { Metadata } from "next";

/**
 * /track is a lookup form and /track/[bookingNo] shows one customer's live booking
 * status — neither belongs in the index. The form page is thin by nature (a single
 * input) and would land in "Crawled – currently not indexed" anyway; the detail page
 * carries a named customer's booking, vehicle and pickup time.
 *
 * This lives in a layout because app/track/page.tsx is a client component and a
 * "use client" module cannot export `metadata`. The child route sets its own noindex
 * too, so the signal survives independently of this file.
 */
export const metadata: Metadata = {
  title: "Track Your Booking",
  description: "Look up the live status of an existing Darshh Holiday booking.",
  robots: { index: false, follow: true },
};

export default function TrackLayout({ children }: { children: React.ReactNode }) {
  return children;
}
