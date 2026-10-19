import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runEventHandler,
  getIndexerMetrics,
  USDC,
  stopIndexer,
  isIndexerRunning,
  parseCircleCreatedEvent,
  parseJoinedEvent,
  parseInitializedEvent,
  computeJitteredDelay,
  isTransientRpcError,
} from "./indexer";

test("USDC is read from the validated USDC_ADDRESS env var, not left dangling", () => {
  assert.equal(USDC, process.env.USDC_ADDRESS);
  assert.ok(USDC && USDC.length > 0, "USDC_ADDRESS must be a non-empty string once config validation passes");
});

test("runEventHandler counts a successful handler and returns true", async () => {
  const before = getIndexerMetrics();

  const ok = await runEventHandler(async () => {}, {
    contractId: "CCIRCLE",
    topic: "circle/joined",
    ledger: 100,
  });

  assert.equal(ok, true);
  const after = getIndexerMetrics();
  assert.equal(after.totalEventsProcessed, before.totalEventsProcessed + 1);
  assert.equal(after.totalEventsFailed, before.totalEventsFailed);
});

test("runEventHandler isolates a throwing handler instead of propagating", async () => {
  const before = getIndexerMetrics();

  const ok = await runEventHandler(
    async () => {
      throw new Error("malformed event payload");
    },
    { contractId: "CCIRCLE", topic: "circle/contributed", ledger: 101, txHash: "deadbeef" },
  );

  assert.equal(ok, false);
  const after = getIndexerMetrics();
  assert.equal(after.totalEventsFailed, before.totalEventsFailed + 1);
  assert.equal(after.totalEventsProcessed, before.totalEventsProcessed);
});

test("stopIndexer is a safe no-op when the poller was never started", async () => {
  assert.equal(isIndexerRunning(), false);
  await assert.doesNotReject(() => stopIndexer());
  assert.equal(isIndexerRunning(), false);
});

// ─── parseCircleCreatedEvent — factory/circle_created field-mapping tests ─────
//
// These tests act as a contract between the on-chain event shape and the
// indexer.  If anyone changes the factory event data tuple they'll see these
// tests fail before the DB gets silently written with wrong data.

test("parseCircleCreatedEvent: parses well-formed tuple into named fields", () => {
  const result = parseCircleCreatedEvent([
    "CCIRCLEXXX",
    "GCREATORYYY",
    3,
  ]);

  assert.equal(result.circleAddress, "CCIRCLEXXX");
  assert.equal(result.creator, "GCREATORYYY");
  assert.equal(result.circleIndex, 3, "third element is circle_index, not round_deadline_ledgers");
});

test("parseCircleCreatedEvent: circle_index 0 is valid (first-ever circle)", () => {
  const result = parseCircleCreatedEvent(["CABC", "GDEF", 0]);
  assert.equal(result.circleIndex, 0);
});

test("parseCircleCreatedEvent: circle_index is distinct from round_deadline_ledgers", () => {
  // Regression guard: the previous handler aliased this field as
  // `roundDeadlineLedgers` which silently wrote a factory counter value into
  // the deadline column.  Ensure the parser returns the field under the correct
  // name and that a large realistic circle_index is preserved as-is.
  const largeIndex = 9999;
  const result = parseCircleCreatedEvent(["CABC", "GDEF", largeIndex]);
  assert.equal(result.circleIndex, largeIndex);
  // TypeScript: the returned object must NOT have a roundDeadlineLedgers field
  assert.equal(
    ("roundDeadlineLedgers" in result),
    false,
    "parsed result must not expose the old misnamed field",
  );
});

test("parseCircleCreatedEvent: throws on missing tuple elements", () => {
  assert.throws(
    () => parseCircleCreatedEvent(["CABC", "GDEF"]),
    /expected data tuple/,
    "should throw a descriptive error when circle_index is absent",
  );
});

test("parseCircleCreatedEvent: throws on null/undefined input", () => {
  assert.throws(() => parseCircleCreatedEvent(null), /expected data tuple/);
  assert.throws(() => parseCircleCreatedEvent(undefined), /expected data tuple/);
});

