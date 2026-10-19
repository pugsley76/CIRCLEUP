import { describe, expect, it } from "vitest";

import { getBrowseState, isValidUrl, PROTOCOL_GUARANTEES } from "@/lib/homeHero";

describe("homepage hero validation and CTA state", () => {
  it("accepts absolute HTTP and HTTPS indexer URLs", () => {
    expect(isValidUrl("http://localhost:3001")).toBe(true);
    expect(isValidUrl("https://indexer.example.com")).toBe(true);
  });

  it("rejects empty, relative, and placeholder URLs", () => {
    expect(isValidUrl("")).toBe(false);
    expect(isValidUrl(" ")).toBe(false);
    expect(isValidUrl("/api/circles")).toBe(false);
    expect(isValidUrl("localhost:3001")).toBe(false);
  });

  it("treats a failed fetch as unavailable instead of rendering a broken CTA", () => {
    expect(getBrowseState(null)).toEqual({ kind: "unavailable" });
    expect(getBrowseState({ ok: false, error: "network" } as any)).toEqual({
      kind: "unavailable",
    });
  });

  it("offers a browse CTA only when circles are available", () => {
    expect(getBrowseState({ ok: true, circles: [] } as any)).toEqual({ kind: "empty" });
    expect(getBrowseState({ ok: true, circles: [{ address: "C123" }] } as any)).toEqual({
      kind: "browse",
      count: 1,
    });
    expect(
      getBrowseState({ ok: true, circles: [{ address: "C1" }, { address: "C2" }] } as any),
    ).toEqual({ kind: "browse", count: 2 });
  });
});

describe("protocol guarantees section", () => {
  it("renders exactly 4 guarantees", () => {
    expect(PROTOCOL_GUARANTEES).toHaveLength(4);
  });

  it("all guarantees have non-empty title, desc, and emoji", () => {
    for (const g of PROTOCOL_GUARANTEES) {
      expect(g.title.trim()).not.toBe("");
      expect(g.desc.trim()).not.toBe("");
      expect(g.emoji.trim()).not.toBe("");
    }
  });

  it("no guarantee uses a placeholder string instead of an emoji", () => {
    // Placeholder strings are all-uppercase ASCII words — a real emoji always
    // contains a non-ASCII code point. This catches accidental regressions like
    // emoji: "LOCKED" instead of emoji: "🚫".
    const ASCII_UPPER_WORD = /^[A-Z_]+$/;
    for (const g of PROTOCOL_GUARANTEES) {
      expect(g.emoji).not.toMatch(ASCII_UPPER_WORD);
    }
  });

  it("all guarantee titles are unique", () => {
    const titles = PROTOCOL_GUARANTEES.map((g) => g.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("includes the four expected contract-backed guarantee titles", () => {
    const titles = PROTOCOL_GUARANTEES.map((g) => g.title);
    expect(titles).toContain("No rug-pulls");
    expect(titles).toContain("Deterministic rotation");
    expect(titles).toContain("Collateral-backed defaults");
    expect(titles).toContain("On-chain reputation");
  });

  it("descriptions are non-trivially long (not placeholder text)", () => {
    for (const g of PROTOCOL_GUARANTEES) {
      // Each description should be a real sentence, not a one-word stub
      expect(g.desc.length).toBeGreaterThan(40);
    }
  });
});
