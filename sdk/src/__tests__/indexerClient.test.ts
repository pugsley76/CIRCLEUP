/**
 * Tests for IndexerClient.
 *
 * We intercept `fetch` with vi.stubGlobal so no real network calls are made.
 * Every test verifies both the happy path (typed response is returned) and
 * the relevant failure modes (network error, non-2xx status, bad JSON).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_INDEXER_TIMEOUT_MS, IndexerClient, IndexerError } from "../client";
import type { CircleUpConfig } from "../types";
import { CIRCLE_ADDR, MEMBER_A_ADDR } from "./fixtures";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_CONFIG: CircleUpConfig = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contracts: {
    circleFactory: "CFACTORY",
    reputation: "CREP",
    usdc: "CUSDC",
  },
  indexerUrl: "http://localhost:3001",
};

const MEMBER_ADDR = MEMBER_A_ADDR;

/** A well-formed GET /circles page envelope. */
function circlesPage(circles: unknown[] = [], page = 1, limit = 20, total = circles.length) {
  return {
    circles,
    pagination: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a mock fetch that returns a 200 JSON response. */
function mockOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

/** Build a mock fetch that returns a non-2xx JSON response. */
function mockError(status: number, errorBody?: unknown) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(errorBody ?? { error: `HTTP ${status}` }),
  });
}

/** Build a mock fetch that rejects (network failure). */
function mockNetworkFailure(message = "ECONNREFUSED") {
  return vi.fn().mockRejectedValue(new Error(message));
}

// ─── Construction ─────────────────────────────────────────────────────────────

describe("IndexerClient construction", () => {
  it("constructs successfully when indexerUrl is set", () => {
    expect(() => new IndexerClient(BASE_CONFIG)).not.toThrow();
  });

  it("throws when indexerUrl is missing", () => {
    const cfg: CircleUpConfig = { ...BASE_CONFIG, indexerUrl: undefined };
    expect(() => new IndexerClient(cfg)).toThrow(
      "IndexerClient requires config.indexerUrl",
    );
  });

  it("throws when indexerUrl is an empty string", () => {
    const cfg: CircleUpConfig = { ...BASE_CONFIG, indexerUrl: "" };
    expect(() => new IndexerClient(cfg)).toThrow(
      "IndexerClient requires config.indexerUrl",
    );
  });

  it("throws when indexerUrl is only whitespace", () => {
    const cfg: CircleUpConfig = { ...BASE_CONFIG, indexerUrl: "   " };
    expect(() => new IndexerClient(cfg)).toThrow(
      "IndexerClient requires config.indexerUrl",
    );
  });

  it.each([
    ["no scheme", "localhost:3001"],
    ["bare host", "indexer.example.com"],
    ["relative path", "/api/indexer"],
    ["non-HTTP scheme", "ftp://indexer.example.com"],
    ["query string", "http://localhost:3001?token=x"],
    ["fragment", "http://localhost:3001#circles"],
  ])("throws at construction for a misconfigured indexerUrl (%s)", (_label, indexerUrl) => {
    const cfg: CircleUpConfig = { ...BASE_CONFIG, indexerUrl };
    expect(() => new IndexerClient(cfg)).toThrow("is not a valid absolute HTTP(S) URL");
  });

  it("normalises trailing slashes and keeps a base path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(circlesPage()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new IndexerClient({
        ...BASE_CONFIG,
        indexerUrl: " https://api.example.com/indexer// ",
      });
      await client.getCircles();
      expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.com/indexer/circles");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("strips trailing slash from indexerUrl", async () => {
    const cfg: CircleUpConfig = { ...BASE_CONFIG, indexerUrl: "http://localhost:3001/" };
    const mockFetch = mockOk(circlesPage());
    vi.stubGlobal("fetch", mockFetch);

    const client = new IndexerClient(cfg);
    await client.getCircles();

    const [calledUrl] = mockFetch.mock.calls[0] as [string];
    expect(calledUrl).toBe("http://localhost:3001/circles");
    vi.unstubAllGlobals();
  });
});

// ─── getCircles ───────────────────────────────────────────────────────────────

