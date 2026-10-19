import type { Circle } from "@/components/CircleCard";

export type FetchResult =
  | { ok: true; circles: Circle[]; total: number }
  | { ok: false; error: "network" | "parse" | "server" | "misconfigured" | "indexer_outage" };

export type BrowseState =
  | { kind: "browse"; count: number }
  | { kind: "empty" }
  | { kind: "unavailable" };

/**
 * Returns true when `url` is a syntactically valid absolute HTTP/HTTPS URL.
 */
export function isValidUrl(url: string): boolean {
  if (!url || url.trim() === "") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Decides what the hero's secondary call-to-action should offer.
 */
export function getBrowseState(result: FetchResult | null): BrowseState {
  if (!result || !result.ok) return { kind: "unavailable" };
  const count = result.total ?? result.circles?.length ?? 0;
  if (count === 0) return { kind: "empty" };
  return { kind: "browse", count };
}

export const PROTOCOL_GUARANTEES = [
  {
    emoji: "🔒",
    title: "No rug-pulls",
    desc: "Funds sit safely in the smart contract and can only be distributed according to the round schedule.",
  },
  {
    emoji: "🔄",
    title: "Deterministic rotation",
    desc: "Payout order is fixed when the circle is formed and enforced transparently on-chain.",
  },
  {
    emoji: "🛡️",
    title: "Collateral-backed defaults",
    desc: "Collateral requirements protect members against early dropouts or missed contribution rounds.",
  },
  {
    emoji: "⭐",
    title: "On-chain reputation",
    desc: "Member trust scores are recorded on-chain based on verifiable payment history and completion rates.",
  },
];
