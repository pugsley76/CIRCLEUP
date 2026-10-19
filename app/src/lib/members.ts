// ─── Circle member rows from the indexer ──────────────────────────────────────
//
// parseMemberRows is now the shared validator defined in circleTypes.ts and
// re-exported here so existing imports from "@/lib/members" continue to resolve
// without changes at every call site.
//
// Shared by the server page (initial render) and CircleDetailClient (refresh),
// so both paths agree on when member data counts as "unavailable". This lives
// in lib/ rather than in CircleDetailClient.tsx because a server component
// cannot call functions exported from a "use client" module.

export type { CircleMember } from "@/lib/circleTypes";
export { parseMemberRows } from "@/lib/circleTypes";