describe("IndexerClient.getCircles", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns parsed circles list", async () => {
    const payload = circlesPage([{ address: CIRCLE_ADDR, status: "Active" }]);
    vi.stubGlobal("fetch", mockOk(payload));

    const client = new IndexerClient(BASE_CONFIG);
    const result = await client.getCircles();

    expect(result.circles).toHaveLength(1);
    expect(result.circles[0].address).toBe(CIRCLE_ADDR);
  });

  it("calls the correct endpoint", async () => {
    const mockFetch = mockOk(circlesPage());
    vi.stubGlobal("fetch", mockFetch);

    await new IndexerClient(BASE_CONFIG).getCircles();

    expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:3001/circles");
  });

  it("throws IndexerError on 500", async () => {
    vi.stubGlobal("fetch", mockError(500, { error: "Internal server error" }));

    await expect(new IndexerClient(BASE_CONFIG).getCircles()).rejects.toThrow(
      IndexerError,
    );
  });

  it("IndexerError carries the HTTP status", async () => {
    vi.stubGlobal("fetch", mockError(503));

    const err = await new IndexerClient(BASE_CONFIG)
      .getCircles()
      .catch((e) => e);
    expect(err).toBeInstanceOf(IndexerError);
    expect((err as IndexerError).status).toBe(503);
  });

  it("throws IndexerError with status 0 on network failure", async () => {
    vi.stubGlobal("fetch", mockNetworkFailure("ECONNREFUSED"));

    const err = await new IndexerClient(BASE_CONFIG)
      .getCircles()
      .catch((e) => e);
    expect(err).toBeInstanceOf(IndexerError);
    expect((err as IndexerError).status).toBe(0);
    expect((err as IndexerError).message).toContain("ECONNREFUSED");
  });
});

// ─── getCircleDetail ──────────────────────────────────────────────────────────

describe("IndexerClient.getCircleDetail", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns circle, members, and latestLedger", async () => {
    const payload = {
      circle: { address: CIRCLE_ADDR, status: "Active" },
      members: [{ member_address: MEMBER_ADDR }],
      latestLedger: 9_000_000,
    };
    vi.stubGlobal("fetch", mockOk(payload));

    const result = await new IndexerClient(BASE_CONFIG).getCircleDetail(CIRCLE_ADDR);

    expect(result.circle.address).toBe(CIRCLE_ADDR);
    expect(result.members).toHaveLength(1);
    expect(result.latestLedger).toBe(9_000_000);
  });

  it("URL-encodes the circle address", async () => {
    const mockFetch = mockOk({ circle: {}, members: [], latestLedger: null });
    vi.stubGlobal("fetch", mockFetch);

    const addr = "C ADDR WITH SPACES";
    await new IndexerClient(BASE_CONFIG).getCircleDetail(addr);

    const [calledUrl] = mockFetch.mock.calls[0] as [string];
    expect(calledUrl).toBe(`http://localhost:3001/circles/${encodeURIComponent(addr)}`);
  });

  it("throws IndexerError with status 404 when circle not found", async () => {
    vi.stubGlobal("fetch", mockError(404, { error: "Circle not found" }));

    const err = await new IndexerClient(BASE_CONFIG)
      .getCircleDetail(CIRCLE_ADDR)
      .catch((e) => e);

    expect(err).toBeInstanceOf(IndexerError);
    expect((err as IndexerError).status).toBe(404);
    expect((err as IndexerError).message).toContain("Circle not found");
  });
});

// ─── getMembers ───────────────────────────────────────────────────────────────

describe("IndexerClient.getMembers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns members array", async () => {
    const payload = {
      members: [
        { member_address: MEMBER_ADDR, total_contributions: 2 },
        { member_address: "GDEF456", total_contributions: 1 },
      ],
    };
    vi.stubGlobal("fetch", mockOk(payload));

    const { members } = await new IndexerClient(BASE_CONFIG).getMembers(CIRCLE_ADDR);

    expect(members).toHaveLength(2);
    expect(members[0].member_address).toBe(MEMBER_ADDR);
    expect(members[0].total_contributions).toBe(2);
  });

  it("calls the /members sub-path", async () => {
    const mockFetch = mockOk({ members: [] });
    vi.stubGlobal("fetch", mockFetch);

    await new IndexerClient(BASE_CONFIG).getMembers(CIRCLE_ADDR);

    expect(mockFetch.mock.calls[0][0]).toBe(
      `http://localhost:3001/circles/${CIRCLE_ADDR}/members`,
    );
  });

  it("throws IndexerError on network failure", async () => {
    vi.stubGlobal("fetch", mockNetworkFailure("timeout"));

    await expect(
      new IndexerClient(BASE_CONFIG).getMembers(CIRCLE_ADDR),
    ).rejects.toBeInstanceOf(IndexerError);
  });
});