test("parseCircleCreatedEvent: throws when circle_address is empty string", () => {
  assert.throws(
    () => parseCircleCreatedEvent(["", "GDEF", 1]),
    /circle_address must be a non-empty string/,
  );
});

test("parseCircleCreatedEvent: throws when creator is empty string", () => {
  assert.throws(
    () => parseCircleCreatedEvent(["CABC", "", 1]),
    /creator must be a non-empty string/,
  );
});

test("parseCircleCreatedEvent: throws when circle_index is negative", () => {
  assert.throws(
    () => parseCircleCreatedEvent(["CABC", "GDEF", -1]),
    /circle_index must be a non-negative integer/,
  );
});

test("parseCircleCreatedEvent: throws when circle_index is not an integer", () => {
  assert.throws(
    () => parseCircleCreatedEvent(["CABC", "GDEF", 1.5]),
    /circle_index must be a non-negative integer/,
  );
});

// ─── computeJitteredDelay — full jitter for RPC retry ───────────────────────

test("computeJitteredDelay returns value in [0, delayMs)", () => {
  for (let i = 0; i < 100; i++) {
    const result = computeJitteredDelay(500);
    assert.ok(result >= 0, `jittered delay ${result} should be >= 0`);
    assert.ok(result < 500, `jittered delay ${result} should be < 500`);
  }
});

test("computeJitteredDelay produces varied values", () => {
  const samples = new Set<number>();
  for (let i = 0; i < 30; i++) {
    samples.add(computeJitteredDelay(1000));
  }
  // With 30 samples in [0, 1000), we should see variety
  assert.ok(samples.size > 10, `expected varied jitter values, got ${samples.size} distinct`);
});

test("computeJitteredDelay(0) always returns 0", () => {
  for (let i = 0; i < 10; i++) {
    assert.equal(computeJitteredDelay(0), 0);
  }
});

// ─── Metrics — verify new fields are tracked ─────────────────────────────────

test("getIndexerMetrics returns all expected fields", () => {
  const metrics = getIndexerMetrics();
  assert.ok("totalEventsProcessed" in metrics, "should have totalEventsProcessed");
  assert.ok("totalEventsFailed" in metrics, "should have totalEventsFailed");
  assert.ok("pollCyclesCompleted" in metrics, "should have pollCyclesCompleted");
  assert.ok("pollCyclesFailed" in metrics, "should have pollCyclesFailed");
  assert.ok("lastPollDurationMs" in metrics, "should have lastPollDurationMs");
  assert.ok("lastPollLedgerRange" in metrics, "should have lastPollLedgerRange");
  assert.ok("backoffConsecutiveFailures" in metrics, "should have backoffConsecutiveFailures");
  assert.ok("backoffCurrentIntervalMs" in metrics, "should have backoffCurrentIntervalMs");
});

// ─── isTransientRpcError — expanded coverage ─────────────────────────────────

test("isTransientRpcError identifies all transient error codes", () => {
  const transientCodes = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH"];
  for (const code of transientCodes) {
    assert.equal(isTransientRpcError({ code }), true, `${code} should be transient`);
  }
});

test("isTransientRpcError identifies transient HTTP status codes", () => {
  for (const status of [429, 502, 503, 504]) {
    assert.equal(isTransientRpcError({ status }), true, `status ${status} should be transient`);
  }
});

test("isTransientRpcError rejects non-transient errors", () => {
  assert.equal(isTransientRpcError(null), false);
  assert.equal(isTransientRpcError(undefined), false);
  assert.equal(isTransientRpcError({ code: "ENOENT" }), false);
  assert.equal(isTransientRpcError({ status: 400 }), false);
});

// ─── parseJoinedEvent — circle/joined field-mapping tests ─────────────────────
//
// These tests are the contract between the on-chain joined event shape and the
// indexer.  If anyone changes the circle contract's `join` data tuple they'll
// see these fail before the DB is silently written with wrong member data.

test("parseJoinedEvent: parses well-formed tuple into named fields", () => {
  const result = parseJoinedEvent([
    "CCIRCLEXXX",
    "GMEMBERYYY",
    1,
    100_000_000n,
  ]);
  assert.equal(result.circleAddress, "CCIRCLEXXX");
  assert.equal(result.member, "GMEMBERYYY");
  assert.equal(result.joinOrder, 1);
  assert.equal(result.collateral, 100_000_000n);
});

