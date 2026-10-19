/**
 * Indexer URL resolution — Issue #508 "Ensure safe fetch behavior when the
 * indexer URL is misconfigured".
 *
 * A misconfigured NEXT_PUBLIC_INDEXER_URL used to reach fetch() as-is. In the
 * browser a scheme-less value is a *relative* URL, so the request hit the Next
 * app, 404'd, and the UI reported "circle not found" / "no reputation record".
 * Every indexer fetch now goes through indexerEndpoint(), which returns null
 * for an unusable base so callers can show a "misconfigured" state instead.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveIndexerBaseUrl, indexerEndpoint } from "../lib/config";

const CIRCLE = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

describe("resolveIndexerBaseUrl", () => {
  it.each([
    ["http://localhost:3001", "http://localhost:3001"],
    ["https://indexer.example.com", "https://indexer.example.com"],
    ["  http://localhost:3001  ", "http://localhost:3001"],
    ["http://localhost:3001/", "http://localhost:3001"],
    ["https://api.example.com/indexer//", "https://api.example.com/indexer"],
    ["https://api.example.com/indexer", "https://api.example.com/indexer"],
  ])("accepts %j as %j", (raw, expected) => {
    expect(resolveIndexerBaseUrl(raw)).toBe(expected);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace", "   "],
    ["no scheme (host:port)", "localhost:3001"],
    ["no scheme (bare host)", "indexer.example.com"],
    ["relative path", "/api/indexer"],
    ["placeholder text", "<your-indexer-url>"],
    ["non-HTTP scheme", "ftp://indexer.example.com"],
    ["javascript: scheme", "javascript:alert(1)"],
    ["query string", "http://localhost:3001?token=abc"],
    ["fragment", "http://localhost:3001#circles"],
    ["embedded credentials", "http://user:pass@localhost:3001"],
  ])("rejects %s", (_label, raw) => {
    expect(resolveIndexerBaseUrl(raw as string | undefined | null)).toBeNull();
  });
});

describe("indexerEndpoint", () => {
  it("joins segments onto the base without doubling slashes", () => {
    expect(indexerEndpoint(["circles", CIRCLE, "rounds"], "http://localhost:3001")).toBe(
      `http://localhost:3001/circles/${CIRCLE}/rounds`,
    );
  });

  it("keeps a base path", () => {
    expect(indexerEndpoint(["circles"], "https://api.example.com/indexer")).toBe(
      "https://api.example.com/indexer/circles",
    );
  });

  it("encodes segments so a route param cannot add path segments or a query", () => {
    expect(indexerEndpoint(["circles", "../reputation?x=1"], "http://localhost:3001")).toBe(
      "http://localhost:3001/circles/..%2Freputation%3Fx%3D1",
    );
  });

  it("returns null when the base is misconfigured", () => {
    expect(indexerEndpoint(["circles"], null)).toBeNull();
  });
});

// ─── Fetch call sites ─────────────────────────────────────────────────────────
//
// INDEXER_BASE_URL is resolved once at module load, so each case re-imports
// the modules under a stubbed env.

describe("fetch call sites with a misconfigured NEXT_PUBLIC_INDEXER_URL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function loadWithIndexerUrl(url: string) {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_INDEXER_URL", url);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const detail = await import("../app/circles/[address]/CircleDetailClient");
    return { fetchMock, fetchCircleData: detail.fetchCircleData };
  }

  it.each(["localhost:3001", "indexer.example.com", "http://localhost:3001?x=1"])(
    "fetchCircleData reports 'misconfigured' for %j and never calls fetch",
    async (url) => {
      const { fetchMock, fetchCircleData } = await loadWithIndexerUrl(url);
      const result = await fetchCircleData(CIRCLE);
      expect(result).toEqual({ ok: false, error: "misconfigured" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("fetchCircleData fetches the normalised URL when the base is valid", async () => {
    const { fetchMock, fetchCircleData } = await loadWithIndexerUrl("http://localhost:3001/");
    fetchMock.mockResolvedValue(new Response("{}", { status: 404 }));
    const result = await fetchCircleData(CIRCLE);
    expect(result).toEqual({ ok: false, error: "not_found" });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `http://localhost:3001/circles/${CIRCLE}`,
      `http://localhost:3001/circles/${CIRCLE}/rounds`,
    ]);
  });
});
