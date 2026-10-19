/**
 * Tests for graceful shutdown handling of the event poller.
 *
 * Covers the key invariants the shutdown sequence must uphold:
 *
 *  1. stopIndexer() is a safe no-op when the poller was never started.
 *  2. An already-aborted AbortSignal passed to stopIndexer() is still a no-op.
 *  3. stopIndexer() resolves immediately when no in-flight cycle is running.
 *  4. isIndexerRunning() reflects the lifecycle state accurately.
 *  5. runEventHandler() isolates a successful handler and increments metrics.
 *  6. runEventHandler() isolates a throwing handler, increments failure count,
 *     and does NOT re-throw — the caller is never impacted.
 *  7. getIndexerMetrics() is a non-destructive snapshot read (idempotent).
 *  8. Multiple interleaved success/failure handlers accumulate metrics correctly.
 *
 * Env vars required by config.ts are set before any module is imported so the
 * assertEnvVars() boot-time check passes without a real .env file.  The values
 * are fake but syntactically valid — they are never used in these tests because
 * no RPC or DB call is made.
 */

// ── Minimal env bootstrap ─────────────────────────────────────────────────────
// Must come before ANY import of ./indexer or ./config so assertEnvVars() sees
// values when it executes at module-load time.  The contract addresses are fake
// but pass the /^C[A-Z2-7]{55}$/ format check — no real RPC or DB calls are
// made in these tests so the values are never dereferenced.
process.env.DATABASE_URL           = "postgresql://test:test@localhost:5432/test";
process.env.STELLAR_RPC_URL        = "https://soroban-testnet.stellar.org";
process.env.CIRCLE_FACTORY_ADDRESS = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
process.env.REPUTATION_ADDRESS     = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
process.env.USDC_ADDRESS           = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  stopIndexer,
  isIndexerRunning,
  getIndexerMetrics,
  runEventHandler,
} from "./indexer";

// ─── Shutdown when poller was never started ───────────────────────────────────

describe("Graceful shutdown — poller never started", () => {
  test("stopIndexer is a safe no-op when the poller was never started", async () => {
    assert.equal(isIndexerRunning(), false);
    await assert.doesNotReject(() => stopIndexer());
    assert.equal(isIndexerRunning(), false);
  });

  test("stopIndexer with an already-aborted signal is a no-op", async () => {
    const controller = new AbortController();
    controller.abort();
    assert.equal(isIndexerRunning(), false);
    await assert.doesNotReject(() => stopIndexer(controller.signal));
    assert.equal(isIndexerRunning(), false);
  });

  test("stopIndexer resolves promptly when there is no in-flight cycle", async () => {
    // Provide an AbortController that fires after 200 ms — since there is no
    // in-flight work, stopIndexer must resolve before the signal fires.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      await assert.doesNotReject(() => stopIndexer(controller.signal));
    } finally {
      clearTimeout(timer);
    }
  });
});

// ─── isIndexerRunning lifecycle ───────────────────────────────────────────────

describe("isIndexerRunning", () => {
  test("returns false before any start call", () => {
    assert.equal(isIndexerRunning(), false);
  });

  test("remains false after a no-op stopIndexer call on a clean state", async () => {
    await stopIndexer();
    assert.equal(isIndexerRunning(), false);
  });
});

// ─── runEventHandler success isolation ───────────────────────────────────────

describe("runEventHandler: success", () => {
  test("returns true and increments totalEventsProcessed by 1", async () => {
    const before = getIndexerMetrics();
    const ok = await runEventHandler(async () => {}, {
      contractId: "CCIRCLE",
      topic: "circle/contributed",
      ledger: 200,
    });
    assert.equal(ok, true);
    const after = getIndexerMetrics();
    assert.equal(after.totalEventsProcessed, before.totalEventsProcessed + 1);
    assert.equal(after.totalEventsFailed, before.totalEventsFailed);
  });

  test("three sequential successes accumulate in totalEventsProcessed", async () => {
    const before = getIndexerMetrics();
    for (let i = 0; i < 3; i++) {
      await runEventHandler(async () => {}, {
        contractId: "CCIRCLE",
        topic: "circle/active",
        ledger: 300 + i,
      });
    }
    const after = getIndexerMetrics();
    assert.equal(after.totalEventsProcessed, before.totalEventsProcessed + 3);
    assert.equal(after.totalEventsFailed, before.totalEventsFailed);
  });
});

// ─── runEventHandler failure isolation ───────────────────────────────────────

describe("runEventHandler: failure isolation", () => {
  test("returns false and increments totalEventsFailed without re-throwing", async () => {
    const before = getIndexerMetrics();
    const ok = await runEventHandler(
      async () => { throw new Error("intentional handler error"); },
      { contractId: "CCIRCLE", topic: "circle/payout", ledger: 201, txHash: "abc" },
    );
    assert.equal(ok, false);
    const after = getIndexerMetrics();
    assert.equal(after.totalEventsFailed, before.totalEventsFailed + 1);
    assert.equal(after.totalEventsProcessed, before.totalEventsProcessed);
  });

  test("three failures accumulate without touching success counter", async () => {
    const before = getIndexerMetrics();
    for (let i = 0; i < 3; i++) {
      await runEventHandler(
        async () => { throw new Error("batch error"); },
        { contractId: "CCIRCLE", topic: "circle/default", ledger: 400 + i },
      );
    }
    const after = getIndexerMetrics();
    assert.equal(after.totalEventsFailed, before.totalEventsFailed + 3);
    assert.equal(after.totalEventsProcessed, before.totalEventsProcessed);
  });

  test("success and failure handlers interleave correctly", async () => {
    const before = getIndexerMetrics();
    // success
    await runEventHandler(async () => {}, { contractId: "C1", topic: "circle/joined", ledger: 500 });
    // failure
    await runEventHandler(
      async () => { throw new Error("fail"); },
      { contractId: "C1", topic: "circle/payout", ledger: 501 },
    );
    // success
    await runEventHandler(async () => {}, { contractId: "C1", topic: "circle/completed", ledger: 502 });
    const after = getIndexerMetrics();
    assert.equal(after.totalEventsProcessed, before.totalEventsProcessed + 2);
    assert.equal(after.totalEventsFailed, before.totalEventsFailed + 1);
  });
});

// ─── getIndexerMetrics snapshot safety ────────────────────────────────────────

describe("getIndexerMetrics", () => {
  test("is a non-destructive read — two consecutive calls return the same values", () => {
    const snap1 = getIndexerMetrics();
    const snap2 = getIndexerMetrics();
    assert.equal(snap1.totalEventsProcessed, snap2.totalEventsProcessed);
    assert.equal(snap1.totalEventsFailed, snap2.totalEventsFailed);
    assert.equal(snap1.pollCyclesCompleted, snap2.pollCyclesCompleted);
  });
});
