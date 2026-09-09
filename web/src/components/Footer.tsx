import Link from "next/link";
import Image from "next/image";

export function Footer({ info }: { info: Record<string, unknown> }) {
  const name = (info.name as string) ?? "Darshh Holiday";
  const social = (info.social as Record<string, string>) ?? {};

  return (
    <footer className="border-t-2 border-brand-500 bg-ink-950 text-ink-100">
      <div className="container-x grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="relative h-28 w-40">
            <Image src="/logo.png" alt={name} fill className="object-contain" sizes="160px" />
          </div>
          <p className="mt-4 text-sm leading-relaxed text-ink-300">
            {(info.tagline as string) ?? "Ride More. Explore More."} Fixed, transparent pricing on bikes, scooters
            and cars — no bargaining, ever.
          </p>
        </div>
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-ink-400">Explore</p>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li><Link href="/vehicles" className="text-ink-200 transition hover:text-brand-400">All vehicles</Link></li>
            <li><Link href="/vehicles?kind=car" className="text-ink-200 transition hover:text-brand-400">Cars</Link></li>
            <li><Link href="/vehicles?kind=bike" className="text-ink-200 transition hover:text-brand-400">Bikes</Link></li>
            <li><Link href="/gallery" className="text-ink-200 transition hover:text-brand-400">Gallery</Link></li>
            <li><Link href="/insights" className="text-ink-200 transition hover:text-brand-400">Insights</Link></li>
            <li><Link href="/about" className="text-ink-200 transition hover:text-brand-400">About us</Link></li>
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-ink-400">Support</p>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li><Link href="/contact" className="text-ink-200 transition hover:text-brand-400">Contact us</Link></li>
            <li><Link href="/booking" className="text-ink-200 transition hover:text-brand-400">Book a vehicle</Link></li>
            <li><Link href="/customer/login" className="text-ink-200 transition hover:text-brand-400">Track your booking</Link></li>
            <li><Link href="/privacy" className="text-ink-200 transition hover:text-brand-400">Privacy policy</Link></li>
            <li><Link href="/terms" className="text-ink-200 transition hover:text-brand-400">Terms &amp; conditions</Link></li>
            <li><Link href="/refunds" className="text-ink-200 transition hover:text-brand-400">Refund policy</Link></li>
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-ink-400">Reach us</p>
          <ul className="mt-4 space-y-2.5 text-sm text-ink-200">
            <li>{String(info.phone ?? "")}</li>
            <li>{String(info.email ?? "")}</li>
            <li className="leading-relaxed">{String(info.address ?? "")}</li>
            <li>{String(info.hours ?? "")}</li>
            <li className="flex gap-3 pt-1">
              {social.instagram ? <a href={social.instagram} target="_blank" rel="noopener noreferrer" className="text-ink-300 transition hover:text-brand-400">Instagram</a> : null}
              {social.facebook ? <a href={social.facebook} target="_blank" rel="noopener noreferrer" className="text-ink-300 transition hover:text-brand-400">Facebook</a> : null}
              {social.youtube ? <a href={social.youtube} target="_blank" rel="noopener noreferrer" className="text-ink-300 transition hover:text-brand-400">YouTube</a> : null}
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-ink-800">
        <div className="container-x flex flex-col items-center justify-between gap-2 py-5 text-xs text-ink-400 sm:flex-row">
          <p>© {new Date().getFullYear()} {name}. All rights reserved.</p>
          <p>No bargaining · Fixed pricing · Well maintained fleet</p>
        </div>
        <div className="container-x pb-5 text-center text-[16px] text-ink-400">
          Designed and developed by{" "}
          <a href="https://naazailabs.com" target="_blank" rel="noopener noreferrer" className="font-semibold text-ink-300 hover:text-brand-400">
            Naaz AI Labs
          </a>
        </div>
      </div>
    </footer>
  );
}
