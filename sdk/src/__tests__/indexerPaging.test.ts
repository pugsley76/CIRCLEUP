/**
 * IndexerClient paging and filter contract.
 *
 * Mirrors the route parsers in indexer/src/api.ts:
 *
 * | Route                               | Options                                   | Defaults                           |
 * |-------------------------------------|-------------------------------------------|------------------------------------|
 * | GET /circles                        | status, sort, order, page, limit (1–100)  | sort=created_ledger, order=desc, page=1, limit=20 |
 * | GET /members/:member/contributions  | circle, page, limit (1–100)               | page=1, limit=20                   |
 *
 * Covered: local rejection of invalid options (before any request), URL
 * encoding, empty pages, retention and validation of the server's pagination
 * metadata, and the bounded page iterators.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { IndexerClient, IndexerError } from "../client";
import { INDEXER_MAX_PAGE_SIZE } from "../constants";
import type { CircleUpConfig, GetCirclesParams } from "../types";
import { CIRCLE_ADDR, MEMBER_A_ADDR, SDK_CONFIG } from "./fixtures";

const CONFIG: CircleUpConfig = { ...SDK_CONFIG, indexerUrl: "http://localhost:3001" };
const indexer = () => new IndexerClient(CONFIG);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/** Stub fetch with a responder and return the mock so URLs can be inspected. */
function stubFetch(respond: (url: URL) => unknown) {
  const mock = vi.fn(async (url: string) => jsonResponse(respond(new URL(url))));
  vi.stubGlobal("fetch", mock);
  return mock;
}

/**
 * A server holding `total` circles, paged the way GET /circles pages them —
 * honouring `page` and `limit` from the request URL.
 */
function circlesServer(total: number) {
  return stubFetch((url) => {
    const page = Number(url.searchParams.get("page") ?? 1);
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const start = (page - 1) * limit;
    const count = Math.max(0, Math.min(limit, total - start));
    return {
      circles: Array.from({ length: count }, (_, i) => ({ address: `C${start + i}` })),
      pagination: { page, limit, total, totalPages: total === 0 ? 0 : Math.ceil(total / limit) },
    };
  });
}

function calledUrls(mock: ReturnType<typeof stubFetch>): URL[] {
  return mock.mock.calls.map(([u]) => new URL(u as string));
}

// ─── Local validation ─────────────────────────────────────────────────────────

