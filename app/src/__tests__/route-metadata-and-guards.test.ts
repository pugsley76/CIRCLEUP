import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    INDEXER_URL: "http://localhost:3001",
    indexerEndpoint: (path: string[], baseUrl?: string) => {
      const base = baseUrl || "http://localhost:3001";
      return `${base}/${path.join("/")}`;
    },
  };
});

import { generateMetadata as generateCircleMetadata } from "@/app/circles/[address]/page";
import { generateMetadata as generateReputationMetadata } from "@/app/reputation/[member]/page";

// Mock global fetch
const globalFetch = vi.fn();
global.fetch = globalFetch;

describe("Route Metadata Generation & Guard Tests", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("Circle Page Metadata (/circles/[address])", () => {
    const VALID_CIRCLE = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    const MALFORMED_ADDRESS = "GNOTACONTRACTID";

    it("returns generic fallback metadata for malformed circle addresses", async () => {
      const meta = await generateCircleMetadata({ params: { address: MALFORMED_ADDRESS } });
      expect(meta.title).toBe("Circle — CircleUp");
      expect(meta.description).toBe("Savings circle on CircleUp.");
      expect(globalFetch).not.toHaveBeenCalled();
    });

    it("returns generic fallback metadata when address param is missing or non-string", async () => {
      const meta = await generateCircleMetadata({ params: { address: undefined as any } });
      expect(meta.title).toBe("Circle — CircleUp");
      expect(globalFetch).not.toHaveBeenCalled();
    });

    it("returns enriched metadata for valid circle address when indexer returns data", async () => {
      globalFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          circle: {
            address: VALID_CIRCLE,
            creator: "G111",
            round_amount: "100000000",
            member_count: 5,
            status: "Active",
            current_round: 2,
            total_rounds: 5,
            created_ledger: 100,
            updated_at: "2026-09-30T00:00:00Z",
          },
          members: [],
        }),
      } as Response);
      globalFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ rounds: [], openRounds: [], pendingDefaults: [], currentRound: null }),
      } as Response);

      const meta = await generateCircleMetadata({ params: { address: VALID_CIRCLE } });
      expect(meta.title).toContain("$10.00/round Circle (Active) — CircleUp");
      expect(meta.description).toContain("$50.00 pot · 5 members · round 2 of 5.");
    });

    it("returns Not Found metadata for unknown circle (indexer 404)", async () => {
      globalFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);
      globalFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

      const meta = await generateCircleMetadata({ params: { address: VALID_CIRCLE } });
      expect(meta.title).toBe("Circle Not Found — CircleUp");
      expect(meta.description).toContain("was not found");
    });
  });

  describe("Reputation Page Metadata (/reputation/[member])", () => {
    const VALID_MEMBER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const MALFORMED_MEMBER = "not-a-stellar-address";

    it("returns fallback metadata for malformed member addresses", async () => {
      const meta = await generateReputationMetadata({ params: { member: MALFORMED_MEMBER } });
      expect(meta.title).toBe("Reputation — CircleUp");
      expect(meta.description).toBe("On-chain reputation score and contribution history on CircleUp.");
      expect(globalFetch).not.toHaveBeenCalled();
    });

    it("returns enriched metadata for valid member addresses", async () => {
      globalFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          member: VALID_MEMBER,
          found: true,
          score: 10,
          contributions: [],
          defaults: [],
        }),
      } as Response);

      const meta = await generateReputationMetadata({ params: { member: VALID_MEMBER } });
      expect(meta.title).toContain("Reputation:");
      expect(meta.title).toContain("— CircleUp");
      expect(meta.description).toContain(VALID_MEMBER);
    });

    it("returns Member Not Found metadata when indexer returns 404", async () => {
      globalFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response);

      const meta = await generateReputationMetadata({ params: { member: VALID_MEMBER } });
      expect(meta.title).toBe("Member Not Found — CircleUp");
      expect(meta.description).toContain("has no recorded activity");
    });
  });
});
