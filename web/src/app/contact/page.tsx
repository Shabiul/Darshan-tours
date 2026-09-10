import type { Metadata } from "next";
import { businessInfo } from "@/lib/settings";
import { ContactForm } from "@/components/ContactForm";
import { breadcrumbJsonLd, jsonLdGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Contact Us",
  description: "Reach Darshan Tour and Travels — phone, WhatsApp, email or the contact form. We reply within one business day.",
  alternates: { canonical: "/contact" },
  openGraph: {
    title: "Contact Us | Darshh Holiday",
    description: "Reach Darshan Tour and Travels — phone, WhatsApp, email or the contact form. We reply within one business day.",
    type: "website",
    images: [{ url: "/logo.jpeg", width: 792, height: 685, alt: "Darshh Holiday contact" }],
  },
};

const HERO_VIDEO =
  process.env.NEXT_PUBLIC_BLOB_CONTACT_VIDEO ||
  "https://obbnjsertzjfu0v6.public.blob.vercel-storage.com/videos/Sequence%2001_1.mp4";


const ICONS: Record<string, React.ReactNode> = {
  Phone: (
    <path d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.5 21 3 13.5 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1.1L6.6 10.8z" />
  ),
  WhatsApp: (
    <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.4A10 10 0 1 0 12 2zm5.7 14.2c-.2.7-1.4 1.3-2 1.4-.5.1-1.1.1-1.8-.1-.4-.1-1-.3-1.7-.6-3-1.3-5-4.3-5.1-4.5-.1-.2-1.2-1.6-1.2-3.1s.8-2.2 1-2.5c.3-.3.6-.4.8-.4h.6c.2 0 .5 0 .7.5.3.7.9 2.1.9 2.3.1.2.1.4 0 .6-.1.2-.2.3-.3.5-.2.2-.3.3-.5.5-.2.2-.3.4-.1.7.2.3.9 1.4 1.9 2.2 1.3 1.1 2.3 1.5 2.6 1.6.3.1.5.1.7-.1.2-.2.8-.9 1-1.2.2-.3.4-.2.7-.1.3.1 1.8.9 2.1 1 .3.2.5.2.6.3.1.2.1.7-.1 1.4z" />
  ),
  Email: (
    <path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm0 2.4V17h16V7.4l-7.4 5.1a1 1 0 0 1-1.2 0L4 7.4z" />
  ),
  Office: (
    <path d="M12 2C8 2 5 5.1 5 9c0 5.3 7 13 7 13s7-7.7 7-13c0-3.9-3-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" />
  ),
  Hours: (
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.4 4 2.3-.7 1.3-4.8-2.8V6h1.5v6.4z" />
  ),
};

export default async function ContactPage() {
  const info = await businessInfo();
  const methods = [
    { label: "Phone", value: String(info.phone ?? ""), href: `tel:${String(info.phone ?? "").replace(/\s/g, "")}`, hint: "For quick questions and urgent changes" },
    { label: "WhatsApp", value: String(info.whatsapp ?? ""), href: `https://wa.me/${String(info.whatsapp ?? "").replace(/\D/g, "")}`, external: true, hint: "Fastest way to reach our tour desk" },
    { label: "Email", value: String(info.email ?? ""), href: `mailto:${String(info.email ?? "")}`, hint: "For itineraries, invoices and documents" },
    { label: "Office", value: String(info.address ?? ""), hint: undefined },
    { label: "Hours", value: String(info.hours ?? ""), hint: undefined },
  ];
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLdGraph(breadcrumbJsonLd([{ name: "Contact", path: "/contact" }]))),
        }}
      />
      <section className="relative flex min-h-screen flex-col justify-center overflow-hidden bg-ink-950 -mt-20 sm:-mt-24 pt-20 sm:pt-24 text-white">
        <video
          className="hero-video absolute inset-0 h-full w-full object-cover brightness-125 contrast-105 opacity-95"
          autoPlay
          muted
          loop
          playsInline
          disablePictureInPicture
          disableRemotePlayback
          preload="auto"
          aria-hidden
          tabIndex={-1}
        >
          <source src={HERO_VIDEO} type="video/mp4" />
        </video>
        <div className="absolute inset-0 bg-gradient-to-r from-ink-950/75 via-ink-950/45 to-ink-950/20" aria-hidden />
        <div className="container-x relative z-10 my-auto py-20 sm:py-24">
          <p className="text-xs font-bold uppercase tracking-[0.32em] text-gold-300">Contact</p>
          <h1 className="mt-5 max-w-xl font-display text-4xl font-black leading-[1.08] sm:text-5xl lg:text-6xl">
            Talk to a real human
          </h1>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-white/90 sm:text-lg">
            Call, WhatsApp, email or drop us a message below — a member of our tour desk replies within one
            business day, usually much sooner.
          </p>
        </div>
      </section>
      <section className="container-x grid gap-8 py-14 sm:py-16 lg:grid-cols-5 lg:items-start">
        <div className="grid gap-4 sm:grid-cols-2 lg:col-span-2 lg:grid-cols-1">
          {methods.map((c) => (
            <div key={c.label} className="card flex items-start gap-4 p-5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold-500/15 text-gold-600" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">{ICONS[c.label]}</svg>
              </span>
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-wider text-ink-400">{c.label}</p>
                {c.href ? (
                  <a href={c.href} target={c.external ? "_blank" : undefined} rel={c.external ? "noopener noreferrer" : undefined} className="mt-1 block break-words text-base font-medium text-brand-700 hover:underline">
                    {c.value}
                  </a>
                ) : (
                  <p className="mt-1 text-base text-ink-800">{c.value}</p>
                )}
                {c.hint && <p className="mt-1 text-xs text-ink-500">{c.hint}</p>}
              </div>
            </div>
          ))}
        </div>
        <div className="lg:col-span-3">
          <div className="card p-6 sm:p-8">
            <h2 className="font-display text-xl font-semibold text-ink-900">Send us a message</h2>
            <p className="mt-1.5 text-sm text-ink-600">Tell us a little about your trip and we&rsquo;ll follow up with next steps.</p>
            <div className="mt-6">
              <ContactForm />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
