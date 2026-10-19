import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getMissingEnvVars,
  getMalformedContractAddresses,
  assertEnvVars,
  parsePositiveIntEnv,
  parseEventsLimit,
  parseStartLedger,
  parseDbConnectMaxRetries,
  parseDbConnectBaseDelayMs,
  parsePollIntervalMs,
  parseRpcRetryMaxAttempts,
  parseRpcRetryBaseDelayMs,
  parsePollBackoffInitialMs,
  parsePollBackoffMaxMs,
  parsePollBackoffMultiplier,
} from "./config";

const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

const VALID_ENV = {
  DATABASE_URL: "postgresql://postgres:password@localhost:5432/circleup",
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  CIRCLE_FACTORY_ADDRESS: VALID_CONTRACT,
  REPUTATION_ADDRESS: VALID_CONTRACT,
  USDC_ADDRESS: VALID_CONTRACT,
};

// ─── getMissingEnvVars ────────────────────────────────────────────────────────

test("getMissingEnvVars returns [] when every required var is set", () => {
  assert.deepEqual(getMissingEnvVars(VALID_ENV), []);
});

test("getMissingEnvVars reports unset required vars, including USDC_ADDRESS", () => {
  const { USDC_ADDRESS, ...rest } = VALID_ENV;
  assert.deepEqual(getMissingEnvVars(rest), ["USDC_ADDRESS"]);
});

test("getMissingEnvVars treats a blank string the same as unset", () => {
  const missing = getMissingEnvVars({ ...VALID_ENV, DATABASE_URL: "   " });
  assert.deepEqual(missing, ["DATABASE_URL"]);
});

test("getMissingEnvVars reports every missing var, not just the first", () => {
  const missing = getMissingEnvVars({});
  assert.deepEqual(missing, [
    "DATABASE_URL",
    "STELLAR_RPC_URL",
    "CIRCLE_FACTORY_ADDRESS",
    "REPUTATION_ADDRESS",
    "USDC_ADDRESS",
  ]);
});

// ─── getMalformedContractAddresses ────────────────────────────────────────────

test("getMalformedContractAddresses returns [] for valid Soroban contract IDs", () => {
  assert.deepEqual(getMalformedContractAddresses(VALID_ENV), []);
});

test("getMalformedContractAddresses flags a G-prefixed address (not a contract ID)", () => {
  const env = {
    ...VALID_ENV,
    CIRCLE_FACTORY_ADDRESS:
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  };
  const result = getMalformedContractAddresses(env);
  assert.equal(result.length, 1);
  assert.match(result[0], /CIRCLE_FACTORY_ADDRESS/);
  assert.match(result[0], /C-prefixed/);
});

test("getMalformedContractAddresses flags a truncated contract ID", () => {
  const env = { ...VALID_ENV, REPUTATION_ADDRESS: "CSHORT" };
  const result = getMalformedContractAddresses(env);
  assert.equal(result.length, 1);
  assert.match(result[0], /REPUTATION_ADDRESS/);
});

test("getMalformedContractAddresses flags multiple malformed addresses", () => {
  const env = {
    ...VALID_ENV,
    CIRCLE_FACTORY_ADDRESS: "not-a-contract",
    REPUTATION_ADDRESS: "also-wrong",
  };
  assert.equal(getMalformedContractAddresses(env).length, 2);
});

test("getMalformedContractAddresses does not flag empty values (presence checked separately)", () => {
  const env = { ...VALID_ENV, USDC_ADDRESS: "" };
  const result = getMalformedContractAddresses(env);
  assert.ok(result.every((e) => !e.includes("USDC_ADDRESS")));
});

// ─── assertEnvVars ────────────────────────────────────────────────────────────

test("assertEnvVars does not throw when config is complete and valid", () => {
  assert.doesNotThrow(() => assertEnvVars(VALID_ENV));
});

test("assertEnvVars throws a single error naming every missing var", () => {
  const { USDC_ADDRESS, REPUTATION_ADDRESS, ...rest } = VALID_ENV;
  assert.throws(
    () => assertEnvVars(rest),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /USDC_ADDRESS/);
      assert.match(err.message, /REPUTATION_ADDRESS/);
      return true;
    },
  );
});

test("assertEnvVars includes malformed contract address errors", () => {
  const env = { ...VALID_ENV, CIRCLE_FACTORY_ADDRESS: "not-valid" };
  assert.throws(
    () => assertEnvVars(env),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /CIRCLE_FACTORY_ADDRESS/);
      assert.match(err.message, /C-prefixed/);
      return true;
    },
  );
});