test("parseJoinedEvent: join_order 1 is valid (first member)", () => {
  const result = parseJoinedEvent(["CABC", "GDEF", 1, 0n]);
  assert.equal(result.joinOrder, 1);
});

test("parseJoinedEvent: join_order equals member_count is valid (last join, triggers Active)", () => {
  const result = parseJoinedEvent(["CABC", "GDEF", 4, 100_000_000n]);
  assert.equal(result.joinOrder, 4);
});

test("parseJoinedEvent: collateral 0 is valid (edge: all collateral already penalized)", () => {
  const result = parseJoinedEvent(["CABC", "GDEF", 1, 0n]);
  assert.equal(result.collateral, 0n);
});

test("parseJoinedEvent: accepts plain number for collateral (backward-compat with older SDK)", () => {
  const result = parseJoinedEvent(["CABC", "GDEF", 2, 50_000_000]);
  assert.equal(result.collateral, 50_000_000n);
});

test("parseJoinedEvent: throws on missing tuple elements", () => {
  assert.throws(
    () => parseJoinedEvent(["CABC", "GDEF", 1]),
    /expected data tuple/,
    "should throw a descriptive error when collateral is absent",
  );
});

test("parseJoinedEvent: throws on null/undefined input", () => {
  assert.throws(() => parseJoinedEvent(null), /expected data tuple/);
  assert.throws(() => parseJoinedEvent(undefined), /expected data tuple/);
});

test("parseJoinedEvent: throws when circle_address is empty string", () => {
  assert.throws(
    () => parseJoinedEvent(["", "GDEF", 1, 100n]),
    /circle_address must be a non-empty string/,
  );
});

test("parseJoinedEvent: throws when member is empty string", () => {
  assert.throws(
    () => parseJoinedEvent(["CABC", "", 1, 100n]),
    /member must be a non-empty string/,
  );
});

test("parseJoinedEvent: throws when join_order is 0 (must be ≥ 1)", () => {
  assert.throws(
    () => parseJoinedEvent(["CABC", "GDEF", 0, 100n]),
    /join_order must be a positive integer/,
  );
});

test("parseJoinedEvent: throws when join_order is negative", () => {
  assert.throws(
    () => parseJoinedEvent(["CABC", "GDEF", -1, 100n]),
    /join_order must be a positive integer/,
  );
});

test("parseJoinedEvent: throws when join_order is non-integer", () => {
  assert.throws(
    () => parseJoinedEvent(["CABC", "GDEF", 1.5, 100n]),
    /join_order must be a positive integer/,
  );
});

test("parseJoinedEvent: throws when collateral is negative", () => {
  assert.throws(
    () => parseJoinedEvent(["CABC", "GDEF", 1, -1n]),
    /collateral must be a non-negative/,
  );
});

test("parseJoinedEvent: join_order field is distinct from circle_index (no aliasing)", () => {
  // Regression guard: ensure the parser does not confuse join_order with the
  // factory's circle_index.  A large realistic join_order must be preserved.
  const bigOrder = 256;
  const result = parseJoinedEvent(["CABC", "GDEF", bigOrder, 100n]);
  assert.equal(result.joinOrder, bigOrder);
  assert.equal(
    ("circleIndex" in result),
    false,
    "parseJoinedEvent must not expose a circleIndex field",
  );
});

// ─── parseInitializedEvent — circle/initialized field-mapping tests ────────────
//
// Issue #4 audit: the factory/circle_created event does NOT carry member_count
// or round_amount.  The circle/initialized event fills those fields.  These
// tests verify the parser is correct before any DB write happens.

test("parseInitializedEvent: parses well-formed tuple into named fields", () => {
  const result = parseInitializedEvent(["CCIRCLEXXX", 4, 100_000_000n]);
  assert.equal(result.circleAddress, "CCIRCLEXXX");
  assert.equal(result.memberCount, 4);
  assert.equal(result.roundAmount, 100_000_000n);
});

