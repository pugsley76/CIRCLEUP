import { describe, it, expect, vi } from "vitest";

import {
  computeDeadlineDisplay,
  DEADLINE_MAX_DATA_AGE_MS,
  SECONDS_PER_LEDGER,
  ledgersToHuman,
} from "./deadline";

const NOW = 1_700_000_000_000;

function displayFor({
  deadlineLedger = 5000,
  latestLedger = 4000,
  fetchedAtMs = NOW,
  nowMs = NOW,
  status = "Active",
}: {
  deadlineLedger?: number | null | undefined;
  latestLedger?: number | null | undefined;
  fetchedAtMs?: number;
  nowMs?: number;
  status?: string;
} = {}): ReturnType<typeof computeDeadlineDisplay> {
  return computeDeadlineDisplay({
    deadlineLedger,
    latestLedger,
    status,
    fetchedAtMs,
    nowMs,
  });
}

describe("deadline — missing ledger data (unavailable)", () => {
  it("is unavailable when deadlineLedger is null", () => {
    const d = displayFor({ deadlineLedger: null });
    expect(d.kind).toBe("unavailable");
    expect(d.ledgersRemaining).toBeNull();
    expect(d.human).toBe("—");
    expect(d.dataAgeMs).toBeNull();
  });

  it("is unavailable when latestLedger is null", () => {
    const d = displayFor({ latestLedger: null });
    expect(d.kind).toBe("unavailable");
    expect(d.label).toBe("Deadline data not available");
  });

  it("is unavailable when both are undefined", () => {
    const d = displayFor({ deadlineLedger: undefined, latestLedger: undefined });
    expect(d.kind).toBe("unavailable");
  });

  it("never fabricates a countdown when data is missing", () => {
    const d = displayFor({ deadlineLedger: null, latestLedger: 4000 });
    expect(d.isEstimate).toBe(true);
    expect(d.secondsRemaining).toBeNull();
  });
});

describe("deadline — freshness boundaries", () => {
  it("is fresh when data is younger than the max age", () => {
    const d = displayFor({ nowMs: NOW + 60_000 }); // 1 min old
    expect(d.kind).toBe("fresh");
    expect(d.dataAgeMs).toBe(60_000);
  });

  it("is stale exactly at the max age (boundary inclusive)", () => {
    const d = displayFor({ nowMs: NOW + DEADLINE_MAX_DATA_AGE_MS });
    expect(d.kind).toBe("stale");
    expect(d.dataAgeMs).toBe(DEADLINE_MAX_DATA_AGE_MS);
  });

  it("is stale one ms past the max age", () => {
    const d = displayFor({ nowMs: NOW + DEADLINE_MAX_DATA_AGE_MS + 1 });
    expect(d.kind).toBe("stale");
  });

  it("labels fresh data as an estimate, never exact", () => {
    const d = displayFor({ nowMs: NOW + 1 });
    expect(d.kind).toBe("fresh");
    expect(d.label).toMatch(/estimate/i);
    expect(d.isEstimate).toBe(true);
  });

  it("labels stale data as stale and as an estimate", () => {
    const d = displayFor({ nowMs: NOW + DEADLINE_MAX_DATA_AGE_MS });
    expect(d.kind).toBe("stale");
    expect(d.label).toMatch(/stale/i);
    expect(d.label).toMatch(/estimate/i);
  });
});

describe("deadline — ledger math and thresholds", () => {
  it("computes ledgers remaining as deadline minus latest", () => {
    const d = displayFor({ deadlineLedger: 5000, latestLedger: 4000 });
    expect(d.ledgersRemaining).toBe(1000);
    expect(d.secondsRemaining).toBe(1000 * SECONDS_PER_LEDGER);
  });

  it("advances deterministically as the latest ledger advances", () => {
    const earlier = displayFor({ latestLedger: 4000 });
    const later = displayFor({ latestLedger: 4900 });
    expect(later.ledgersRemaining).toBeLessThan(earlier.ledgersRemaining);
    expect(later.human).not.toBe(earlier.human);
  });

  it("is overdue when the latest ledger has passed the deadline", () => {
    const d = displayFor({ deadlineLedger: 5000, latestLedger: 5001 });
    expect(d.isOverdue).toBe(true);
    expect(d.label).toMatch(/overdue/i);
    expect(d.urgency).toBe("red");
    expect(d.human).toBe("overdue");
  });

  it("is overdue exactly at the deadline (boundary)", () => {
    const d = displayFor({ deadlineLedger: 5000, latestLedger: 5000 });
    expect(d.isOverdue).toBe(true);
  });

  it("is not overdue one ledger before the deadline", () => {
    const d = displayFor({ deadlineLedger: 5000, latestLedger: 4999 });
    expect(d.isOverdue).toBe(false);
  });

  it("formats remaining time in human units", () => {
    // 1000 ledgers × 5 s = 5000 s ≈ 1h 23m
    const d = displayFor({ deadlineLedger: 5000, latestLedger: 4000 });
    expect(d.human).toBe("1h 23m");
  });
});

describe("deadline — urgency", () => {
  it("is green when more than 2 days remain", () => {
    const d = displayFor({ deadlineLedger: 4000 + 2 * 17_280 + 1, latestLedger: 4000 });
    expect(d.urgency).toBe("green");
  });

  it("is yellow within 2 days", () => {
    const d = displayFor({ deadlineLedger: 4000 + 17_280, latestLedger: 4000 });
    expect(d.urgency).toBe("yellow");
  });

  it("is red within a day", () => {
    const d = displayFor({ deadlineLedger: 4000 + 8_640, latestLedger: 4000 });
    expect(d.urgency).toBe("red");
  });
});

describe("deadline — shared constants", () => {
  it("DEADLINE_MAX_DATA_AGE_MS is a finite positive number", () => {
    expect(Number.isFinite(DEADLINE_MAX_DATA_AGE_MS)).toBe(true);
    expect(DEADLINE_MAX_DATA_AGE_MS).toBeGreaterThan(0);
  });

  it("SECONDS_PER_LEDGER is 5", () => {
    expect(SECONDS_PER_LEDGER).toBe(5);
  });
});