// ─── parsePositiveIntEnv ──────────────────────────────────────────────────────

test("parsePositiveIntEnv falls back when unset", () => {
  assert.equal(parsePositiveIntEnv("EVENTS_LIMIT", undefined, 100), 100);
  assert.equal(parsePositiveIntEnv("EVENTS_LIMIT", "", 100), 100);
});

test("parsePositiveIntEnv parses a valid override", () => {
  assert.equal(parsePositiveIntEnv("EVENTS_LIMIT", "250", 100), 250);
});

test("parsePositiveIntEnv rejects zero, negative, and non-integer values", () => {
  assert.throws(() => parsePositiveIntEnv("EVENTS_LIMIT", "0", 100), /positive integer/);
  assert.throws(() => parsePositiveIntEnv("EVENTS_LIMIT", "-5", 100), /positive integer/);
  assert.throws(() => parsePositiveIntEnv("EVENTS_LIMIT", "abc", 100), /positive integer/);
  assert.throws(() => parsePositiveIntEnv("EVENTS_LIMIT", "1.5", 100), /positive integer/);
});

// ─── parseEventsLimit ─────────────────────────────────────────────────────────

test("parseEventsLimit defaults to 100 and accepts a custom value", () => {
  assert.equal(parseEventsLimit(undefined), 100);
  assert.equal(parseEventsLimit("500"), 500);
});

test("parseEventsLimit rejects a value above the Soroban RPC cap of 10000", () => {
  assert.throws(() => parseEventsLimit("10001"), /at most 10000/);
});

// ─── parseStartLedger ─────────────────────────────────────────────────────────

test("parseStartLedger defaults to 0 and accepts a custom ledger", () => {
  assert.equal(parseStartLedger(undefined), 0);
  assert.equal(parseStartLedger("123456"), 123456);
});

test("parseStartLedger rejects negative and non-integer values", () => {
  assert.throws(() => parseStartLedger("-1"), /non-negative integer/);
  assert.throws(() => parseStartLedger("abc"), /non-negative integer/);
});

// ─── parseDbConnectMaxRetries ─────────────────────────────────────────────────

test("parseDbConnectMaxRetries defaults to 5 when unset", () => {
  assert.equal(parseDbConnectMaxRetries(undefined), 5);
  assert.equal(parseDbConnectMaxRetries(""), 5);
});

test("parseDbConnectMaxRetries accepts a valid custom retry count", () => {
  assert.equal(parseDbConnectMaxRetries("10"), 10);
  assert.equal(parseDbConnectMaxRetries("1"), 1);
  assert.equal(parseDbConnectMaxRetries("50"), 50);
});

test("parseDbConnectMaxRetries rejects zero, negative, and non-integer values", () => {
  assert.throws(() => parseDbConnectMaxRetries("0"), /positive integer/);
  assert.throws(() => parseDbConnectMaxRetries("-1"), /positive integer/);
  assert.throws(() => parseDbConnectMaxRetries("2.5"), /positive integer/);
  assert.throws(() => parseDbConnectMaxRetries("abc"), /positive integer/);
});

test("parseDbConnectMaxRetries rejects a value above the upper bound of 50", () => {
  assert.throws(() => parseDbConnectMaxRetries("51"), /at most 50/);
  assert.throws(() => parseDbConnectMaxRetries("100"), /at most 50/);
});

// ─── parseDbConnectBaseDelayMs ────────────────────────────────────────────────

test("parseDbConnectBaseDelayMs defaults to 1000 when unset", () => {
  assert.equal(parseDbConnectBaseDelayMs(undefined), 1_000);
  assert.equal(parseDbConnectBaseDelayMs(""), 1_000);
});

test("parseDbConnectBaseDelayMs accepts a valid custom delay", () => {
  assert.equal(parseDbConnectBaseDelayMs("500"), 500);
  assert.equal(parseDbConnectBaseDelayMs("2000"), 2_000);
  assert.equal(parseDbConnectBaseDelayMs("60000"), 60_000);
});

test("parseDbConnectBaseDelayMs rejects zero, negative, and non-integer values", () => {
  assert.throws(() => parseDbConnectBaseDelayMs("0"), /positive integer/);
  assert.throws(() => parseDbConnectBaseDelayMs("-100"), /positive integer/);
  assert.throws(() => parseDbConnectBaseDelayMs("1.5"), /positive integer/);
  assert.throws(() => parseDbConnectBaseDelayMs("bad"), /positive integer/);
});

