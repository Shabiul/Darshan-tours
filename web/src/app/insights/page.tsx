import type { Metadata } from "next";
import Link from "next/link";
import { getBlogPosts, getBlogPost } from "@/lib/data";
import { notFound } from "next/navigation";
import { SectionHeading } from "@/components/ui";
import { formatDate } from "@/lib/utils";
import { breadcrumbJsonLd, jsonLdGraph } from "@/lib/seo";

export const metadata: Metadata = {
  title: "Insights & Rental Guides",
  description: "Practical guides on self-drive road trips, vehicle care and rental planning from Darshh Holiday.",
  alternates: { canonical: "/insights" },
};

export default async function InsightsPage() {
  const posts = await getBlogPosts();
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLdGraph(breadcrumbJsonLd([{ name: "Insights", path: "/insights" }]))),
        }}
      />
      <section className="border-b border-ink-100 bg-brand-600/5">
        <div className="container-x py-16 sm:py-20">
          <SectionHeading
            as="h1"
            eyebrow="Insights"
            title="Guides written by people who drive"
            subtitle="Practical advice for self-drive road trips and rentals — no fluff."
          />
        </div>
      </section>
      <section className="container-x py-14">
        {posts.length === 0 ? (
          <p className="text-sm text-ink-500">Articles coming soon.</p>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {posts.map((post) => (
              <Link key={Number(post.id)} href={`/insights/${String(post.slug)}`} className="card flex flex-col p-6 transition hover:-translate-y-1 hover:shadow-lift">
                <p className="text-xs text-ink-400">{formatDate(String(post.created_at ?? ""))}</p>
                <h2 className="mt-2 font-display text-xl font-semibold leading-snug text-ink-900">{String(post.title)}</h2>
                <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-600">{String(post.excerpt ?? "")}</p>
                <p className="mt-4 text-sm font-semibold text-brand-600">Read article →</p>
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
