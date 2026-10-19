import type { MetadataRoute } from "next";

// Canonical site origin, mirrored from app/src/app/layout.tsx (which cannot be
// imported here — Next.js forbids importing layout files into routes). Never
// uses `new URL(req.url)`: robots.txt is generated at build time, not per
// request.
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "http://localhost:3000";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}