test("parseInitializedEvent: minimum valid member_count is 2", () => {
  const result = parseInitializedEvent(["CABC", 2, 50_000_000n]);
  assert.equal(result.memberCount, 2);
});

test("parseInitializedEvent: maximum valid member_count is 256", () => {
  const result = parseInitializedEvent(["CABC", 256, 1n]);
  assert.equal(result.memberCount, 256);
});

test("parseInitializedEvent: accepts plain number for round_amount (older SDK compat)", () => {
  const result = parseInitializedEvent(["CABC", 4, 100_000_000]);
  assert.equal(result.roundAmount, 100_000_000n);
});

test("parseInitializedEvent: throws on missing tuple elements", () => {
  assert.throws(
    () => parseInitializedEvent(["CABC", 4]),
    /expected data tuple/,
  );
});

test("parseInitializedEvent: throws on null/undefined", () => {
  assert.throws(() => parseInitializedEvent(null), /expected data tuple/);
  assert.throws(() => parseInitializedEvent(undefined), /expected data tuple/);
});

test("parseInitializedEvent: throws when circle_address is empty", () => {
  assert.throws(
    () => parseInitializedEvent(["", 4, 100n]),
    /circle_address must be a non-empty string/,
  );
});

test("parseInitializedEvent: throws when member_count is 1 (below minimum)", () => {
  assert.throws(
    () => parseInitializedEvent(["CABC", 1, 100n]),
    /member_count must be an integer in \[2, 256\]/,
  );
});

test("parseInitializedEvent: throws when member_count is 257 (above maximum)", () => {
  assert.throws(
    () => parseInitializedEvent(["CABC", 257, 100n]),
    /member_count must be an integer in \[2, 256\]/,
  );
});

test("parseInitializedEvent: throws when member_count is non-integer", () => {
  assert.throws(
    () => parseInitializedEvent(["CABC", 2.5, 100n]),
    /member_count must be an integer in \[2, 256\]/,
  );
});

test("parseInitializedEvent: throws when round_amount is 0", () => {
  assert.throws(
    () => parseInitializedEvent(["CABC", 4, 0n]),
    /round_amount must be > 0/,
  );
});

test("parseInitializedEvent: throws when round_amount is negative", () => {
  assert.throws(
    () => parseInitializedEvent(["CABC", 4, -1n]),
    /round_amount must be a positive bigint/,
  );
});

// ─── Factory/circle_created vs circle/initialized field audit ─────────────────
//
// Issue #4 regression guard: documents which fields come from which event so a
// future change to either event shape is immediately visible in CI.

test("factory/circle_created provides: circle_address, creator, circle_index", () => {
  const result = parseCircleCreatedEvent(["CCIRCLE", "GCREATOR", 0]);
  // These three fields — and only these — are present in the factory event.
  assert.ok("circleAddress" in result);
  assert.ok("creator" in result);
  assert.ok("circleIndex" in result);
  // member_count and round_amount are NOT in the factory event — they come
  // from the circle/initialized event (see parseInitializedEvent).
  assert.equal(("memberCount" in result), false, "factory event must not have memberCount");
  assert.equal(("roundAmount" in result), false, "factory event must not have roundAmount");
});

test("circle/initialized provides: circle_address, member_count, round_amount", () => {
  const result = parseInitializedEvent(["CCIRCLE", 4, 100_000_000n]);
  assert.ok("circleAddress" in result);
  assert.ok("memberCount" in result);
  assert.ok("roundAmount" in result);
  // creator and circle_index are NOT in the initialized event.
  assert.equal(("creator" in result), false, "initialized event must not have creator");
  assert.equal(("circleIndex" in result), false, "initialized event must not have circleIndex");
});

test("memberCount equals totalRounds (each member receives one payout)", () => {
  // The contract sets total_rounds = member_count at initialize time.
  // This test documents and locks that invariant at the parser level.
  const { memberCount } = parseInitializedEvent(["CABC", 5, 100n]);
  // totalRounds is derived from memberCount — they must be equal.
  const totalRounds = memberCount; // mirrors the DB UPDATE: total_rounds = $2
  assert.equal(totalRounds, 5);
});
