/**
 * Issue #662: read-only verification of configured contract identities.
 *
 * `verifyDeployment` must report — without throwing — whether the configured
 * network and contract addresses are the expected CircleUp deployment, and
 * construction must stay offline. No real RPC calls are made: `getNetwork`
 * and `simulateAndRead` are stubbed on the client instance.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { CircleUpClient, type DeploymentCheck } from "../client";
import type { SimulateResult } from "../types";
import {
  FACTORY_ADDR,
  OTHER_CIRCLE_ADDR,
  REPUTATION_ADDR,
  SDK_CONFIG,
  USDC_ADDR,
  CREATOR_ADDR,
} from "./fixtures";

const WASM_HASH = new Uint8Array(32).fill(0xab);
const WASM_HASH_HEX = "ab".repeat(32);

/** View-method answers of a correct deployment, keyed by `contract.method`. */
function correctDeployment(): Record<string, SimulateResult> {
  return {
    [`${FACTORY_ADDR}.get_usdc_token`]: { ok: true, value: USDC_ADDR },
    [`${FACTORY_ADDR}.get_reputation_contract`]: { ok: true, value: REPUTATION_ADDR },
    [`${FACTORY_ADDR}.get_circle_wasm_hash`]: { ok: true, value: WASM_HASH },
    [`${REPUTATION_ADDR}.get_admin`]: { ok: true, value: CREATOR_ADDR },
    [`${USDC_ADDR}.decimals`]: { ok: true, value: 7 },
  };
}

function makeClient(
  answers: Record<string, SimulateResult | Promise<SimulateResult>>,
  passphrase: string | (() => Promise<never>) = SDK_CONFIG.networkPassphrase,
) {
  const client = new CircleUpClient(SDK_CONFIG);
  const getNetwork = vi.fn(() =>
    typeof passphrase === "string"
      ? Promise.resolve({ passphrase, protocolVersion: 21 })
      : passphrase(),
  );
  (client as any).rpc.getNetwork = getNetwork;
  const simulate = vi
    .spyOn(client as any, "simulateAndRead")
    .mockImplementation(async (...args: unknown[]) => {
      const [contractId, method] = args as [string, string];
      const answer = answers[`${contractId}.${method}`];
      return answer ?? { ok: false, error: "unexpected call" };
    });
  return { client, getNetwork, simulate };
}