// ─── getRounds ────────────────────────────────────────────────────────────────

describe("IndexerClient.getRounds", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns rounds and pendingDefaults", async () => {
    const payload = {
      rounds: [
        { roundIndex: 0, recipient: MEMBER_ADDR, amount: "400000000", contributions: [], defaults: [] },
      ],
      pendingDefaults: [],
    };
    vi.stubGlobal("fetch", mockOk(payload));

    const { rounds, pendingDefaults } = await new IndexerClient(BASE_CONFIG).getRounds(CIRCLE_ADDR);

    expect(rounds).toHaveLength(1);
    expect(rounds[0].roundIndex).toBe(0);
    expect(pendingDefaults).toHaveLength(0);
  });

  it("calls the /rounds sub-path", async () => {
    const mockFetch = mockOk({ rounds: [], pendingDefaults: [] });
    vi.stubGlobal("fetch", mockFetch);

    await new IndexerClient(BASE_CONFIG).getRounds(CIRCLE_ADDR);

    expect(mockFetch.mock.calls[0][0]).toBe(
      `http://localhost:3001/circles/${CIRCLE_ADDR}/rounds`,
    );
  });
});

// ─── getReputation ────────────────────────────────────────────────────────────

describe("IndexerClient.getReputation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns score, contributions, defaults, and updatedAt", async () => {
    const payload = {
      member: MEMBER_ADDR,
      score: 3,
      contributions: [{ circle_address: CIRCLE_ADDR, contributions: 4, total_rounds: 4 }],
      defaults: [],
      updatedAt: "2024-01-01T00:00:00Z",
    };
    vi.stubGlobal("fetch", mockOk(payload));

    const rep = await new IndexerClient(BASE_CONFIG).getReputation(MEMBER_ADDR);

    expect(rep.score).toBe(3);
    expect(rep.contributions).toHaveLength(1);
    expect(rep.updatedAt).toBe("2024-01-01T00:00:00Z");
  });

  it("calls the /reputation/:member endpoint", async () => {
    const mockFetch = mockOk({ member: MEMBER_ADDR, score: 0, contributions: [], defaults: [], updatedAt: null });
    vi.stubGlobal("fetch", mockFetch);

    await new IndexerClient(BASE_CONFIG).getReputation(MEMBER_ADDR);

    expect(mockFetch.mock.calls[0][0]).toBe(
      `http://localhost:3001/reputation/${MEMBER_ADDR}`,
    );
  });

  it("URL-encodes the member address", async () => {
    const mockFetch = mockOk({ member: "", score: 0, contributions: [], defaults: [], updatedAt: null });
    vi.stubGlobal("fetch", mockFetch);

    const addr = "G ADDR WITH SPACES";
    await new IndexerClient(BASE_CONFIG).getReputation(addr);

    expect(mockFetch.mock.calls[0][0]).toBe(
      `http://localhost:3001/reputation/${encodeURIComponent(addr)}`,
    );
  });
});

// ─── getMemberContributions ───────────────────────────────────────────────────

describe("IndexerClient.getMemberContributions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns contribution rows and pagination", async () => {
    const payload = {
      member: MEMBER_ADDR,
      circle: null,
      contributions: [
        {
          circle_address: CIRCLE_ADDR,
          member_address: MEMBER_ADDR,
          round_index: 1,
          amount: "100000000",
          tx_hash: "abc",
          ledger: "123",
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    };
    vi.stubGlobal("fetch", mockOk(payload));

    const result = await new IndexerClient(BASE_CONFIG).getMemberContributions(MEMBER_ADDR);

    expect(result.member).toBe(MEMBER_ADDR);
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0].round_index).toBe(1);
    expect(result.pagination.total).toBe(1);
  });

  it("appends circle and pagination query params", async () => {
    const mockFetch = mockOk({
      member: MEMBER_ADDR,
      circle: CIRCLE_ADDR,
      contributions: [],
      pagination: { page: 2, limit: 10, total: 0, totalPages: 0 },
    });
    vi.stubGlobal("fetch", mockFetch);

    await new IndexerClient(BASE_CONFIG).getMemberContributions(MEMBER_ADDR, {
      circle: CIRCLE_ADDR,
      page: 2,
      limit: 10,
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain(`/members/${MEMBER_ADDR}/contributions?`);
    expect(calledUrl).toContain(`circle=${encodeURIComponent(CIRCLE_ADDR)}`);
    expect(calledUrl).toContain("page=2");
    expect(calledUrl).toContain("limit=10");
  });
});

