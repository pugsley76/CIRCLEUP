import type { MetadataRoute } from "next";

// Canonical site origin, mirrored from app/src/app/layout.tsx (which cannot be
// imported here — Next.js forbids importing layout files into routes). Never
// uses `new URL(req.url)`: sitemap.xml is generated at build time, not per
// request.
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "http://localhost:3000";

/**
 * Static sitemap covering every public app route. Dynamic routes
 * (/circles/[address], /reputation/[member]) are intentionally omitted: their
 * content depends on the indexer, and listing them here would require a
 * network call (or staleness) at build time. The canonical URLs emitted by
 * each page's generateMetadata cover those pages for crawlers that follow
 * internal links instead.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: `${SITE_URL}/create`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ];
}