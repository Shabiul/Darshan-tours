import type { Metadata } from "next";
import Link from "next/link";
import { businessInfo } from "@/lib/settings";
import { breadcrumbJsonLd, jsonLdGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Refund Policy",
  description: "Security deposit and refund terms for vehicles booked with Darshh Holiday.",
  alternates: { canonical: "/refunds" },
};

export default async function RefundsPage() {
  const info = await businessInfo();
  const name = String(info.name ?? "Darshh Holiday");
  return (
    <article className="container-x max-w-3xl py-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLdGraph(breadcrumbJsonLd([{ name: "Refund Policy", path: "/refunds" }]))),
        }}
      />
      <nav aria-label="Breadcrumb" className="text-xs text-ink-400">
        <ol className="flex gap-2">
          <li><Link href="/" className="hover:text-brand-700">Home</Link></li>
          <li aria-hidden>/</li>
          <li aria-current="page">Refunds</li>
        </ol>
      </nav>
      <h1 className="mt-6 font-display text-3xl font-semibold text-ink-900">Refund Policy</h1>
      <p className="mt-2 text-sm text-ink-500">Last updated: July 2026</p>
      <div className="mt-8 space-y-6 text-sm leading-relaxed text-ink-700">
        <p>This policy explains what happens to your security deposit after a rental.</p>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">Security deposit refunds</h2>
          <p className="mt-3">
            The security deposit is refunded after the vehicle is returned and inspected, typically within 3–5
            business days. Any approved deductions for late return, excess kilometres or damage are itemised and
            shown to you before the deposit is finalised — nothing is deducted without a recorded reason.
          </p>
        </section>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">Notes</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>Refunds are processed to the original payment method within 5–7 business days of approval.</li>
            <li>You can request a refund any time from your booking page in the customer portal.</li>
          </ul>
        </section>
        <p className="text-xs text-ink-400">
          This is a default policy prepared for the MVP. Please review and adjust it to your actual business practice.
        </p>
        <p>{name} · {String(info.phone ?? "")} · {String(info.email ?? "")}</p>
      </div>
    </article>
  );
}
