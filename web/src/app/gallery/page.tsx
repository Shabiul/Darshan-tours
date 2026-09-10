import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { getGallery, getVehicles, getVehicleCategories, getTestimonials } from "@/lib/data";
import { OurStories } from "@/components/OurStories";
import { BookingBar } from "@/components/BookingBar";
import { Stars } from "@/components/ui";
import { breadcrumbJsonLd, jsonLdGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Gallery & Stories — Rides We've Delivered",
  description: "Explore real road trips, coffee estate escapes, mountain trails, and photo memories from Darshh Holiday rentals.",
  alternates: { canonical: "/gallery" },
};

const HERO_IMG = "/hero-poster.jpg";
const HERO_VIDEO =
  process.env.NEXT_PUBLIC_BLOB_GALLERY_VIDEO ||
  "https://obbnjsertzjfu0v6.public.blob.vercel-storage.com/videos/gallery.mp4";

const FALLBACK =
  "https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&w=1200&q=80";

export default async function GalleryPage() {
  const [items, vehicles, categories, testimonials] = await Promise.all([
    getGallery(),
    getVehicles(),
    getVehicleCategories(),
    getTestimonials(),
  ]);

  const fleet = vehicles.filter((v) => v.primary_photo);
  const row1 = fleet.filter((_, i) => i % 2 === 0);
  const row2 = fleet.filter((_, i) => i % 2 === 1);
  const avgRating =
    testimonials.length > 0
      ? Math.round((testimonials.reduce((s, t) => s + Number(t.rating), 0) / testimonials.length) * 10) / 10
      : 4.7;

  return (
    <div className="bg-white text-ink-900">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLdGraph(breadcrumbJsonLd([{ name: "Gallery", path: "/gallery" }]))),
        }}
      />
      {/* 1. Full Screen Hero Section with Vivid Background Video */}
      <section className="relative flex min-h-screen flex-col justify-center overflow-hidden bg-ink-950 -mt-20 sm:-mt-24 pt-20 sm:pt-24 text-white">
        <Image src={HERO_IMG} alt="" aria-hidden fill priority className="object-cover" sizes="100vw" />
        <video
          className="hero-video absolute inset-0 h-full w-full object-cover brightness-125 contrast-105"
          autoPlay
          muted
          loop
          playsInline
          disablePictureInPicture
          disableRemotePlayback
          preload="auto"
          poster={HERO_IMG}
          aria-hidden
          tabIndex={-1}
        >
          <source src={HERO_VIDEO} type="video/mp4" />
        </video>
        <div className="absolute inset-0 bg-gradient-to-b from-ink-950/50 via-black/15 to-ink-950/55 pointer-events-none" aria-hidden />

        <div className="container-x relative z-10 flex flex-col justify-center items-center text-center my-auto">
          <div className="mx-auto max-w-3xl flex flex-col items-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-400/40 bg-brand-500/20 px-4 py-1.5 text-xs font-bold uppercase tracking-[0.28em] text-brand-300 backdrop-blur-md shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-400" aria-hidden />
              Real Rides · Road Trip Memories
            </span>
            <h1 className="mt-5 font-display text-4xl font-black leading-[1.08] tracking-tight sm:text-5xl lg:text-[3.75rem] text-white [text-shadow:_0_2px_12px_rgba(0,0,0,0.7)]">
              Stories &amp; Moments from the{" "}
              <span className="relative inline-block text-brand-400">
                Open Road
                <svg className="absolute -bottom-1.5 left-0 w-full text-brand-500/80" height="8" viewBox="0 0 200 10" preserveAspectRatio="none" aria-hidden>
                  <path d="M0 6 Q50 -2 100 6 T200 6" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                </svg>
              </span>
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-white sm:text-lg sm:leading-relaxed [text-shadow:_0_1px_8px_rgba(0,0,0,0.8)]">
              Explore real customer handovers, coffee estate trails, mountain peak views, and unforgettable road trip memories across Sakleshpura, Chikmagalur, and Hassan.
            </p>
          </div>
        </div>
      </section>

      {/* 2. Our Stories & About Us Section (Light Theme) */}
      <OurStories variant="light" />

      {/* 3. Interactive Fleet Ticker (Light Theme) */}
      {fleet.length > 0 && (
        <section className="border-t border-b border-ink-200/80 bg-ink-50 py-14 text-ink-950">
          <div className="container-x mb-8">
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-brand-700">The full fleet</p>
            <h2 className="mt-2 font-display text-2xl font-semibold sm:text-3xl text-ink-950">Every vehicle, ready for your story</h2>
          </div>
          <div className="space-y-5 overflow-hidden">
            <div className="fleet-track">
              {[...row1, ...row1].map((v, i) => (
                <Link
                  key={`${v.id}-${i}`}
                  href={`/vehicles/${v.slug}`}
                  className="group relative mx-2.5 h-48 w-64 shrink-0 overflow-hidden rounded-2xl border border-ink-200/80 bg-white shadow-sm transition hover:border-brand-500/50 hover:shadow-md"
                >
                  <Image src={v.primary_photo as string} alt={`${v.name} self-drive rental in Sakleshpura & Hassan`} fill loading="lazy" className="object-contain p-4 transition-transform duration-500 group-hover:scale-105" sizes="256px" />
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950/85 to-transparent px-3 pb-2 pt-6 text-sm font-semibold text-white opacity-0 transition group-hover:opacity-100">
                    {v.name}
                  </span>
                </Link>
              ))}
            </div>
            <div className="fleet-track-reverse">
              {[...row2, ...row2].map((v, i) => (
                <Link
                  key={`${v.id}-${i}`}
                  href={`/vehicles/${v.slug}`}
                  className="group relative mx-2.5 h-48 w-64 shrink-0 overflow-hidden rounded-2xl border border-ink-200/80 bg-white shadow-sm transition hover:border-brand-500/50 hover:shadow-md"
                >
                  <Image src={v.primary_photo as string} alt={`${v.name} self-drive rental in Sakleshpura & Hassan`} fill loading="lazy" className="object-contain p-4 transition-transform duration-500 group-hover:scale-105" sizes="256px" />
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950/85 to-transparent px-3 pb-2 pt-6 text-sm font-semibold text-white opacity-0 transition group-hover:opacity-100">
                    {v.name}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* 4. Photo Gallery Wall (Light Theme) */}
      <section id="visual-archive" className="container-x py-16 sm:py-20 bg-white">
        <div className="mb-10 max-w-xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand-500/30 bg-brand-50 px-3.5 py-1 text-xs font-bold uppercase tracking-wider text-brand-700">
            Visual Archive
          </span>
          <h2 className="mt-3 font-display text-3xl font-bold text-ink-950">Trip Moments &amp; Memories</h2>
          <p className="mt-2 text-sm text-ink-600">A glimpse into customer handovers, scenic viewpoints, and tour stops across Hassan district.</p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item, i) => (
            <figure
              key={Number(item.id)}
              className={`group relative aspect-[4/3] overflow-hidden rounded-2xl border border-ink-200 bg-ink-50 shadow-sm ${i % 5 === 0 ? "sm:aspect-[16/10] sm:col-span-2 sm:row-span-2" : ""}`}
            >
              <Image
                src={String(item.image ?? FALLBACK)}
                alt={String(item.title ?? "Tour gallery")}
                fill
                loading="lazy"
                className="object-cover transition-transform duration-500 group-hover:scale-105"
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
              />
              <figcaption className="absolute inset-0 flex items-end bg-gradient-to-t from-ink-950/80 via-transparent to-transparent p-5 opacity-0 transition group-hover:opacity-100">
                <div>
                  <span className="block font-display text-lg font-bold text-white">{String(item.title ?? "")}</span>
                  {item.category ? <span className="text-xs font-medium text-brand-300">{String(item.category)}</span> : null}
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>
    </div>
  );
}
