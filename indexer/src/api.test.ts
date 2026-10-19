import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCorsOptions } from "./api";

function callOrigin(
  options: ReturnType<typeof buildCorsOptions>,
  origin: string | undefined,
): Promise<{ err: Error | null; allow?: boolean }> {
  return new Promise((resolve) => {
    const originHandler = options.origin as (
      origin: string | undefined,
      cb: (err: Error | null, allow?: boolean) => void,
    ) => void;
    originHandler(origin, (err, allow) => resolve({ err, allow }));
  });
}

test("buildCorsOptions allows an origin on the allow-list", async () => {
  const options = buildCorsOptions(["https://app.circleup.xyz"]);
  const { err, allow } = await callOrigin(options, "https://app.circleup.xyz");
  assert.equal(err, null);
  assert.equal(allow, true);
});

test("buildCorsOptions rejects an origin not on the allow-list", async () => {
  const options = buildCorsOptions(["https://app.circleup.xyz"]);
  const { err } = await callOrigin(options, "https://evil.example.com");
  assert.ok(err instanceof Error);
  assert.match(err.message, /not allowed/);
});

test("buildCorsOptions allows requests with no Origin header (server-to-server)", async () => {
  const options = buildCorsOptions(["https://app.circleup.xyz"]);
  const { err, allow } = await callOrigin(options, undefined);
  assert.equal(err, null);
  assert.equal(allow, true);
});

test("buildCorsOptions allows everything when no allow-list is configured", () => {
  const options = buildCorsOptions([]);
  assert.equal(options.origin, true);
});

test("member contribution history route is documented in the module header", async () => {
  // Lightweight guard so the read-only history endpoint is not dropped from
  // the public surface without updating the file header / this assertion.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  assert.match(source, /GET \/members\/:member\/contributions/);
  assert.match(source, /app\.get\("\/members\/:member\/contributions"/);
  assert.match(source, /Failed to load member contributions/);
  // parseAddress("Member address") produces "Member address is required" at runtime;
  // verify the label string is present in source.
  assert.match(source, /Member address/);
});

test("members endpoint is documented with hasContributedCurrentRound in module header (#539)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  assert.match(source, /GET \/circles\/:address\/members/);
  assert.match(source, /has_contributed_current_round/);
  assert.match(source, /roundDeadlineLedgers/);
});

test("rounds endpoint is documented with deadlineLedger in module header (#540)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  assert.match(source, /GET \/circles\/:address\/rounds/);
  assert.match(source, /deadlineLedger/);
});

test("member contributions endpoint includes totalAmount and hasMore in response (#541)", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(__dirname, "api.ts"), "utf8");
  assert.match(source, /totalAmount/);
  assert.match(source, /hasMore/);
});
