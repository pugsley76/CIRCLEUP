/**
 * Tests for app/src/lib/walletCapabilities.ts
 *
 * Uses node:test + node:assert. Every case injects a fake provider object so
 * no browser, DOM, or real Freighter extension is required.
 *
 * Coverage:
 *   - detectWalletCapabilities: SSR safety, provider absent, full/partial providers
 *   - getInjectedProvider: preference order (freighter over freighterApi)
 *   - explainUnsupportedAction: no wallet, supported/unsupported capabilities
 *   - getProviderNetwork: getNetworkDetails path, getNetwork path, fallback, errors
 *   - checkNetworkMismatch: match, mismatch, unknown, unsupported, provider_error
 *   - describeNetworkMismatch: all five result kinds
 */
import { test, describe } from "vitest";
import assert from "node:assert/strict";
import {
  detectWalletCapabilities,
  explainUnsupportedAction,
  getInjectedProvider,
  getProviderNetwork,
  checkNetworkMismatch,
  describeNetworkMismatch,
} from "./walletCapabilities";

const fn = () => {};

/** A provider exposing every capability. */
const fullProvider = {
  isConnected: fn,
  requestAccess: fn,
  getPublicKey: fn,
  getAddress: fn,
  signTransaction: fn,
  getNetwork: fn,
  getNetworkDetails: fn,
  addEventListener: fn,
  watchWalletChanges: fn,
};

const TEST_PASSPHRASE = "Test SDF Network ; September 2015";
const MAIN_PASSPHRASE = "Public Global Stellar Network ; September 2015";

// ─────────────────────────────────────────────────────────────────────────────
// detectWalletCapabilities
// ─────────────────────────────────────────────────────────────────────────────

describe("detectWalletCapabilities — environment safety", () => {
  test("SSR (window undefined) returns all-unsupported and never throws", () => {
    const caps = detectWalletCapabilities(undefined);
    assert.deepEqual(caps, {
      installed: false,
      canConnect: false,
      canSignTransaction: false,
      canGetNetwork: false,
      canWatchChanges: false,
    });
  });

  test("window present but no provider injected → not installed", () => {
    const caps = detectWalletCapabilities({});
    assert.equal(caps.installed, false);
    assert.equal(caps.canSignTransaction, false);
  });

  test("provider that is not an object is ignored", () => {
    const caps = detectWalletCapabilities({ freighter: "nope" as unknown });
    assert.equal(caps.installed, false);
  });
});