test("parseDbConnectBaseDelayMs rejects a value above the upper bound of 60000", () => {
  assert.throws(() => parseDbConnectBaseDelayMs("60001"), /at most 60000/);
  assert.throws(() => parseDbConnectBaseDelayMs("120000"), /at most 60000/);
});

// ─── parsePollIntervalMs ──────────────────────────────────────────────────────

test("parsePollIntervalMs defaults to 5000 when unset", () => {
  assert.equal(parsePollIntervalMs(undefined), 5_000);
  assert.equal(parsePollIntervalMs(""), 5_000);
});

test("parsePollIntervalMs accepts values at and above the 500ms minimum", () => {
  assert.equal(parsePollIntervalMs("500"), 500);
  assert.equal(parsePollIntervalMs("1000"), 1_000);
  assert.equal(parsePollIntervalMs("30000"), 30_000);
});

test("parsePollIntervalMs rejects values below 500ms", () => {
  assert.throws(() => parsePollIntervalMs("1"), /at least 500/);
  assert.throws(() => parsePollIntervalMs("499"), /at least 500/);
});

test("parsePollIntervalMs rejects zero, negative, and non-integer values", () => {
  assert.throws(() => parsePollIntervalMs("0"), /positive integer/);
  assert.throws(() => parsePollIntervalMs("-1"), /positive integer/);
  assert.throws(() => parsePollIntervalMs("abc"), /positive integer/);
  assert.throws(() => parsePollIntervalMs("1.5"), /positive integer/);
});

// ─── parseRpcRetryMaxAttempts ─────────────────────────────────────────────────

test("parseRpcRetryMaxAttempts defaults to 4 when unset", () => {
  assert.equal(parseRpcRetryMaxAttempts(undefined), 4);
  assert.equal(parseRpcRetryMaxAttempts(""), 4);
});

test("parseRpcRetryMaxAttempts accepts valid values including the boundary of 20", () => {
  assert.equal(parseRpcRetryMaxAttempts("1"), 1);
  assert.equal(parseRpcRetryMaxAttempts("10"), 10);
  assert.equal(parseRpcRetryMaxAttempts("20"), 20);
});

test("parseRpcRetryMaxAttempts rejects values above the upper bound of 20", () => {
  assert.throws(() => parseRpcRetryMaxAttempts("21"), /at most 20/);
  assert.throws(() => parseRpcRetryMaxAttempts("100"), /at most 20/);
});

test("parseRpcRetryMaxAttempts rejects zero, negative, and non-integer values", () => {
  assert.throws(() => parseRpcRetryMaxAttempts("0"), /positive integer/);
  assert.throws(() => parseRpcRetryMaxAttempts("-3"), /positive integer/);
  assert.throws(() => parseRpcRetryMaxAttempts("2.5"), /positive integer/);
  assert.throws(() => parseRpcRetryMaxAttempts("bad"), /positive integer/);
});

// ─── parseRpcRetryBaseDelayMs ─────────────────────────────────────────────────

test("parseRpcRetryBaseDelayMs defaults to 500 when unset", () => {
  assert.equal(parseRpcRetryBaseDelayMs(undefined), 500);
  assert.equal(parseRpcRetryBaseDelayMs(""), 500);
});

test("parseRpcRetryBaseDelayMs accepts valid values including the boundary of 30000", () => {
  assert.equal(parseRpcRetryBaseDelayMs("100"), 100);
  assert.equal(parseRpcRetryBaseDelayMs("1000"), 1_000);
  assert.equal(parseRpcRetryBaseDelayMs("30000"), 30_000);
});

test("parseRpcRetryBaseDelayMs rejects values above the upper bound of 30000", () => {
  assert.throws(() => parseRpcRetryBaseDelayMs("30001"), /at most 30000/);
  assert.throws(() => parseRpcRetryBaseDelayMs("60000"), /at most 30000/);
});

test("parseRpcRetryBaseDelayMs rejects zero, negative, and non-integer values", () => {
  assert.throws(() => parseRpcRetryBaseDelayMs("0"), /positive integer/);
  assert.throws(() => parseRpcRetryBaseDelayMs("-500"), /positive integer/);
  assert.throws(() => parseRpcRetryBaseDelayMs("1.5"), /positive integer/);
  assert.throws(() => parseRpcRetryBaseDelayMs("abc"), /positive integer/);
});

// ─── parsePollBackoffInitialMs ────────────────────────────────────────────────

