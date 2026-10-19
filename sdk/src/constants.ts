// ─── Network constants shared across all CircleUp packages ───────────────────

export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
export const MAINNET_RPC_URL = "https://soroban-mainnet.stellar.org";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

/** Stellar Friendbot endpoint (testnet only) */
export const FRIENDBOT_URL = "https://friendbot.stellar.org";

/** 1 USDC = 10,000,000 stroops (7 decimal places) */
export const USDC_DECIMALS = 7;
export const STROOPS_PER_USDC = 10_000_000;

/** Approximate ledgers per day at ~5 seconds per ledger */
export const LEDGERS_PER_DAY = 17_280;
export const LEDGERS_PER_WEEK = LEDGERS_PER_DAY * 7;
export const LEDGERS_PER_MONTH = LEDGERS_PER_DAY * 30;

/** Default penalty for a missed contribution: 20% of collateral */
export const DEFAULT_PENALTY_BPS = 2_000; // 20%
export const BPS_DENOM = 10_000;

/**
 * Page-size bounds of the indexer's paged list endpoints (mirrors
 * DEFAULT_LIMIT / MAX_LIMIT in indexer/src/api.ts). `IndexerClient` rejects a
 * `limit` outside `1..INDEXER_MAX_PAGE_SIZE` before sending the request.
 */
export const INDEXER_DEFAULT_PAGE_SIZE = 20;
export const INDEXER_MAX_PAGE_SIZE = 100;

// ─── Network config helpers ───────────────────────────────────────────────────

/** Identifies which Stellar network to target. */
export type NetworkName = "testnet" | "mainnet";

/**
 * All the network-level constants needed to initialise an RPC client or build
 * a `CircleUpConfig`.  Prefer using `getNetworkConfig` over hard-coding these
 * values directly so callers get a clear error when an unsupported network is
 * requested.
 */
export interface NetworkConfig {
  network: NetworkName;
  rpcUrl: string;
  passphrase: string;
  /**
   * Friendbot URL for funding accounts.  Only available on testnet; `null` on
   * mainnet so callers can branch without an extra network check.
   */
  friendbotUrl: string | null;
}

const NETWORK_CONFIGS: Record<NetworkName, NetworkConfig> = {
  testnet: {
    network: "testnet",
    rpcUrl: TESTNET_RPC_URL,
    passphrase: TESTNET_PASSPHRASE,
    friendbotUrl: FRIENDBOT_URL,
  },
  mainnet: {
    network: "mainnet",
    rpcUrl: MAINNET_RPC_URL,
    passphrase: MAINNET_PASSPHRASE,
    friendbotUrl: null,
  },
};

/**
 * Return the `NetworkConfig` for the requested network.
 *
 * Throws a descriptive `Error` when an unrecognised network name is passed so
 * misconfigured callers get an explicit message rather than a silent `undefined`
 * access downstream.
 *
 * @example
 * const cfg = getNetworkConfig("testnet");
 * const rpc = new SorobanRpc.Server(cfg.rpcUrl);
 */
export function getNetworkConfig(network: NetworkName): NetworkConfig {
  const cfg = NETWORK_CONFIGS[network];
  if (!cfg) {
    const valid = Object.keys(NETWORK_CONFIGS).join(", ");
    throw new Error(
      `Unknown network "${network}". Valid options are: ${valid}.`,
    );
  }
  return cfg;
}

/**
 * Return `true` when the given string is a recognised `NetworkName`.
 * Useful for validating user input or environment variable values before
 * calling `getNetworkConfig`.
 *
 * @example
 * const raw = process.env.NETWORK ?? "";
 * if (!isValidNetwork(raw)) throw new Error(`Invalid NETWORK env var: "${raw}"`);
 * const cfg = getNetworkConfig(raw);
 */
export function isValidNetwork(value: string): value is NetworkName {
  return value === "testnet" || value === "mainnet";
}

// ─── Block explorer links ─────────────────────────────────────────────────────

/** Host prefix shared by every Stellar Expert explorer URL. */
export const EXPLORER_BASE_URL = "https://stellar.expert/explorer";

/**
 * The kinds of on-chain entity a block explorer link can point at.  These map
 * directly onto Stellar Expert's URL path segments (`/tx/…`, `/account/…`,
 * `/contract/…`).
 */
export type ExplorerEntityType = "tx" | "account" | "contract";

/**
 * Stellar Expert's URL path segment for each supported network.
 *
 * Note the mainnet segment is `public`, **not** `mainnet` — Stellar Expert
 * names the mainnet network "public".  Getting this wrong silently points every
 * mainnet link at a non-existent (or worse, testnet) page, so the mapping is
 * centralised here rather than string-built at each call site.
 */
const EXPLORER_NETWORK_SEGMENT: Record<NetworkName, string> = {
  testnet: "testnet",
  mainnet: "public",
};

/**
 * Build a Stellar Expert explorer URL for a transaction, account, or contract
 * on a given network.
 *
 * The returned link always matches the requested network (mainnet correctly
 * maps to Stellar Expert's `public` segment).  The identifier is URL-encoded so
 * a value containing slashes, spaces, or other path characters can never break
 * out of the intended path.
 *
 * Returns `null` — a safe "non-link" result the caller can render as plain text
 * instead of an anchor — when:
 *   - `network` is not a supported {@link NetworkName} (e.g. a custom/standalone
 *     network for which no public explorer exists), or
 *   - `identifier` is empty or whitespace-only (there is nothing to link to).
 *
 * @param network     Target network name. Unknown values yield `null`.
 * @param type        The entity kind: `"tx"`, `"account"`, or `"contract"`.
 * @param identifier  The transaction hash / account / contract address.
 * @returns           A fully-qualified explorer URL, or `null` when no safe
 *                    link can be produced.
 *
 * @example
 * getExplorerLink("testnet", "tx", hash)
 *   // → "https://stellar.expert/explorer/testnet/tx/<hash>"
 * getExplorerLink("mainnet", "account", "GABC…")
 *   // → "https://stellar.expert/explorer/public/account/GABC…"
 * getExplorerLink("standalone", "tx", hash) // → null
 * getExplorerLink("testnet", "tx", "")      // → null
 */
export function getExplorerLink(
  network: string,
  type: ExplorerEntityType,
  identifier: string,
): string | null {
  if (!isValidNetwork(network)) return null;

  const trimmed = typeof identifier === "string" ? identifier.trim() : "";
  if (trimmed === "") return null;

  const segment = EXPLORER_NETWORK_SEGMENT[network];
  return `${EXPLORER_BASE_URL}/${segment}/${type}/${encodeURIComponent(trimmed)}`;
}
