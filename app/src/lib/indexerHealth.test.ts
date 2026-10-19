/**
 * Tests for lib/indexerHealth.ts
 *
 * Covers:
 *   1. Missing checkpoint — unknown vs degraded vs healthy
 *   2. Clock skew — future timestamps are clamped to age = 0
 *   3. Slow chains — high ledger lag degrades even with fresh checkpoint
 *   4. RPC outage — stale checkpoint age triggers rpc_outage
 *   5. Threshold overrides — operators can tune limits
 *   6. formatAge — human-readable duration formatting
 *   7. unknown freshness is NEVER reported as healthy
 */

import { describe, it, expect } from "vitest";
import {
  classifyIndexerHealth,
  formatAge,
  type IndexerHealth,
} from "./indexerHealth";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW_SEC = 1_000_000; // fixed "now" so all tests are deterministic
// An ISO timestamp that is exactly 30 seconds before NOW_SEC
const FRESH_CHECKPOINT = new Date((NOW_SEC - 30) * 1000).toISOString();
// An ISO timestamp that is 10 minutes before NOW_SEC (degraded)
const STALE_CHECKPOINT = new Date((NOW_SEC - 600) * 1000).toISOString();
// An ISO timestamp that is 35 minutes before NOW_SEC (outage)
const OUTAGE_CHECKPOINT = new Date((NOW_SEC - 2100) * 1000).toISOString();
// A timestamp slightly in the FUTURE (clock skew)
const FUTURE_CHECKPOINT = new Date((NOW_SEC + 60) * 1000).toISOString();

const OPTS = { nowSec: NOW_SEC };

// ─── 1. Missing checkpoint ────────────────────────────────────────────────────

describe("missing checkpoint", () => {
  it("returns unknown when both checkpointTime and latestLedger are absent", () => {
    const h = classifyIndexerHealth(null, null, null, OPTS);
    expect(h.status).toBe("unknown");
    expect(h.checkpointTimestampSource).toBe("absent");
    expect(h.checkpointAgeSec).toBeNull();
    expect(h.ledgerLag).toBeNull();
  });

  it("returns degraded (not healthy) when latestLedger is present but checkpointTime is absent", () => {
    const h = classifyIndexerHealth(100, 110, null, OPTS);
    expect(h.status).toBe("degraded");
    expect(h.checkpointTimestampSource).toBe("absent");
    expect(h.latestLedger).toBe(100);
    // The description must mention the absence of a timestamp
    expect(h.statusDescription).toMatch(/checkpoint/i);
  });

  it("returns degraded when latestLedger is present, no checkpoint, and lag exceeds threshold", () => {
    const h = classifyIndexerHealth(100, 500, null, { ...OPTS, maxLedgerLag: 50 });
    expect(h.status).toBe("degraded");
    expect(h.ledgerLag).toBe(400);
  });

  it("source is always 'absent' when checkpointTime is null", () => {
    const h = classifyIndexerHealth(100, 110, null, OPTS);
    expect(h.checkpointTimestampSource).toBe("absent");
  });

  it("source is 'indexer_response' when checkpointTime is provided", () => {
    const h = classifyIndexerHealth(100, 110, FRESH_CHECKPOINT, OPTS);
    expect(h.checkpointTimestampSource).toBe("indexer_response");
  });
});

// ─── 2. Clock skew ────────────────────────────────────────────────────────────

describe("clock skew — future timestamps", () => {
  it("clamps a future checkpoint to age 0, not a negative age", () => {
    const h = classifyIndexerHealth(100, 110, FUTURE_CHECKPOINT, OPTS);
    expect(h.checkpointAgeSec).toBe(0);
  });

  it("a future checkpoint with small lag is classified healthy (not negative-age nonsense)", () => {
    const h = classifyIndexerHealth(100, 105, FUTURE_CHECKPOINT, {
      ...OPTS,
      maxLedgerLag: 50,
      maxCheckpointAgeSec: 300,
    });
    expect(h.status).toBe("healthy");
    expect(h.checkpointAgeSec).toBe(0);
  });

  it("does not throw or return NaN for a wildly future timestamp", () => {
    const wayFuture = new Date((NOW_SEC + 86400) * 1000).toISOString();
    const h = classifyIndexerHealth(100, 100, wayFuture, OPTS);
    expect(h.checkpointAgeSec).toBe(0);
    expect(typeof h.checkpointAgeSec).toBe("number");
  });

  it("an unparseable timestamp is treated as absent (age remains null)", () => {
    const h = classifyIndexerHealth(100, 110, "not-a-date", OPTS);
    // Source is "indexer_response" (field was present) but age is null
    expect(h.checkpointTimestampSource).toBe("indexer_response");
    expect(h.checkpointAgeSec).toBeNull();
  });
});

