/**
 * Unit tests for dbGuard.ts.
 *
 * All tests run offline — no Postgres connection required.
 * The guard is pure: it parses the URL and checks host/database name only.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseDbIdentity, isLocalDatabase, assertLocalDatabase } from "./dbGuard";

// ─── parseDbIdentity ─────────────────────────────────────────────────────────

describe("parseDbIdentity", () => {
  test("parses a standard postgres:// URL", () => {
    const id = parseDbIdentity("postgres://postgres:password@localhost:5432/circleup");
    assert.ok(id !== null);
    assert.equal(id.host, "localhost");
    assert.equal(id.database, "circleup");
  });

  test("parses a postgresql:// URL", () => {
    const id = parseDbIdentity("postgresql://user:pass@127.0.0.1:5432/mydb_test");
    assert.ok(id !== null);
    assert.equal(id.host, "127.0.0.1");
    assert.equal(id.database, "mydb_test");
  });

  test("redacts the password from the URL", () => {
    const id = parseDbIdentity("postgres://admin:s3cr3t@localhost/mydb");
    assert.ok(id !== null);
    assert.doesNotMatch(id.redactedUrl, /s3cr3t/);
  });

  test("parses a remote RDS endpoint", () => {
    const id = parseDbIdentity(
      "postgres://user:pass@prod-db.cluster-xyz.us-east-1.rds.amazonaws.com:5432/circleup",
    );
    assert.ok(id !== null);
    assert.equal(id.host, "prod-db.cluster-xyz.us-east-1.rds.amazonaws.com");
    assert.equal(id.database, "circleup");
  });

  test("parses a DSN with dbname= key", () => {
    const id = parseDbIdentity("host=localhost dbname=circleup_test user=postgres");
    assert.ok(id !== null);
    assert.equal(id.host, "localhost");
    assert.equal(id.database, "circleup_test");
  });

  test("returns null for an empty string", () => {
    assert.equal(parseDbIdentity(""), null);
  });

  test("returns null for a whitespace-only string", () => {
    assert.equal(parseDbIdentity("   "), null);
  });

  test("returns null for an unrecognised format", () => {
    assert.equal(parseDbIdentity("not-a-url-or-dsn"), null);
  });

  test("parses URL with no explicit port", () => {
    const id = parseDbIdentity("postgres://user@localhost/circleup");
    assert.ok(id !== null);
    assert.equal(id.host, "localhost");
    assert.equal(id.database, "circleup");
  });
});

// ─── isLocalDatabase ─────────────────────────────────────────────────────────

describe("isLocalDatabase", () => {
  function make(host: string, database: string) {
    return { host, database, redactedUrl: `postgres://${host}/${database}` };
  }

  test("localhost is safe", () => {
    assert.ok(isLocalDatabase(make("localhost", "circleup")));
  });

  test("127.0.0.1 is safe", () => {
    assert.ok(isLocalDatabase(make("127.0.0.1", "circleup")));
  });

  test("::1 is safe", () => {
    assert.ok(isLocalDatabase(make("::1", "circleup")));
  });

  test("[::1] is safe", () => {
    assert.ok(isLocalDatabase(make("[::1]", "circleup")));
  });

  test("database name ending with _test is safe on any host", () => {
    assert.ok(isLocalDatabase(make("prod.rds.amazonaws.com", "circleup_test")));
  });

  test("database name ending with _dev is safe on any host", () => {
    assert.ok(isLocalDatabase(make("staging.example.com", "myapp_dev")));
  });

  test("remote host with production database name is not safe", () => {
    assert.ok(!isLocalDatabase(make("prod.rds.amazonaws.com", "circleup")));
  });

  test("remote host with staging database name is not safe", () => {
    assert.ok(!isLocalDatabase(make("staging.example.com", "circleup_staging")));
  });

  test("database name ending with _testing is not a match (must end exactly with _test)", () => {
    // _testing does not end with _test — the suffix must match exactly
    assert.ok(!isLocalDatabase(make("remote.example.com", "app_testing")));
  });
});

// ─── assertLocalDatabase ─────────────────────────────────────────────────────

describe("assertLocalDatabase", () => {
  test("does not throw for localhost URL", () => {
    assert.doesNotThrow(() =>
      assertLocalDatabase("postgres://postgres:password@localhost:5432/circleup", "test op"),
    );
  });

  test("does not throw for 127.0.0.1 URL", () => {
    assert.doesNotThrow(() =>
      assertLocalDatabase("postgres://postgres:password@127.0.0.1:5432/circleup", "test op"),
    );
  });

  test("does not throw for _test database on a remote host", () => {
    assert.doesNotThrow(() =>
      assertLocalDatabase(
        "postgres://user:pass@ci-host.internal:5432/circleup_test",
        "test op",
      ),
    );
  });

  test("throws for a remote RDS URL with production database", () => {
    assert.throws(
      () =>
        assertLocalDatabase(
          "postgres://admin:secret@prod.cluster.rds.amazonaws.com:5432/circleup",
          "replay",
        ),
      /non-local database/,
    );
  });

  test("throws and names the operation in the error message", () => {
    assert.throws(
      () =>
        assertLocalDatabase(
          "postgres://user:pass@remote.host:5432/mydb",
          "full replay",
        ),
      /full replay/,
    );
  });

  test("throws when DATABASE_URL is undefined", () => {
    assert.throws(() => assertLocalDatabase(undefined, "replay"), /DATABASE_URL is not set/);
  });

  test("throws when DATABASE_URL is empty", () => {
    assert.throws(() => assertLocalDatabase("", "replay"), /DATABASE_URL is not set/);
  });

  test("throws when DATABASE_URL is unparseable", () => {
    assert.throws(() => assertLocalDatabase("not-a-url", "replay"), /could not be parsed/);
  });

  test("error message never contains the plaintext password", () => {
    let caught: Error | null = null;
    try {
      assertLocalDatabase(
        "postgres://admin:topsecret123@remote.host:5432/mydb",
        "replay",
      );
    } catch (err) {
      caught = err as Error;
    }
    assert.ok(caught !== null, "expected error to be thrown");
    assert.doesNotMatch(caught.message, /topsecret123/);
  });
});
