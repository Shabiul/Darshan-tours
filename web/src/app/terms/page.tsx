import type { Metadata } from "next";
import Link from "next/link";
import { businessInfo, rentalRules } from "@/lib/settings";
import { formatINR } from "@/lib/utils";
import { breadcrumbJsonLd, jsonLdGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Terms & Conditions",
  description: "Terms and conditions governing self-drive vehicle rentals with Darshh Holiday.",
  alternates: { canonical: "/terms" },
};

export default async function TermsPage() {
  const [info, rules] = await Promise.all([businessInfo(), rentalRules()]);
  const name = String(info.name ?? "Darshh Holiday");
  return (
    <article className="container-x max-w-3xl py-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLdGraph(breadcrumbJsonLd([{ name: "Terms & Conditions", path: "/terms" }]))),
        }}
      />
      <nav aria-label="Breadcrumb" className="text-xs text-ink-400">
        <ol className="flex gap-2">
          <li><Link href="/" className="hover:text-brand-700">Home</Link></li>
          <li aria-hidden>/</li>
          <li aria-current="page">Terms &amp; conditions</li>
        </ol>
      </nav>
      <h1 className="mt-6 font-display text-3xl font-semibold text-ink-900">Terms &amp; Conditions</h1>
      <p className="mt-2 text-sm text-ink-500">Last updated: July 2026</p>
      <div className="mt-8 space-y-6 text-sm leading-relaxed text-ink-700">
        <p>These terms govern your use of this website and any vehicle rental booked with {name}.</p>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">1. Eligibility &amp; documents</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>A valid driving licence appropriate to the vehicle class and a government photo ID are required at pickup.</li>
            <li>Minimum age: 21 years for two-wheelers, 23 years for cars.</li>
            <li>We reserve the right to refuse a rental if documents cannot be verified.</li>
          </ul>
        </section>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">2. Fixed pricing policy</h2>
          <p className="mt-3">This is a fixed-price rental — the rate shown on the vehicle listing at the time of booking is not negotiable.</p>
        </section>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">3. Rental period, fuel &amp; kilometres</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>Standard vehicle renting and drop-off is from 8:00 AM to 8:00 AM (24 hours complete cycle), which is considered to be 1 rental day.</li>
            <li>Picking up the vehicle at 7:59 AM or earlier (before 8:00 AM) incurs an extra fee of ₹250.</li>
            <li>Dropping off or returning the vehicle after 8:00 AM (next cycle) incurs an extra fee of ₹250.</li>
            <li>Vehicles are rented without fuel — please return the vehicle with the same fuel level you received it at.</li>
            <li>Each vehicle includes a limit of 100 km per day. Driving beyond this limit incurs an excess charge of ₹500 per KM.</li>
          </ul>
        </section>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">4. Security deposit</h2>
          <p className="mt-3">
            A refundable security deposit is collected at pickup. It is returned after the return inspection, minus any
            approved deductions for late return, excess kilometres, damage or cleaning — each deduction is itemised in
            your final invoice.
          </p>
        </section>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">5. Late return</h2>
          <p className="mt-3">
            A grace period of {String(rules.grace_period_minutes ?? 30)} minutes applies after your scheduled return time.
            Beyond that, a late fee of {formatINR(Number(rules.late_fee_flat ?? 250))} applies for short delays,
            escalating to an hourly rate of {formatINR(Number(rules.late_fee_per_hour ?? 150))} and a full additional
            day's charge for extended delays. All late fees and any waivers are recorded on your booking.
          </p>
        </section>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">6. Damage, fines &amp; misuse</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>The customer is responsible for any damage to the vehicle during the rental period, assessed at return inspection against the condition recorded at handover.</li>
            <li>Traffic fines, tolls and challans incurred during the rental are the customer's responsibility.</li>
            <li>Sub-letting the vehicle to a third party or using it for illegal purposes is strictly prohibited and will forfeit the deposit.</li>
          </ul>
        </section>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">7. Breakdown &amp; accidents</h2>
          <p className="mt-3">
            In case of breakdown or accident, contact us immediately using the number below. Do not attempt repairs
            without our approval. Depending on the situation, we may arrange a replacement vehicle or a partial refund.
          </p>
        </section>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">8. Force majeure</h2>
          <p className="mt-3">
            We are not liable for delays or cancellations caused by events beyond our control — natural disasters,
            government restrictions, strikes or road closures. We will make reasonable efforts to provide alternatives.
          </p>
        </section>
        <section>
          <h2 className="font-display text-lg font-semibold text-ink-900">9. Contact</h2>
          <p>{name} · {String(info.phone ?? "")} · {String(info.email ?? "")}</p>
        </section>
        <p className="text-xs text-ink-400">
          This is a default policy prepared for the MVP. Please have it reviewed by your legal adviser before going live.
        </p>
      </div>
    </article>
  );
}
