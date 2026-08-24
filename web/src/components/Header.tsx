"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type NavItem = {
  href: string;
  label: string;
  children?: Array<{ href: string; label: string }>;
};

const NAV: NavItem[] = [
  { href: "/", label: "Home" },
  {
    href: "/vehicles",
    label: "All vehicles",
    children: [
      { href: "/vehicles", label: "All fleet" },
      { href: "/vehicles?kind=car", label: "Cars" },
      { href: "/vehicles?kind=bike", label: "Bikes" },
      { href: "/vehicles?kind=scooter", label: "Scooters" },
      { href: "/vehicles?kind=van", label: "Tempo Traveller" },
    ],
  },
  { href: "/gallery", label: "Gallery" },
  { href: "/insights", label: "Insights" },
  { href: "/track", label: "Track Booking" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

const DARK_HERO_PAGES = ["/", "/vehicles", "/about", "/contact", "/gallery"];

export function Header({ info }: { info: Record<string, unknown> }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [scrollY, setScrollY] = useState(0);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const name = (info.name as string) ?? "Darshh Holiday";
  const canFloat = DARK_HERO_PAGES.includes(pathname);

  useEffect(() => {
    function onScroll() {
      setScrollY(window.scrollY);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Compute opacity ratio from 0 (top of page) to 1 (scrolled down >= 120px)
  const progress = Math.min(1, Math.max(0, scrollY / 120));
  const isScrolled = progress > 0.35 || open || !canFloat;

  // Exact RGB for user's uploaded swatch: rgb(247, 242, 235) / #f7f2eb
  const r = Math.round(15 + (247 - 15) * (canFloat ? progress : 1));
  const g = Math.round(15 + (242 - 15) * (canFloat ? progress : 1));
  const b = Math.round(19 + (235 - 19) * (canFloat ? progress : 1));
  const bgOpacity = open ? 0.98 : canFloat ? progress * 0.96 : 0.96;
  const blurPx = open ? 16 : canFloat ? progress * 16 : 16;

  return (
    <header
      className="fixed top-0 left-0 right-0 z-50 border-b transition-all duration-300"
      style={{
        backgroundColor: `rgba(${r}, ${g}, ${b}, ${bgOpacity})`,
        backdropFilter: `blur(${blurPx}px)`,
        WebkitBackdropFilter: `blur(${blurPx}px)`,
        borderColor: isScrolled ? "rgba(51, 34, 22, 0.12)" : "transparent",
        boxShadow: isScrolled ? "0 8px 30px -4px rgba(36, 24, 17, 0.08)" : "none",
      }}
    >
      <div className={`container-x flex items-center justify-between gap-4 transition-all duration-300 ${progress > 0.2 ? "h-14 sm:h-16" : "h-16 sm:h-20"}`}>
        <Link href="/" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
          <span className={`relative shrink-0 transition-all duration-300 ${progress > 0.2 ? "h-10 w-10 sm:h-12 sm:w-12" : "h-12 w-12 sm:h-14 sm:w-14"}`}>
            <Image src="/logo.png" alt={name} fill sizes="56px" className="object-contain" priority />
          </span>
          <span className={`font-display text-lg font-semibold leading-tight transition-colors duration-300 ${isScrolled ? "text-ink-950" : "text-white"}`}>
            {name}
            <span className="block text-[10px] font-medium uppercase tracking-[0.18em] text-brand-500">
              {(info.tagline as string) ?? "Ride More. Explore More."}
            </span>
          </span>
        </Link>

        <nav className="hidden items-center gap-1 lg:flex" aria-label="Main navigation">
          {NAV.map((item) => {
            const [base] = item.href.split("?");
            const active = base === "/" ? pathname === "/" : pathname === base;

            if (item.children) {
              return (
                <div
                  key={item.href}
                  className="group relative"
                  onMouseEnter={() => setDropdownOpen(true)}
                  onMouseLeave={() => setDropdownOpen(false)}
                >
                  <Link
                    href={item.href}
                    className={`inline-flex items-center gap-1.5 overflow-hidden rounded-full px-4 py-2 text-sm font-medium transition-colors duration-300 focus-visible:outline-2 focus-visible:outline-offset-2 ${
                      isScrolled
                        ? active
                          ? "bg-brand-500/10 text-brand-600 font-semibold focus-visible:outline-brand-500"
                          : "text-ink-800 hover:bg-ink-950/5 hover:text-ink-950 focus-visible:outline-brand-500"
                        : active
                          ? "bg-white/20 text-white font-semibold focus-visible:outline-white"
                          : "text-white/85 hover:bg-white/10 hover:text-white focus-visible:outline-white"
                    }`}
                  >
                    {item.label}
                    <svg
                      className="h-3.5 w-3.5 transition-transform duration-200 group-hover:rotate-180"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </Link>

                  <div
                    className={`absolute left-0 top-full pt-2 transition-all duration-200 ${
                      dropdownOpen
                        ? "opacity-100 pointer-events-auto translate-y-0"
                        : "opacity-0 pointer-events-none translate-y-1 group-hover:opacity-100 group-hover:pointer-events-auto group-hover:translate-y-0"
                    }`}
                  >
                    <div
                      className={`w-48 overflow-hidden rounded-2xl p-1.5 shadow-2xl backdrop-blur-xl border transition-all ${
                        isScrolled
                          ? "bg-[#f7f2eb] border-ink-950/10 text-ink-950 shadow-ink-950/10"
                          : "bg-ink-950/95 border-white/15 text-white shadow-black/40"
                      }`}
                    >
                      {item.children.map((sub) => (
                        <Link
                          key={sub.href}
                          href={sub.href}
                          className={`block rounded-xl px-3.5 py-2.5 text-sm font-medium transition ${
                            isScrolled
                              ? "text-ink-800 hover:bg-brand-500/10 hover:text-brand-700"
                              : "text-white/85 hover:bg-white/10 hover:text-white"
                          }`}
                        >
                          {sub.label}
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              );
            }

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`overflow-hidden rounded-full px-4 py-2 text-sm font-medium transition-colors duration-300 focus-visible:outline-2 focus-visible:outline-offset-2 ${
                  isScrolled
                    ? active
                      ? "bg-brand-500/10 text-brand-600 font-semibold focus-visible:outline-brand-500"
                      : "text-ink-800 hover:bg-ink-950/5 hover:text-ink-950 focus-visible:outline-brand-500"
                    : active
                      ? "bg-white/20 text-white font-semibold focus-visible:outline-white"
                      : "text-white/85 hover:bg-white/10 hover:text-white focus-visible:outline-white"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          <Link href="/booking" className="btn-primary btn-shine">
            Book now
          </Link>
        </div>

        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors duration-300 lg:hidden ${
            isScrolled ? "text-ink-900 hover:bg-ink-950/5" : "text-white hover:bg-white/10"
          }`}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h10" />}
          </svg>
        </button>
      </div>

      {open && (
        <nav className="dropdown-pop border-t border-ink-950/10 bg-[#f7f2eb] px-4 pb-6 pt-2 text-ink-950 shadow-xl backdrop-blur-xl lg:hidden" aria-label="Mobile navigation">
          <div className="flex flex-col gap-1">
            {NAV.map((item) => (
              <div key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-xl px-4 py-3 text-base font-semibold text-ink-900 transition hover:bg-ink-950/5"
                >
                  {item.label}
                </Link>
                {item.children && (
                  <div className="ml-4 flex flex-col gap-1 border-l-2 border-brand-500/20 pl-2 my-1">
                    {item.children.map((sub) => (
                      <Link
                        key={sub.href}
                        href={sub.href}
                        onClick={() => setOpen(false)}
                        className="rounded-lg px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-brand-500/10 hover:text-brand-700"
                      >
                        {sub.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <Link href="/booking" onClick={() => setOpen(false)} className="btn-primary mt-3 w-full text-center">
              Book now
            </Link>
          </div>
        </nav>
      )}
    </header>
  );
}
