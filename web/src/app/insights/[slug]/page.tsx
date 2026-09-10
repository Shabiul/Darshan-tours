import type { Metadata } from "next";
import Link from "next/link";
import { getBlogPost } from "@/lib/data";
import { notFound } from "next/navigation";
import { formatDate } from "@/lib/utils";
import { absoluteUrl, breadcrumbJsonLd, jsonLdGraph, ORG_ID, WEBSITE_ID } from "@/lib/seo";

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params;
  const post = await getBlogPost(params.slug);
  if (!post) return {};
  const published = post.created_at ? new Date(String(post.created_at)) : null;
  const hasDate = published && !Number.isNaN(published.getTime());
  return {
    title: String(post.title),
    description: String(post.excerpt ?? ""),
    alternates: { canonical: `/insights/${String(post.slug ?? params.slug)}` },
    openGraph: {
      title: String(post.title),
      description: String(post.excerpt ?? ""),
      type: "article",
      url: `/insights/${String(post.slug ?? params.slug)}`,
      ...(hasDate ? { publishedTime: published!.toISOString() } : {}),
      ...(post.author ? { authors: [String(post.author)] } : {}),
      ...(post.cover ? { images: [{ url: String(post.cover) }] } : {}),
    },
  };
}

export default async function BlogPostPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const post = await getBlogPost(params.slug);
  if (!post) notFound();

  // BlogPosting is what makes an article eligible for Article rich results, and it is
  // the format answer engines lean on hardest when deciding whether a page is a
  // citable source (named author, publish date, publisher) rather than anonymous copy.
  // The visible breadcrumb below is mirrored as BreadcrumbList so the same trail Google
  // shows in the result matches what a user actually sees on the page.
  const published = post.created_at ? new Date(String(post.created_at)) : null;
  const postGraph = jsonLdGraph(
    {
      "@type": "BlogPosting",
      "@id": absoluteUrl(`/insights/${String(post.slug)}#article`),
      mainEntityOfPage: { "@type": "WebPage", "@id": absoluteUrl(`/insights/${String(post.slug)}`) },
      headline: String(post.title).slice(0, 110),
      ...(post.excerpt ? { description: String(post.excerpt) } : {}),
      // Article rich results need an image; posts without a cover fall back to the same
      // logo the site already serves as its default OG image, so the node is never
      // incomplete just because an author skipped the cover field.
      image: absoluteUrl(String(post.cover ?? "/logo.jpeg")),
      ...(published && !Number.isNaN(published.getTime())
        ? { datePublished: published.toISOString(), dateModified: published.toISOString() }
        : {}),
      author: post.author
        ? { "@type": "Person", name: String(post.author) }
        : { "@id": ORG_ID },
      publisher: { "@id": ORG_ID },
      inLanguage: "en-IN",
      isPartOf: { "@id": WEBSITE_ID },
    },
    breadcrumbJsonLd([
      { name: "Insights", path: "/insights" },
      { name: String(post.title), path: `/insights/${String(post.slug)}` },
    ])
  );

  return (
    <article className="container-x max-w-3xl py-14">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(postGraph) }} />
      <nav aria-label="Breadcrumb" className="text-xs text-ink-400">
        <ol className="flex gap-2">
          <li><Link href="/" className="hover:text-brand-700">Home</Link></li>
          <li aria-hidden>/</li>
          <li><Link href="/insights" className="hover:text-brand-700">Insights</Link></li>
          <li aria-hidden>/</li>
          <li aria-current="page" className="text-ink-600">{String(post.title)}</li>
        </ol>
      </nav>
      <h1 className="mt-6 font-display text-3xl font-semibold leading-tight text-ink-900 sm:text-4xl">{String(post.title)}</h1>
      <p className="mt-3 text-sm text-ink-500">
        {formatDate(String(post.created_at ?? ""))} · {String(post.author ?? "")}
      </p>
      {post.excerpt ? <p className="mt-6 text-lg leading-relaxed text-ink-600">{String(post.excerpt)}</p> : null}
      <div className="mt-8 space-y-5 text-base leading-relaxed text-ink-700">
        {String(post.content)
          .split(/\n\n+/)
          .map((para, i) => (
            <p key={i}>{para}</p>
          ))}
      </div>
      <div className="mt-12 rounded-2xl bg-brand-500/10 p-6 text-center">
        <p className="font-display text-lg font-semibold text-ink-900">Planning a trip?</p>
        <p className="mt-1 text-sm text-ink-600">See fixed pricing and book your vehicle in minutes.</p>
        <Link href="/booking" className="btn-primary mt-4">Book now</Link>
      </div>
    </article>
  );
}