function check(checks: DeploymentCheck[], name: DeploymentCheck["name"]): DeploymentCheck {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`no ${name} check`);
  return found;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CircleUpClient.verifyDeployment", () => {
  it("does not touch the network at construction", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    new CircleUpClient(SDK_CONFIG);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports ok for a correct deployment", async () => {
    const { client, simulate } = makeClient(correctDeployment());

    const result = await client.verifyDeployment({ expectedCircleWasmHash: WASM_HASH_HEX });

    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      "network",
      "factory.usdc",
      "factory.reputation",
      "factory.circleWasmHash",
      "reputation",
      "usdc",
    ]);
    expect(result.checks.every((c) => c.status === "ok")).toBe(true);
    expect(check(result.checks, "factory.circleWasmHash").actual).toBe(WASM_HASH_HEX);
    // Read-only: only simulations, never a write path.
    expect(simulate).toHaveBeenCalledTimes(5);
  });

  it("reports the wasm hash without comparing when none is expected", async () => {
    const { client } = makeClient(correctDeployment());

    const result = await client.verifyDeployment();

    const hash = check(result.checks, "factory.circleWasmHash");
    expect(hash.status).toBe("ok");
    expect(hash.expected).toBeUndefined();
    expect(hash.actual).toBe(WASM_HASH_HEX);
  });

  it("reports a wrong network and skips contract reads", async () => {
    const { client, simulate } = makeClient(
      correctDeployment(),
      "Public Global Stellar Network ; September 2015",
    );

    const result = await client.verifyDeployment();

    expect(result.ok).toBe(false);
    const network = check(result.checks, "network");
    expect(network.status).toBe("mismatch");
    expect(network.expected).toBe(SDK_CONFIG.networkPassphrase);
    expect(network.actual).toBe("Public Global Stellar Network ; September 2015");
    expect(result.checks.slice(1).every((c) => c.status === "skipped")).toBe(true);
    expect(simulate).not.toHaveBeenCalled();
  });

  it("reports an unreachable RPC", async () => {
    const { client } = makeClient(correctDeployment(), () => Promise.reject(new Error("ECONNREFUSED")));

    const result = await client.verifyDeployment();

    expect(result.ok).toBe(false);
    expect(check(result.checks, "network").status).toBe("unreachable");
  });

  it("bounds a stalled RPC by the timeout", async () => {
    const { client } = makeClient(correctDeployment(), () => new Promise<never>(() => {}));

    const result = await client.verifyDeployment({ timeoutMs: 20 });

    const network = check(result.checks, "network");
    expect(network.status).toBe("unreachable");
    expect(network.detail).toContain("20 ms");
  });

  it("bounds a stalled contract read by the timeout", async () => {
    const answers: Record<string, SimulateResult | Promise<SimulateResult>> = correctDeployment();
    answers[`${USDC_ADDR}.decimals`] = new Promise<SimulateResult>(() => {});
    const { client } = makeClient(answers);

    const result = await client.verifyDeployment({ timeoutMs: 20 });

    expect(result.ok).toBe(false);
    expect(check(result.checks, "usdc").status).toBe("unreachable");
  });

  it("reports a missing factory contract", async () => {
    const missing: SimulateResult = {
      ok: false,
      error:
        "A required storage entry was not found. " +
        "The circle contract may not be deployed at this address, or the state has not been initialised.",
    };
    const answers = correctDeployment();
    answers[`${FACTORY_ADDR}.get_usdc_token`] = missing;
    answers[`${FACTORY_ADDR}.get_reputation_contract`] = missing;
    answers[`${FACTORY_ADDR}.get_circle_wasm_hash`] = missing;
    const { client } = makeClient(answers);

    const result = await client.verifyDeployment();

    expect(result.ok).toBe(false);
    expect(check(result.checks, "factory.usdc").status).toBe("missing");
    expect(check(result.checks, "factory.reputation").status).toBe("missing");
    expect(check(result.checks, "factory.circleWasmHash").status).toBe("missing");
    expect(check(result.checks, "reputation").status).toBe("ok");
  });

  it("reports a factory linked to a different reputation contract", async () => {
    const answers = correctDeployment();
    answers[`${FACTORY_ADDR}.get_reputation_contract`] = { ok: true, value: OTHER_CIRCLE_ADDR };
    const { client } = makeClient(answers);

    const result = await client.verifyDeployment();

    const rep = check(result.checks, "factory.reputation");
    expect(result.ok).toBe(false);
    expect(rep.status).toBe("mismatch");
    expect(rep.expected).toBe(REPUTATION_ADDR);
    expect(rep.actual).toBe(OTHER_CIRCLE_ADDR);
  });

  it("reports a mismatched wasm hash", async () => {
    const { client } = makeClient(correctDeployment());

    const result = await client.verifyDeployment({ expectedCircleWasmHash: "cd".repeat(32) });

    expect(check(result.checks, "factory.circleWasmHash").status).toBe("mismatch");
    expect(result.ok).toBe(false);
  });

  it("reports an incompatible response type", async () => {
    const answers = correctDeployment();
    answers[`${FACTORY_ADDR}.get_usdc_token`] = { ok: true, value: 42 };
    answers[`${FACTORY_ADDR}.get_circle_wasm_hash`] = { ok: true, value: "not-bytes" };
    const { client } = makeClient(answers);

    const result = await client.verifyDeployment();

    expect(check(result.checks, "factory.usdc").status).toBe("incompatible");
    expect(check(result.checks, "factory.circleWasmHash").status).toBe("incompatible");
    expect(result.ok).toBe(false);
  });

  it("reports a contract that does not expose the view method as incompatible", async () => {
    const answers = correctDeployment();
    answers[`${USDC_ADDR}.decimals`] = { ok: false, error: "Contract error code 3. Check that the operation is valid for the current circle state." };
    const { client } = makeClient(answers);

    const result = await client.verifyDeployment();

    expect(check(result.checks, "usdc").status).toBe("incompatible");
    expect(result.ok).toBe(false);
  });

  it("reports a token with the wrong decimals", async () => {
    const answers = correctDeployment();
    answers[`${USDC_ADDR}.decimals`] = { ok: true, value: 18 };
    const { client } = makeClient(answers);

    const result = await client.verifyDeployment();

    const usdc = check(result.checks, "usdc");
    expect(usdc.status).toBe("mismatch");
    expect(usdc.actual).toBe("18");
  });

  it("reports an RPC network failure during a read as unreachable", async () => {
    const answers = correctDeployment();
    answers[`${REPUTATION_ADDR}.get_admin`] = {
      ok: false,
      error: "Simulation network error: Could not connect to the RPC",
    };
    const { client } = makeClient(answers);

    const result = await client.verifyDeployment();

    expect(check(result.checks, "reputation").status).toBe("unreachable");
  });

  it("rejects a non-positive timeout", async () => {
    const { client } = makeClient(correctDeployment());
    await expect(client.verifyDeployment({ timeoutMs: 0 })).rejects.toThrow("timeoutMs");
  });
});