// ─── 3. Slow chains ───────────────────────────────────────────────────────────

describe("slow chain — high ledger lag", () => {
  it("degrades when ledger lag exceeds default threshold (100)", () => {
    const h = classifyIndexerHealth(100, 205, FRESH_CHECKPOINT, OPTS);
    // lag = 105 > 100
    expect(h.status).toBe("degraded");
    expect(h.ledgerLag).toBe(105);
  });

  it("does not degrade on lag exactly at the threshold", () => {
    const h = classifyIndexerHealth(100, 200, FRESH_CHECKPOINT, OPTS);
    // lag = 100 == threshold → healthy
    expect(h.status).toBe("healthy");
  });

  it("degrades on lag of 1 above a custom threshold", () => {
    const h = classifyIndexerHealth(900, 951, FRESH_CHECKPOINT, {
      ...OPTS,
      maxLedgerLag: 50,
    });
    expect(h.status).toBe("degraded");
    expect(h.ledgerLag).toBe(51);
  });

  it("remains healthy when lag is within a relaxed custom threshold", () => {
    const h = classifyIndexerHealth(100, 600, FRESH_CHECKPOINT, {
      ...OPTS,
      maxLedgerLag: 1000,
      maxCheckpointAgeSec: 300,
    });
    expect(h.status).toBe("healthy");
  });

  it("null chainTipLedger means no lag can be computed (null ledgerLag)", () => {
    const h = classifyIndexerHealth(100, null, FRESH_CHECKPOINT, OPTS);
    expect(h.ledgerLag).toBeNull();
    // With fresh checkpoint and no lag data we can still be healthy
    expect(h.status).toBe("healthy");
  });
});

// ─── 4. RPC outage ────────────────────────────────────────────────────────────

describe("RPC outage — stale checkpoint", () => {
  it("returns rpc_outage when checkpoint age exceeds default outage threshold (30 min)", () => {
    const h = classifyIndexerHealth(100, 105, OUTAGE_CHECKPOINT, OPTS);
    // OUTAGE_CHECKPOINT is 35 minutes old
    expect(h.status).toBe("rpc_outage");
    expect(h.checkpointAgeSec).toBeCloseTo(2100, 0);
  });

  it("returns degraded (not outage) when checkpoint is stale but below outage threshold", () => {
    const h = classifyIndexerHealth(100, 105, STALE_CHECKPOINT, OPTS);
    // STALE_CHECKPOINT is 10 minutes old — degraded, not outage
    expect(h.status).toBe("degraded");
    expect(h.checkpointAgeSec).toBeCloseTo(600, 0);
  });

  it("rpc_outage takes priority over ledger lag being fine", () => {
    // Even with zero ledger lag, an outage-level stale checkpoint is rpc_outage
    const h = classifyIndexerHealth(1000, 1000, OUTAGE_CHECKPOINT, OPTS);
    expect(h.status).toBe("rpc_outage");
  });

  it("custom rpcOutageThresholdSec overrides the default", () => {
    // 10-minute checkpoint, operator sets outage threshold to 5 minutes
    const h = classifyIndexerHealth(100, 105, STALE_CHECKPOINT, {
      ...OPTS,
      rpcOutageThresholdSec: 300, // 5 min
    });
    expect(h.status).toBe("rpc_outage");
  });

  it("outage description mentions the threshold", () => {
    const h = classifyIndexerHealth(100, 105, OUTAGE_CHECKPOINT, OPTS);
    expect(h.statusDescription).toMatch(/outage|stalled/i);
  });
});

// ─── 5. Threshold overrides ───────────────────────────────────────────────────