test("parsePollBackoffInitialMs defaults to 1000 when unset", () => {
  assert.equal(parsePollBackoffInitialMs(undefined), 1_000);
  assert.equal(parsePollBackoffInitialMs(""), 1_000);
});

test("parsePollBackoffInitialMs accepts values within the valid range [100, 60000]", () => {
  assert.equal(parsePollBackoffInitialMs("100"), 100);
  assert.equal(parsePollBackoffInitialMs("5000"), 5_000);
  assert.equal(parsePollBackoffInitialMs("60000"), 60_000);
});

test("parsePollBackoffInitialMs rejects values below the minimum of 100ms", () => {
  assert.throws(() => parsePollBackoffInitialMs("99"), /at least 100/);
  assert.throws(() => parsePollBackoffInitialMs("1"), /at least 100/);
});

test("parsePollBackoffInitialMs rejects values above the maximum of 60000ms", () => {
  assert.throws(() => parsePollBackoffInitialMs("60001"), /at most 60000/);
  assert.throws(() => parsePollBackoffInitialMs("120000"), /at most 60000/);
});

test("parsePollBackoffInitialMs rejects zero, negative, and non-integer values", () => {
  assert.throws(() => parsePollBackoffInitialMs("0"), /positive integer/);
  assert.throws(() => parsePollBackoffInitialMs("-1"), /positive integer/);
  assert.throws(() => parsePollBackoffInitialMs("abc"), /positive integer/);
});

// ─── parsePollBackoffMaxMs ────────────────────────────────────────────────────

test("parsePollBackoffMaxMs defaults to 60000 when unset", () => {
  assert.equal(parsePollBackoffMaxMs(undefined), 60_000);
  assert.equal(parsePollBackoffMaxMs(""), 60_000);
});

test("parsePollBackoffMaxMs accepts values up to and including the boundary of 300000", () => {
  assert.equal(parsePollBackoffMaxMs("1000"), 1_000);
  assert.equal(parsePollBackoffMaxMs("60000"), 60_000);
  assert.equal(parsePollBackoffMaxMs("300000"), 300_000);
});

test("parsePollBackoffMaxMs rejects values above the upper bound of 300000", () => {
  assert.throws(() => parsePollBackoffMaxMs("300001"), /at most 300000/);
  assert.throws(() => parsePollBackoffMaxMs("600000"), /at most 300000/);
});

test("parsePollBackoffMaxMs rejects zero, negative, and non-integer values", () => {
  assert.throws(() => parsePollBackoffMaxMs("0"), /positive integer/);
  assert.throws(() => parsePollBackoffMaxMs("-1"), /positive integer/);
  assert.throws(() => parsePollBackoffMaxMs("abc"), /positive integer/);
});

// ─── parsePollBackoffMultiplier ───────────────────────────────────────────────

test("parsePollBackoffMultiplier defaults to 2.0 when unset", () => {
  assert.equal(parsePollBackoffMultiplier(undefined), 2.0);
  assert.equal(parsePollBackoffMultiplier(""), 2.0);
});

test("parsePollBackoffMultiplier accepts valid multipliers greater than 1", () => {
  assert.equal(parsePollBackoffMultiplier("1.1"), 1.1);
  assert.equal(parsePollBackoffMultiplier("2.0"), 2.0);
  assert.equal(parsePollBackoffMultiplier("3.5"), 3.5);
  assert.equal(parsePollBackoffMultiplier("10"), 10);
});

test("parsePollBackoffMultiplier rejects values of exactly 1 (no growth)", () => {
  assert.throws(() => parsePollBackoffMultiplier("1"), /greater than 1/);
  assert.throws(() => parsePollBackoffMultiplier("1.0"), /greater than 1/);
});

test("parsePollBackoffMultiplier rejects values less than or equal to 1", () => {
  assert.throws(() => parsePollBackoffMultiplier("0.5"), /greater than 1/);
  assert.throws(() => parsePollBackoffMultiplier("0"), /greater than 1/);
  assert.throws(() => parsePollBackoffMultiplier("-2"), /greater than 1/);
});

test("parsePollBackoffMultiplier rejects non-numeric and non-finite values", () => {
  assert.throws(() => parsePollBackoffMultiplier("abc"), /greater than 1/);
  assert.throws(() => parsePollBackoffMultiplier("Infinity"), /greater than 1/);
  assert.throws(() => parsePollBackoffMultiplier("NaN"), /greater than 1/);
});