describe("detectWalletCapabilities — capability states", () => {
  test("full provider reports every capability", () => {
    const caps = detectWalletCapabilities({ freighter: fullProvider });
    assert.deepEqual(caps, {
      installed: true,
      canConnect: true,
      canSignTransaction: true,
      canGetNetwork: true,
      canWatchChanges: true,
    });
  });

  test("signing-only provider: signs but cannot report network or watch changes", () => {
    const caps = detectWalletCapabilities({
      freighter: { requestAccess: fn, signTransaction: fn },
    });
    assert.equal(caps.installed, true);
    assert.equal(caps.canConnect, true);
    assert.equal(caps.canSignTransaction, true);
    assert.equal(caps.canGetNetwork, false);
    assert.equal(caps.canWatchChanges, false);
  });

  test("network-only provider: reports network but cannot sign", () => {
    const caps = detectWalletCapabilities({
      freighter: { isConnected: fn, getNetworkDetails: fn },
    });
    assert.equal(caps.canGetNetwork, true);
    assert.equal(caps.canSignTransaction, false);
  });

  test("listener-only provider: watches changes but cannot sign", () => {
    const caps = detectWalletCapabilities({
      freighter: { isConnected: fn, addEventListener: fn },
    });
    assert.equal(caps.canWatchChanges, true);
    assert.equal(caps.canSignTransaction, false);
  });

  test("partial/denied provider: members present but not functions → capability false", () => {
    const caps = detectWalletCapabilities({
      freighter: { signTransaction: null, getNetwork: 42, requestAccess: fn },
    });
    assert.equal(caps.installed, true);
    assert.equal(caps.canConnect, true);
    assert.equal(caps.canSignTransaction, false);
    assert.equal(caps.canGetNetwork, false);
  });

  test("legacy freighterApi global is detected when freighter is absent", () => {
    const caps = detectWalletCapabilities({ freighterApi: fullProvider });
    assert.equal(caps.installed, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getInjectedProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("getInjectedProvider", () => {
  test("prefers window.freighter over window.freighterApi", () => {
    const a = { signTransaction: fn };
    const b = { getNetwork: fn };
    assert.equal(getInjectedProvider({ freighter: a, freighterApi: b }), a);
  });

  test("returns null on the server", () => {
    assert.equal(getInjectedProvider(undefined), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// explainUnsupportedAction
// ─────────────────────────────────────────────────────────────────────────────

describe("explainUnsupportedAction", () => {
  const none = detectWalletCapabilities(undefined);
  const full = detectWalletCapabilities({ freighter: fullProvider });
  const signOnly = detectWalletCapabilities({
    freighter: { requestAccess: fn, signTransaction: fn },
  });

  test("no wallet → explains installation for any action", () => {
    const msg = explainUnsupportedAction("connect", none);
    assert.ok(msg && /install/i.test(msg));
  });

  test("supported action returns null (not blocked)", () => {
    assert.equal(explainUnsupportedAction("sign", full), null);
    assert.equal(explainUnsupportedAction("connect", signOnly), null);
  });

  test("unsupported capability is explained before the action starts", () => {
    const msg = explainUnsupportedAction("detectNetwork", signOnly);
    assert.ok(msg && /active network/i.test(msg));
    const msg2 = explainUnsupportedAction("watchChanges", signOnly);
    assert.ok(msg2 && /account changes/i.test(msg2));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getProviderNetwork
// ─────────────────────────────────────────────────────────────────────────────

describe("getProviderNetwork", () => {
  test("returns null when no provider is present", async () => {
    const result = await getProviderNetwork(undefined);
    assert.equal(result, null);
  });

  test("returns null when provider has neither getNetwork nor getNetworkDetails", async () => {
    const result = await getProviderNetwork({ freighter: { signTransaction: fn } });
    assert.equal(result, null);
  });

  test("reads networkPassphrase from getNetworkDetails object response", async () => {
    const provider = {
      getNetworkDetails: async () => ({ networkPassphrase: TEST_PASSPHRASE }),
    };
    const result = await getProviderNetwork({ freighter: provider });
    assert.equal(result, TEST_PASSPHRASE);
  });

  test("getNetworkDetails takes precedence over getNetwork", async () => {
    const provider = {
      getNetworkDetails: async () => ({ networkPassphrase: TEST_PASSPHRASE }),
      getNetwork: async () => MAIN_PASSPHRASE,
    };
    const result = await getProviderNetwork({ freighter: provider });
    assert.equal(result, TEST_PASSPHRASE);
  });

  test("falls back to getNetwork when getNetworkDetails returns no passphrase", async () => {
    const provider = {
      getNetworkDetails: async () => ({ somethingElse: "value" }),
      getNetwork: async () => MAIN_PASSPHRASE,
    };
    const result = await getProviderNetwork({ freighter: provider });
    assert.equal(result, MAIN_PASSPHRASE);
  });

  test("reads passphrase from getNetwork string response", async () => {
    const provider = {
      getNetwork: async () => TEST_PASSPHRASE,
    };
    const result = await getProviderNetwork({ freighter: provider });
    assert.equal(result, TEST_PASSPHRASE);
  });

  test("reads networkPassphrase from getNetwork object response", async () => {
    const provider = {
      getNetwork: async () => ({ networkPassphrase: TEST_PASSPHRASE }),
    };
    const result = await getProviderNetwork({ freighter: provider });
    assert.equal(result, TEST_PASSPHRASE);
  });

  test("returns null when getNetworkDetails throws and getNetwork is absent", async () => {
    const provider = {
      getNetworkDetails: async () => { throw new Error("extension error"); },
    };
    const result = await getProviderNetwork({ freighter: provider });
    assert.equal(result, null);
  });

  test("falls back to getNetwork when getNetworkDetails throws", async () => {
    const provider = {
      getNetworkDetails: async () => { throw new Error("error"); },
      getNetwork: async () => TEST_PASSPHRASE,
    };
    const result = await getProviderNetwork({ freighter: provider });
    assert.equal(result, TEST_PASSPHRASE);
  });

  test("trims whitespace from returned passphrase", async () => {
    const provider = {
      getNetworkDetails: async () => ({ networkPassphrase: `  ${TEST_PASSPHRASE}  ` }),
    };
    const result = await getProviderNetwork({ freighter: provider });
    assert.equal(result, TEST_PASSPHRASE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkNetworkMismatch
// ─────────────────────────────────────────────────────────────────────────────

describe("checkNetworkMismatch", () => {
  test("returns unsupported when no provider is present", async () => {
    const result = await checkNetworkMismatch(TEST_PASSPHRASE, undefined);
    assert.equal(result.kind, "unsupported");
  });

  test("returns unsupported when provider cannot report the network", async () => {
    const win = { freighter: { signTransaction: fn } };
    const result = await checkNetworkMismatch(TEST_PASSPHRASE, win);
    assert.equal(result.kind, "unsupported");
  });

  test("returns match when provider passphrase equals configured", async () => {
    const win = {
      freighter: {
        getNetworkDetails: async () => ({ networkPassphrase: TEST_PASSPHRASE }),
      },
    };
    const result = await checkNetworkMismatch(TEST_PASSPHRASE, win);
    assert.equal(result.kind, "match");
    if (result.kind === "match") {
      assert.equal(result.detectedPassphrase, TEST_PASSPHRASE);
    }
  });

  test("returns mismatch when provider passphrase differs from configured", async () => {
    const win = {
      freighter: {
        getNetworkDetails: async () => ({ networkPassphrase: MAIN_PASSPHRASE }),
      },
    };
    const result = await checkNetworkMismatch(TEST_PASSPHRASE, win);
    assert.equal(result.kind, "mismatch");
    if (result.kind === "mismatch") {
      assert.equal(result.detectedPassphrase, MAIN_PASSPHRASE);
      assert.equal(result.configuredPassphrase, TEST_PASSPHRASE);
    }
  });

  test("returns unknown when provider returns null passphrase", async () => {
    const win = {
      freighter: {
        getNetworkDetails: async () => ({ somethingElse: "value" }),
      },
    };
    const result = await checkNetworkMismatch(TEST_PASSPHRASE, win);
    assert.equal(result.kind, "unknown");
  });

  test("mismatch carries both detected and configured passphrases", async () => {
    const win = {
      freighter: {
        getNetwork: async () => MAIN_PASSPHRASE,
      },
    };
    const result = await checkNetworkMismatch(TEST_PASSPHRASE, win);
    assert.equal(result.kind, "mismatch");
    if (result.kind === "mismatch") {
      assert.equal(result.detectedPassphrase, MAIN_PASSPHRASE);
      assert.equal(result.configuredPassphrase, TEST_PASSPHRASE);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describeNetworkMismatch
// ─────────────────────────────────────────────────────────────────────────────

describe("describeNetworkMismatch", () => {
  test("match → returns null (no warning needed)", () => {
    const result = describeNetworkMismatch({
      kind: "match",
      detectedPassphrase: TEST_PASSPHRASE,
    });
    assert.equal(result, null);
  });

  test("mismatch → returns non-null message mentioning both passphrases", () => {
    const msg = describeNetworkMismatch({
      kind: "mismatch",
      detectedPassphrase: MAIN_PASSPHRASE,
      configuredPassphrase: TEST_PASSPHRASE,
    });
    assert.ok(msg !== null, "mismatch must produce a non-null message");
    assert.ok(msg!.includes(MAIN_PASSPHRASE), "message must include detected passphrase");
    assert.ok(msg!.includes(TEST_PASSPHRASE), "message must include configured passphrase");
  });

  test("unknown → returns non-null advisory message", () => {
    const msg = describeNetworkMismatch({ kind: "unknown" });
    assert.ok(msg !== null);
    assert.ok(msg!.toLowerCase().includes("network"));
  });

  test("unsupported → returns non-null advisory message", () => {
    const msg = describeNetworkMismatch({ kind: "unsupported" });
    assert.ok(msg !== null);
    assert.ok(msg!.toLowerCase().includes("network"));
  });

  test("provider_error → returns non-null advisory message", () => {
    const msg = describeNetworkMismatch({ kind: "provider_error", error: "timeout" });
    assert.ok(msg !== null);
    assert.ok(msg!.toLowerCase().includes("error") || msg!.toLowerCase().includes("network"));
  });
});
