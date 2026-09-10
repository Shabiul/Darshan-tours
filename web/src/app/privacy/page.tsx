import type { Metadata } from "next";
import Link from "next/link";
import { businessInfo } from "@/lib/settings";
import { breadcrumbJsonLd, jsonLdGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Darshh Holiday collects, uses and protects your personal information.",
  alternates: { canonical: "/privacy" },
};

export default async function PrivacyPage() {
  const info = await businessInfo();
  const name = String(info.name ?? "Darshh Holiday");
  return (
    <article className="container-x max-w-3xl py-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLdGraph(breadcrumbJsonLd([{ name: "Privacy Policy", path: "/privacy" }]))),
        }}
      />
      <nav aria-label="Breadcrumb" className="text-xs text-ink-400">
        <ol className="flex gap-2">
          <li><Link href="/" className="hover:text-brand-700">Home</Link></li>
          <li aria-hidden>/</li>
          <li aria-current="page">Privacy policy</li>
        </ol>
      </nav>
      <h1 className="mt-6 font-display text-3xl font-semibold text-ink-900">Privacy Policy</h1>
      <p className="mt-2 text-sm text-ink-500">Last updated: July 2026</p>
      <div className="mt-8 space-y-6 text-sm leading-relaxed text-ink-700">
        <p>
          {name} ("we", "us") respects your privacy. This policy explains what we collect when you use this website,
          why we collect it, and how we protect it.
        </p>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">1. Information we collect</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li><strong>Booking details</strong> — name, phone, WhatsApp number, email, address, date of birth, driving licence and ID details, pickup/return dates and vehicle preferences you enter in our booking form.</li>
            <li><strong>Communication</strong> — records of calls, WhatsApp messages and emails exchanged with us.</li>
            <li><strong>Vehicle handover/return records</strong> — odometer, fuel level and inspection photos captured at pickup and return.</li>
            <li><strong>Technical data</strong> — basic usage information such as pages visited, device type and approximate location, used only to improve the website.</li>
          </ul>
        </section>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">2. How we use it</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>To verify your identity and eligibility to rent a vehicle.</li>
            <li>To prepare bookings, invoices and process payments and deposit refunds.</li>
            <li>To communicate with you about your booking, pickup/return and payments.</li>
            <li>To improve our services and website.</li>
            <li>To comply with legal obligations (e.g., GST invoicing).</li>
          </ul>
          <p className="mt-3">
            We do <strong>not</strong> sell your personal information, and we do not share your driving licence or ID
            documents with third parties except where legally required.
          </p>
        </section>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">3. Data protection</h2>
          <p>
            We use secure storage, access controls and HTTPS in transit. Only authorised staff can view customer
            information, and all important actions are logged.
          </p>
        </section>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">4. Your rights</h2>
          <p>
            You may ask us to correct or delete your personal data at any time. Contact us at {String(info.email ?? "hello@darshantours.in")} or{" "}
            {String(info.phone ?? "")}. We keep records as long as needed for tax and legal obligations.
          </p>
        </section>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">5. Contact</h2>
          <p>{name} · {String(info.address ?? "")}</p>
        </section>
        <p className="text-xs text-ink-400">
          This is a default policy prepared for the MVP. Please have it reviewed by your legal adviser before going live.
        </p>
      </div>
    </article>
  );
}
