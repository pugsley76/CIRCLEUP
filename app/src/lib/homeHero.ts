import { CIRCLE_STATUS_OPTIONS, type CircleLifecycleStatus as CircleStatusFilter } from "./lifecycle";
import type { Circle } from "@/components/CircleCard";

export { CIRCLE_STATUS_OPTIONS };
export type { CircleStatusFilter };

/**
 * Returns true when `value` is a recognised status filter value.
 * Used to guard the raw searchParams string before it reaches the fetch call.
 */
export function isValidStatusFilter(value: unknown): value is CircleStatusFilter {
  return (
    typeof value === "string" &&
    (CIRCLE_STATUS_OPTIONS as readonly string[]).includes(value)
  );
}

/**
 * Returns true when `url` is a syntactically valid absolute HTTP/HTTPS URL.
 * A misconfigured INDEXER_URL (empty string, relative path, placeholder text,
 * etc.) would otherwise cause fetch() to throw an opaque TypeError that looks
 * identical to a real network failure and gives no actionable guidance.
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

export interface ProtocolGuarantee {
  emoji: string;
  title: string;
  desc: string;
}

export const PROTOCOL_GUARANTEES: ProtocolGuarantee[] = [
  {
    emoji: "🔒",
    title: "No rug-pulls",
    desc: "Funds sit in the Soroban smart contract, never with an organizer or admin.",
  },
  {
    emoji: "🔄",
    title: "Deterministic rotation",
    desc: "Payout order is fixed at creation and enforced programmatically on-chain.",
  },
  {
    emoji: "🛡️",
    title: "Collateral-backed defaults",
    desc: "Every member locks collateral up front to cover missed payments automatically.",
  },
  {
    emoji: "⭐",
    title: "On-chain reputation",
    desc: "Successful circle completions build a verifiably transparent member track record.",
  },
];

export type FetchResult =
  | { ok: true; circles: Circle[]; total: number }
  | { ok: false; error: "network" | "parse" | "server" | "misconfigured" | "indexer_outage" };

export type BrowseState =
  | { kind: "unavailable" }
  | { kind: "empty" }
  | { kind: "browse"; count: number };

export function getBrowseState(result: FetchResult | null): BrowseState {
  if (!result || !result.ok) return { kind: "unavailable" };
  const count = typeof result.total === "number" ? result.total : (result.circles?.length ?? 0);
  if (count === 0) return { kind: "empty" };
  return { kind: "browse", count };
}