// ─── health ───────────────────────────────────────────────────────────────────

describe("IndexerClient.health", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns status and timestamp", async () => {
    const payload = { status: "ok" as const, timestamp: "2024-01-01T00:00:00Z" };
    vi.stubGlobal("fetch", mockOk(payload));

    const result = await new IndexerClient(BASE_CONFIG).health();

    expect(result.status).toBe("ok");
    expect(result.timestamp).toBe("2024-01-01T00:00:00Z");
  });

  it("throws IndexerError with actionable message when unreachable", async () => {
    vi.stubGlobal("fetch", mockNetworkFailure("ECONNREFUSED"));

    const err = await new IndexerClient(BASE_CONFIG).health().catch((e) => e);

    expect(err).toBeInstanceOf(IndexerError);
    expect((err as IndexerError).message).toContain("config.indexerUrl is correct");
  });
});

// ─── IndexerError shape ───────────────────────────────────────────────────────

describe("IndexerError", () => {
  it("exposes status and url", () => {
    const err = new IndexerError("something went wrong", 404, "http://localhost:3001/circles/X");
    expect(err.name).toBe("IndexerError");
    expect(err.status).toBe(404);
    expect(err.url).toBe("http://localhost:3001/circles/X");
    expect(err.message).toBe("something went wrong");
    expect(err).toBeInstanceOf(Error);
  });
});

// ─── Transport: timeouts, cancellation, failure categories (issue #659) ──────

