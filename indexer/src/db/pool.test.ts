import { test } from "node:test";
import assert from "node:assert/strict";
import { connectWithRetry, queryOne, queryExact } from "./pool";

function fakePool(failuresBeforeSuccess: number) {
  let calls = 0;
  return {
    calls: () => calls,
    connect: async () => {
      calls++;
      if (calls <= failuresBeforeSuccess) {
        throw new Error(`ECONNREFUSED (attempt ${calls})`);
      }
      return { release: () => {} } as any;
    },
  };
}

test("connectWithRetry succeeds immediately when Postgres is already up", async () => {
  const pool = fakePool(0);
  await connectWithRetry({ pool, maxRetries: 3, baseDelayMs: 1 });
  assert.equal(pool.calls(), 1);
});

test("connectWithRetry retries transient failures and eventually succeeds", async () => {
  const pool = fakePool(2);
  await connectWithRetry({ pool, maxRetries: 5, baseDelayMs: 1 });
  assert.equal(pool.calls(), 3);
});

test("connectWithRetry gives up after maxRetries and throws a clear error", async () => {
  const pool = fakePool(Infinity);
  await assert.rejects(
    () => connectWithRetry({ pool, maxRetries: 3, baseDelayMs: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Could not connect to Postgres after 3 attempt/);
      assert.match(err.message, /ECONNREFUSED/);
      return true;
    },
  );
  assert.equal(pool.calls(), 3);
});

test("connectWithRetry surfaces a useful message for a refused-connection AggregateError", async () => {
  // pg's connection failure for an unreachable host is an AggregateError
  // whose own `.message` is "" — the real text lives in `.errors[]`. A naive
  // `err.message` would silently produce an empty, useless failure message.
  const pool = {
    connect: async () => {
      // Shaped like Node's real AggregateError for a refused connection:
      // `.message` is "" and the real text is nested in `.errors[]`.
      throw {
        name: "AggregateError",
        message: "",
        code: "ECONNREFUSED",
        errors: [Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" })],
      };
    },
  };
  await assert.rejects(
    () => connectWithRetry({ pool, maxRetries: 1, baseDelayMs: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /ECONNREFUSED 127\.0\.0\.1:5432/);
      return true;
    },
  );
});

// ── queryOne ──────────────────────────────────────────────────────────────────
//
// queryOne and queryExact call query() which calls pool.connect() internally.
// We stub pool.connect() to return a fake client that replays canned rows,
// so these unit tests run without a real Postgres instance.

import * as poolModule from "./pool";

function stubPoolConnect(rows: unknown[]) {
  const original = (poolModule.pool as any).connect;
  (poolModule.pool as any).connect = async () => ({
    query: async () => ({ rows }),
    release: () => {},
  });
  return () => { (poolModule.pool as any).connect = original; };
}

test("queryOne returns the first row when query returns results", async () => {
  const restore = stubPoolConnect([{ id: 1 }, { id: 2 }]);
  try {
    const row = await queryOne<{ id: number }>("SELECT 1");
    assert.deepEqual(row, { id: 1 });
  } finally {
    restore();
  }
});

test("queryOne returns null when query returns an empty array", async () => {
  const restore = stubPoolConnect([]);
  try {
    const row = await queryOne<{ id: number }>("SELECT 1");
    assert.equal(row, null);
  } finally {
    restore();
  }
});

// ── queryExact ────────────────────────────────────────────────────────────────

test("queryExact returns the first row when query returns results", async () => {
  const restore = stubPoolConnect([{ id: 42 }]);
  try {
    const row = await queryExact<{ id: number }>("SELECT 1");
    assert.deepEqual(row, { id: 42 });
  } finally {
    restore();
  }
});

test("queryExact throws with default message when query returns no rows", async () => {
  const restore = stubPoolConnect([]);
  try {
    await assert.rejects(
      () => queryExact<{ id: number }>("SELECT 1"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Expected exactly one row but got none/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("queryExact throws with custom message when provided", async () => {
  const restore = stubPoolConnect([]);
  try {
    await assert.rejects(
      () => queryExact<{ id: number }>("SELECT 1", [], "Circle not found"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Circle not found/);
        return true;
      },
    );
  } finally {
    restore();
  }
});