describe("invalid options fail locally", () => {
  it.each<[string, unknown, RegExp]>([
    ["an unknown key", { pageSize: 50 }, /unknown option "pageSize"/],
    ["limit 0", { limit: 0 }, /limit must be an integer between 1 and 100/],
    ["limit above the server maximum", { limit: INDEXER_MAX_PAGE_SIZE + 1 }, /limit/],
    ["a fractional limit", { limit: 1.5 }, /limit/],
    ["a numeric-string limit", { limit: "20" }, /limit/],
    ["page 0", { page: 0 }, /page must be an integer/],
    ["NaN page", { page: Number.NaN }, /page/],
    ["a lower-case status", { status: "active" }, /status must be one of/],
    ["an unsupported sort", { sort: "name" }, /sort must be one of/],
    ["an unsupported order", { order: "up" }, /order must be one of/],
    ["a non-object", "status=Active", /options must be an object/],
  ])("getCircles rejects %s without a request", async (_label, params, message) => {
    const fetchMock = stubFetch(() => ({}));
    const err = await indexer()
      .getCircles(params as GetCirclesParams)
      .catch((e) => e);
    expect(err).toBeInstanceOf(RangeError);
    expect(err.message).toMatch(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports every invalid option at once", async () => {
    stubFetch(() => ({}));
    const err = await indexer()
      .getCircles({ page: -1, limit: 500, order: "sideways" } as any)
      .catch((e) => e);
    expect(err.message).toMatch(/page/);
    expect(err.message).toMatch(/limit/);
    expect(err.message).toMatch(/order/);
  });

  it.each<[string, unknown, RegExp]>([
    ["a circle filter that is not an address", { circle: "my-circle" }, /circle must be a Stellar address/],
    ["an unknown key", { circleAddress: CIRCLE_ADDR }, /unknown option "circleAddress"/],
    ["limit above the server maximum", { limit: 1_000 }, /limit/],
  ])("getMemberContributions rejects %s without a request", async (_label, options, message) => {
    const fetchMock = stubFetch(() => ({}));
    const err = await indexer()
      .getMemberContributions(MEMBER_A_ADDR, options as any)
      .catch((e) => e);
    expect(err).toBeInstanceOf(RangeError);
    expect(err.message).toMatch(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("iterateCircles rejects an invalid bound synchronously", () => {
    stubFetch(() => ({}));
    expect(() => indexer().iterateCircles({}, { maxPages: 0 })).toThrow(RangeError);
    expect(() => indexer().iterateCircles({}, { maxPages: 1_001 })).toThrow(RangeError);
    expect(() => indexer().iterateCircles({ limit: 0 })).toThrow(/limit/);
  });

  it("accepts the documented boundary values", async () => {
    const fetchMock = circlesServer(0);
    await indexer().getCircles({ page: 1, limit: 1 });
    await indexer().getCircles({ page: 1, limit: INDEXER_MAX_PAGE_SIZE });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ─── URL encoding ─────────────────────────────────────────────────────────────

describe("query and path encoding", () => {
  it("sends every filter, and omits options left undefined", async () => {
    const fetchMock = circlesServer(0);
    await indexer().getCircles({
      status: "Closed",
      sort: "round_amount",
      order: "asc",
      page: 1,
      limit: 50,
      // An explicitly undefined option is the same as an omitted one.
      ...({ status: undefined } as {}),
    } as GetCirclesParams);
    const [url] = calledUrls(fetchMock);
    expect(url.pathname).toBe("/circles");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      sort: "round_amount",
      order: "asc",
      page: "1",
      limit: "50",
    });
  });

  it("sends no query string when no options are given", async () => {
    const fetchMock = circlesServer(0);
    await indexer().getCircles();
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:3001/circles");
  });

  it("percent-encodes the member path segment", async () => {
    const fetchMock = stubFetch(() => ({
      contributions: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    }));
    await indexer().getMemberContributions("G A/B?x");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://localhost:3001/members/G%20A%2FB%3Fx/contributions",
    );
  });

  it("sends the circle filter and paging for contributions", async () => {
    const fetchMock = stubFetch(() => ({
      contributions: [],
      pagination: { page: 3, limit: 5, total: 0, totalPages: 0 },
    }));
    await indexer().getMemberContributions(MEMBER_A_ADDR, { circle: CIRCLE_ADDR, page: 3, limit: 5 });
    const [url] = calledUrls(fetchMock);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      circle: CIRCLE_ADDR,
      page: "3",
      limit: "5",
    });
  });
});

// ─── Pagination metadata ──────────────────────────────────────────────────────

describe("server pagination metadata", () => {
  it("is retained on a single-page read", async () => {
    circlesServer(45);
    const r = await indexer().getCircles({ page: 2, limit: 20 });
    expect(r.circles).toHaveLength(20);
    expect(r.pagination).toEqual({ page: 2, limit: 20, total: 45, totalPages: 3 });
  });

  it("an empty result is a valid page", async () => {
    circlesServer(0);
    const r = await indexer().getCircles({ status: "Active" });
    expect(r.circles).toEqual([]);
    expect(r.pagination).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
  });

  it("keeps hasMore and totalAmount from the contributions envelope", async () => {
    stubFetch(() => ({
      member: MEMBER_A_ADDR,
      circle: null,
      contributions: [],
      totalAmount: "300000000",
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasMore: false },
    }));
    const r = await indexer().getMemberContributions(MEMBER_A_ADDR);
    expect(r.totalAmount).toBe("300000000");
    expect(r.pagination.hasMore).toBe(false);
  });

  it.each<[string, unknown, RegExp]>([
    ["no pagination", { circles: [] }, /"pagination" metadata is missing/],
    ["rows that are not an array", { circles: null, pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }, /"circles" is not an array/],
    ["a string total", { circles: [], pagination: { page: 1, limit: 20, total: "0", totalPages: 0 } }, /total/],
    ["a non-boolean hasMore", { circles: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasMore: "no" } }, /hasMore/],
    ["more rows than the limit", { circles: [{}, {}], pagination: { page: 1, limit: 1, total: 2, totalPages: 2 } }, /exceed the page limit/],
  ])("rejects a response with %s", async (_label, body, message) => {
    stubFetch(() => body);
    const err = await indexer().getCircles().catch((e) => e);
    expect(err).toBeInstanceOf(IndexerError);
    expect(err.message).toMatch(message);
    expect(err.url).toBe("http://localhost:3001/circles");
  });

  it("rejects a page other than the one requested (e.g. a dropped query string)", async () => {
    stubFetch(() => ({ circles: [], pagination: { page: 1, limit: 20, total: 60, totalPages: 3 } }));
    const err = await indexer().getCircles({ page: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(IndexerError);
    expect(err.message).toMatch(/requested page 3 but the server returned page 1/);
  });

  it("rejects a limit other than the one requested", async () => {
    stubFetch(() => ({ circles: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }));
    const err = await indexer().getCircles({ limit: 50 }).catch((e) => e);
    expect(err.message).toMatch(/requested limit 50 but the server applied 20/);
  });
});

// ─── Bounded iteration ────────────────────────────────────────────────────────

describe("page iterators", () => {
  async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
  }

  it("walks every page in order, keeping filters and metadata", async () => {
    const fetchMock = circlesServer(45);
    const pages = await collect(indexer().iterateCircles({ status: "Active", limit: 20 }));

    expect(pages.map((p) => p.pagination.page)).toEqual([1, 2, 3]);
    expect(pages.flatMap((p) => p.circles)).toHaveLength(45);
    for (const url of calledUrls(fetchMock)) {
      expect(url.searchParams.get("status")).toBe("Active");
      expect(url.searchParams.get("limit")).toBe("20");
    }
  });

  it("starts from the requested page", async () => {
    circlesServer(45);
    const pages = await collect(indexer().iterateCircles({ page: 2 }));
    expect(pages.map((p) => p.pagination.page)).toEqual([2, 3]);
  });

  it("stops after one request on an empty result", async () => {
    const fetchMock = circlesServer(0);
    const pages = await collect(indexer().iterateCircles());
    expect(pages).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is bounded to 10 pages by default", async () => {
    const fetchMock = circlesServer(10_000);
    const pages = await collect(indexer().iterateCircles({ limit: 1 }));
    expect(pages).toHaveLength(10);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    // The caller can see the bound cut the walk short.
    const last = pages[pages.length - 1].pagination;
    expect(last.page).toBeLessThan(last.totalPages);
  });

  it("honours an explicit maxPages", async () => {
    circlesServer(100);
    const pages = await collect(indexer().iterateCircles({ limit: 10 }, { maxPages: 2 }));
    expect(pages).toHaveLength(2);
  });

  it("does not fetch until iterated, and stops when the caller breaks", async () => {
    const fetchMock = circlesServer(100);
    const it = indexer().iterateCircles({ limit: 10 });
    expect(fetchMock).not.toHaveBeenCalled();
    for await (const _ of it) break;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops contributions on hasMore: false", async () => {
    const fetchMock = stubFetch((url) => {
      const page = Number(url.searchParams.get("page") ?? 1);
      return {
        member: MEMBER_A_ADDR,
        circle: null,
        contributions: [{ round_index: page }],
        pagination: { page, limit: 1, total: 99, totalPages: 99, hasMore: page < 2 },
      };
    });
    const pages = await collect(
      indexer().iterateMemberContributions(MEMBER_A_ADDR, { limit: 1 }),
    );
    expect(pages).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates a mid-walk failure instead of returning partial results", async () => {
    let calls = 0;
    stubFetch((url) => {
      calls++;
      const page = Number(url.searchParams.get("page") ?? 1);
      // Second response claims to be page 1 again.
      return {
        circles: [{}],
        pagination: { page: calls === 1 ? page : 1, limit: 1, total: 5, totalPages: 5 },
      };
    });
    await expect(collect(indexer().iterateCircles({ limit: 1 }))).rejects.toBeInstanceOf(
      IndexerError,
    );
  });
});