describe("IndexerClient transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A fetch that never settles unless its AbortSignal fires. */
  function hangingFetch() {
    return vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      }),
    );
  }

  it("defaults to a bounded timeout", () => {
    expect(DEFAULT_INDEXER_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_INDEXER_TIMEOUT_MS)).toBe(true);
  });

  it("passes an AbortSignal to fetch", async () => {
    const mockFetch = mockOk({ circles: [] });
    vi.stubGlobal("fetch", mockFetch);

    await new IndexerClient(BASE_CONFIG).getCircles();

    const init = mockFetch.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeDefined();
  });

  it("rejects with kind 'timeout' when the indexer stalls", async () => {
    vi.stubGlobal("fetch", hangingFetch());

    const err = await new IndexerClient(BASE_CONFIG, { timeoutMs: 20 })
      .getCircles()
      .catch((e) => e);

    expect(err).toBeInstanceOf(IndexerError);
    expect((err as IndexerError).kind).toBe("timeout");
    expect((err as IndexerError).status).toBe(0);
    expect((err as IndexerError).retryable).toBe(true);
    expect((err as IndexerError).message).toContain("timed out after 20 ms");
  });

  it("times out even if fetch ignores the abort signal", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    const err = await new IndexerClient(BASE_CONFIG)
      .health({ timeoutMs: 20 })
      .catch((e) => e);

    expect((err as IndexerError).kind).toBe("timeout");
  });

  it("times out while reading a stalled response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) }),
    );

    const err = await new IndexerClient(BASE_CONFIG, { timeoutMs: 20 })
      .getMembers(CIRCLE_ADDR)
      .catch((e) => e);

    expect((err as IndexerError).kind).toBe("timeout");
  });

  it("rejects with kind 'aborted' when the caller's signal fires", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const controller = new AbortController();

    const pending = new IndexerClient(BASE_CONFIG)
      .getCircleDetail(CIRCLE_ADDR, { signal: controller.signal })
      .catch((e) => e);
    controller.abort();
    const err = await pending;

    expect(err).toBeInstanceOf(IndexerError);
    expect((err as IndexerError).kind).toBe("aborted");
    expect((err as IndexerError).retryable).toBe(false);
  });

  it("does not call fetch when the caller's signal is already aborted", async () => {
    const mockFetch = mockOk({ circles: [] });
    vi.stubGlobal("fetch", mockFetch);
    const controller = new AbortController();
    controller.abort();

    const err = await new IndexerClient(BASE_CONFIG)
      .getCircles(undefined, { signal: controller.signal })
      .catch((e) => e);

    expect((err as IndexerError).kind).toBe("aborted");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("classifies a rejected fetch as kind 'network'", async () => {
    vi.stubGlobal("fetch", mockNetworkFailure("ECONNREFUSED"));

    const err = await new IndexerClient(BASE_CONFIG).getCircles().catch((e) => e);

    expect((err as IndexerError).kind).toBe("network");
    expect((err as IndexerError).retryable).toBe(true);
  });

  it.each([
    [404, false],
    [429, true],
    [500, true],
    [503, true],
  ])("classifies HTTP %i as kind 'http' (retryable: %s)", async (status, retryable) => {
    vi.stubGlobal("fetch", mockError(status));

    const err = await new IndexerClient(BASE_CONFIG).getCircles().catch((e) => e);

    expect((err as IndexerError).kind).toBe("http");
    expect((err as IndexerError).status).toBe(status);
    expect((err as IndexerError).retryable).toBe(retryable);
  });

  it("keeps HTTP classification when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502 })),
    );

    const err = await new IndexerClient(BASE_CONFIG).getCircles().catch((e) => e);

    expect((err as IndexerError).kind).toBe("http");
    expect((err as IndexerError).status).toBe(502);
    expect((err as IndexerError).message).not.toContain("<html>");
  });

  it("truncates a long indexer error string", async () => {
    vi.stubGlobal("fetch", mockError(500, { error: "x".repeat(5_000) }));

    const err = await new IndexerClient(BASE_CONFIG).getCircles().catch((e) => e);

    expect((err as IndexerError).message.length).toBeLessThan(500);
  });

  it("classifies an invalid JSON success body as kind 'json' without echoing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>maintenance page</html>", { status: 200 })),
    );

    const err = await new IndexerClient(BASE_CONFIG).getCircles().catch((e) => e);

    expect(err).toBeInstanceOf(IndexerError);
    expect((err as IndexerError).kind).toBe("json");
    expect((err as IndexerError).status).toBe(200);
    expect((err as IndexerError).retryable).toBe(false);
    expect((err as IndexerError).message).not.toContain("maintenance page");
  });

  it.each([
    ["getCircles", (c: IndexerClient) => c.getCircles(), { circle: [] }],
    ["getCircleDetail", (c: IndexerClient) => c.getCircleDetail(CIRCLE_ADDR), { circle: null, members: [] }],
    ["getMembers", (c: IndexerClient) => c.getMembers(CIRCLE_ADDR), { members: {} }],
    ["getRounds", (c: IndexerClient) => c.getRounds(CIRCLE_ADDR), { rounds: [] }],
    ["getReputation", (c: IndexerClient) => c.getReputation(MEMBER_ADDR), { score: 1 }],
    ["getMemberContributions", (c: IndexerClient) => c.getMemberContributions(MEMBER_ADDR), {}],
    ["getCircleAuditEvents", (c: IndexerClient) => c.getCircleAuditEvents(CIRCLE_ADDR), { events: null }],
    ["health", (c: IndexerClient) => c.health(), { ok: true }],
    ["any method given a JSON array", (c: IndexerClient) => c.getCircles(), []],
  ])("classifies a malformed %s payload as kind 'schema'", async (_name, call, payload) => {
    vi.stubGlobal("fetch", mockOk(payload));

    const err = await call(new IndexerClient(BASE_CONFIG)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(IndexerError);
    expect((err as IndexerError).kind).toBe("schema");
    expect((err as IndexerError).status).toBe(200);
  });

  it("rejects a non-positive timeout at construction", () => {
    expect(() => new IndexerClient(BASE_CONFIG, { timeoutMs: 0 })).toThrow("timeoutMs");
    expect(() => new IndexerClient(BASE_CONFIG, { timeoutMs: Number.NaN })).toThrow("timeoutMs");
  });

  it("infers kind from status for errors constructed without one", () => {
    expect(new IndexerError("x", 0, "u").kind).toBe("network");
    expect(new IndexerError("x", 500, "u").kind).toBe("http");
  });
});