describe("threshold overrides", () => {
  it("maxLedgerLag override changes degraded boundary", () => {
    // Default threshold is 100; override to 500 — should stay healthy
    const h = classifyIndexerHealth(100, 250, FRESH_CHECKPOINT, {
      ...OPTS,
      maxLedgerLag: 500,
    });
    expect(h.status).toBe("healthy");
  });

  it("maxCheckpointAgeSec override changes degraded boundary", () => {
    // STALE_CHECKPOINT is 10 min old; set max to 20 min — should stay healthy
    const h = classifyIndexerHealth(100, 105, STALE_CHECKPOINT, {
      ...OPTS,
      maxCheckpointAgeSec: 1200,
    });
    expect(h.status).toBe("healthy");
  });

  it("nowSec override makes age deterministic across test runs", () => {
    const ts = new Date(500_000 * 1000).toISOString(); // checkpoint at epoch 500000
    const h = classifyIndexerHealth(100, 110, ts, { nowSec: 500_060 }); // 60s later
    expect(h.checkpointAgeSec).toBeCloseTo(60, 0);
  });
});

// ─── 6. formatAge ─────────────────────────────────────────────────────────────

describe("formatAge", () => {
  it("formats sub-minute durations in seconds", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(1)).toBe("1s");
    expect(formatAge(59)).toBe("59s");
  });

  it("formats minute-range durations in minutes", () => {
    expect(formatAge(60)).toBe("1m");
    expect(formatAge(90)).toBe("2m");   // rounds 1.5 → 2
    expect(formatAge(3599)).toBe("60m");
  });

  it("formats hour-range durations with one decimal place", () => {
    expect(formatAge(3600)).toBe("1.0h");
    expect(formatAge(5400)).toBe("1.5h");
    expect(formatAge(7200)).toBe("2.0h");
  });
});

// ─── 7. unknown is never healthy ─────────────────────────────────────────────

describe("unknown freshness is never healthy", () => {
  it("returns unknown when no signal at all", () => {
    const h = classifyIndexerHealth(null, null, null, OPTS);
    expect(h.status).not.toBe("healthy");
    expect(h.status).toBe("unknown");
  });

  it("statusDescription for unknown does not contain the word 'healthy'", () => {
    const h = classifyIndexerHealth(null, null, null, OPTS);
    expect(h.statusDescription.toLowerCase()).not.toContain("healthy");
  });

  it("absent timestamp with no latestLedger is not healthy even with zero lag", () => {
    // chainTip and latestLedger both null → ledgerLag null → unknown
    const h = classifyIndexerHealth(null, null, null, OPTS);
    expect(h.status).toBe("unknown");
  });

  it("absent timestamp with latestLedger is degraded, not healthy", () => {
    const h = classifyIndexerHealth(500, 500, null, OPTS);
    // lag = 0, but no checkpoint → degraded (not healthy, not unknown)
    expect(h.status).toBe("degraded");
    expect(h.status).not.toBe("healthy");
  });

  it("health.status exhaustive — all four states are reachable", () => {
    const healthy  = classifyIndexerHealth(100, 110, FRESH_CHECKPOINT, OPTS);
    const degraded = classifyIndexerHealth(100, 205, FRESH_CHECKPOINT, OPTS); // lag > 100
    const outage   = classifyIndexerHealth(100, 105, OUTAGE_CHECKPOINT, OPTS);
    const unknown  = classifyIndexerHealth(null, null, null, OPTS);

    expect(healthy.status).toBe("healthy");
    expect(degraded.status).toBe("degraded");
    expect(outage.status).toBe("rpc_outage");
    expect(unknown.status).toBe("unknown");
  });
});

// ─── 8. Result shape completeness ────────────────────────────────────────────

describe("result shape", () => {
  it("checkpointTime in result matches what was passed in", () => {
    const h = classifyIndexerHealth(100, 105, FRESH_CHECKPOINT, OPTS);
    expect(h.checkpointTime).toBe(FRESH_CHECKPOINT);
  });

  it("checkpointTime is null in result when not passed", () => {
    const h = classifyIndexerHealth(100, 105, null, OPTS);
    expect(h.checkpointTime).toBeNull();
  });

  it("latestLedger in result matches input", () => {
    const h = classifyIndexerHealth(12345, 12400, FRESH_CHECKPOINT, OPTS);
    expect(h.latestLedger).toBe(12345);
  });

  it("statusDescription is always a non-empty string", () => {
    for (const h of [
      classifyIndexerHealth(null, null, null, OPTS),
      classifyIndexerHealth(100, 110, null, OPTS),
      classifyIndexerHealth(100, 110, FRESH_CHECKPOINT, OPTS),
      classifyIndexerHealth(100, 110, OUTAGE_CHECKPOINT, OPTS),
    ]) {
      expect(typeof h.statusDescription).toBe("string");
      expect(h.statusDescription.length).toBeGreaterThan(0);
    }
  });
});
