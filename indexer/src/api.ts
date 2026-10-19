/**
 * CircleUp REST API
 *
 * GET /circles                         → list circles (paginated, sortable, status-filterable)
 *                                        ?status=  Pending|Active|Completed|Cancelled|Closed
 *                                        ?sort=    created_ledger|updated_at|round_amount|member_count|status
 *                                        ?order=   asc|desc  (default: desc)
 *                                        ?page=    positive integer (default: 1)
 *                                        ?limit=   1–100 (default: 20)
 * GET /circles/summary                 → circle counts by status (Pending/Active/Completed/Cancelled/Closed)
 * GET /circles/:address                → circle detail + members + rounds
 * GET /circles/:address/members        → members with reputation, contribution counts, and current-round status
 * GET /circles/:address/rounds         → all rounds grouped by round_index: payouts + contributions + defaults
 * GET /members/:member/contributions   → member contribution history (optional ?circle=)
 * GET /reputation/:member              → member reputation score
 * GET /indexer/state                   → indexer audit: last ledger + event counts + entity totals
 * GET /indexer/schema                  → schema versioning and migration status diagnostics
 * GET /indexer/failures                → open event-handler failures (skipped events)
 *                                        ?ledger=   restrict to one ledger
 *                                        ?eventId=  look up one RPC event id
 *                                        ?limit=    1–100 (default: 20)
 * GET /health                          → health check (db + RPC status)
 *
 * DB helpers used: query<T> (many rows), queryOne<T> (0‥1 rows → T|null),
 * queryExact<T> (exactly 1 row or throws). The queryOne/queryExact helpers
 * replace the fragile `const [row] = await query(...)` destructuring pattern
 * that silently produced undefined when no row existed (see pool.ts).
 */

import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { query, queryOne, queryExact } from "./db/pool";
import { rpc, USDC, getIndexerMetrics, isIndexerRunning } from "./indexer";
import { groupCircleRounds } from "./groupRounds";
import { runAllHealthChecks } from "./health";
import { isUndefinedTable, listOpenEventFailures } from "./eventFailures";
import { redactAddress } from "./redact";
import { logApiCorsRejected, logApiRequest, logApiRequestError } from "./logger";
import type { MigrationHealth } from "./db/migrate";

// ── Address validation ────────────────────────────────────────────────────────
//
// Stellar has two address namespaces:
//   G-prefix (56 base32 chars) — ed25519 public key (wallet / member address)
//   C-prefix (56 base32 chars) — Soroban contract ID (circle / factory / token)
//
// These regexes are intentionally inlined here so the indexer has no
// dependency on the app package's address module.
const STELLAR_PUBLIC_KEY_RE = /^G[A-Z2-7]{55}$/;
const SOROBAN_CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

/** Returns true for a valid Stellar ed25519 public key (G-prefix, 56 chars). */
function isStellarPublicKey(addr: string): boolean {
  return STELLAR_PUBLIC_KEY_RE.test(addr);
}

/** Returns true for a valid Soroban contract ID (C-prefix, 56 chars). */
function isSorobanContractId(addr: string): boolean {
  return SOROBAN_CONTRACT_ID_RE.test(addr);
}

/**
 * Returns true for any valid canonical Stellar address — either a public key
 * or a Soroban contract ID.  Route params that may legitimately be either type
 * (e.g. `:member`, `:address`) should be validated with this function.
 */
function isCanonicalStellarAddress(addr: string): boolean {
  return isStellarPublicKey(addr) || isSorobanContractId(addr);
}

// ── CORS ─────────────────────────────────────────────────────────────────────
//
// ALLOWED_ORIGINS is a comma-separated allow-list, e.g.
// "https://app.circleup.xyz,https://staging.circleup.xyz". Only entries that
// are well-formed http(s) origins (scheme + host [+ port], no path/query) are
// honoured — malformed entries are dropped (dev) or, in production, treated
// as a configuration error (see buildCorsOptions below).
function isValidOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    // An Origin header is scheme + host [+ port] only — reject anything that
    // also carries a path, query string, or fragment.
    return `${parsed.protocol}//${parsed.host}` === origin;
  } catch {
    return false;
  }
}

function parseAllowedOrigins(raw: string | undefined): { origins: string[]; invalid: string[] } {
  const entries = (raw || "").split(",").map((o) => o.trim()).filter(Boolean);
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    (isValidOrigin(entry) ? origins : invalid).push(entry);
  }
  return { origins, invalid };
}

/**
 * Build the CORS options for the API.
 *
 * When `allowedOrigins` is omitted, the list is parsed from ALLOWED_ORIGINS.
 * An empty or entirely-invalid list falls back to allowing every origin in
 * development (with a warning) but throws in production — a service running
 * with `NODE_ENV=production` must never silently start wide open.
 *
 * Credentials are always disabled: the API is read-only and unauthenticated
 * (no cookies or HTTP auth are ever expected), so there is no case where a
 * cross-origin request needs `Access-Control-Allow-Credentials`.
 */
export function buildCorsOptions(
  allowedOrigins?: string[],
  { nodeEnv = process.env.NODE_ENV }: { nodeEnv?: string } = {},
): cors.CorsOptions {
  const isProduction = nodeEnv === "production";
  let origins: string[];

  if (allowedOrigins !== undefined) {
    origins = allowedOrigins;
  } else {
    const parsed = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
    if (parsed.invalid.length > 0) {
      const message =
        `[api] ALLOWED_ORIGINS contains invalid entries: ${parsed.invalid.join(", ")}. ` +
        `Each origin must be an absolute http(s) URL with no path, e.g. "https://app.circleup.xyz".`;
      if (isProduction) throw new Error(message);
      console.warn(`${message} Ignoring the invalid entries.`);
    }
    origins = parsed.origins;
  }

  if (origins.length === 0) {
    if (isProduction) {
      throw new Error(
        "[api] ALLOWED_ORIGINS must be set to a comma-separated list of allowed origins " +
          "when NODE_ENV=production. Refusing to start with CORS open to all origins.",
      );
    }
    console.warn(
      "[api] ALLOWED_ORIGINS is not set — allowing all origins. " +
        "Set ALLOWED_ORIGINS to a comma-separated list in production.",
    );
    return { origin: true, credentials: false };
  }

  return {
    origin(origin, callback) {
      // requests with no Origin header (curl, server-to-server, health checks)
      if (!origin || origins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: false,
  };
}

// ── Proxy trust (client identity for rate limiting) ──────────────────────────
//
// express-rate-limit keys requests by req.ip. Behind a reverse proxy (nginx,
// an ALB, Cloudflare) the real client address only appears in
// X-Forwarded-For, so Express must be told how many proxy hops to trust —
// left unset, every client is bucketed under the proxy's own IP (one shared
// limit for the whole service); trusted blindly (`trust proxy: true`), a
// client can forge X-Forwarded-For to reset its own limit on every request.
//
// TRUST_PROXY_HOPS: number of hops between the client and this process.
//   0 (default) — trust nothing; req.ip is the direct socket address. Correct
//                 for local dev and any deployment exposed directly.
//   N            — trust the Nth hop from the edge (e.g. 1 behind a single
//                  load balancer / reverse proxy).
function parseTrustProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `[api] TRUST_PROXY_HOPS must be a non-negative integer, got: "${raw}"`,
    );
  }
  return n;
}

export const TRUST_PROXY_HOPS = parseTrustProxyHops(process.env.TRUST_PROXY_HOPS);

// ── Rate limiting ────────────────────────────────────────────────────────────
//
// List, detail, health, and history routes have different cost and abuse
// profiles, so each route class gets its own bucket instead of one global
// limit: a burst against the expensive list/history endpoints can no longer
// starve health checks or cheap detail reads, and vice versa. Every class
// shares RATE_LIMIT_WINDOW_MS but has its own max, independently tunable via
// env so operators can raise/lower a single class without touching the rest.
//
// Response body is the same generic message for every class and every 429 —
// it never reveals which limit was hit, its configured value, or anything
// else about the service's internals. standardHeaders (RateLimit-*,
// Retry-After) is enabled because those headers are the intended, documented
// way for a well-behaved client to back off; that is not an internal detail.

const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_WINDOW_MS || "60000",
  10,
);

/** Paginated, sortable, joined list — the most expensive read the API offers. */
const RATE_LIMIT_LIST_MAX = parseInt(process.env.RATE_LIMIT_LIST_MAX || "30", 10);
/** Single-entity / small-aggregate reads (circle detail, members, rounds, reputation, summary, indexer state). */
const RATE_LIMIT_DETAIL_MAX = parseInt(process.env.RATE_LIMIT_DETAIL_MAX || "100", 10);
/** Member contribution history — paginated and joined, walkable across many pages by an attacker. */
const RATE_LIMIT_HISTORY_MAX = parseInt(process.env.RATE_LIMIT_HISTORY_MAX || "30", 10);
/** Health checks are polled frequently by uptime monitors/load balancers and must stay reachable under load elsewhere. */
const RATE_LIMIT_HEALTH_MAX = parseInt(process.env.RATE_LIMIT_HEALTH_MAX || "300", 10);

function createRateLimiter(max: number) {
  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  });
}

const listRateLimiter = createRateLimiter(RATE_LIMIT_LIST_MAX);
const detailRateLimiter = createRateLimiter(RATE_LIMIT_DETAIL_MAX);
const historyRateLimiter = createRateLimiter(RATE_LIMIT_HISTORY_MAX);
const healthRateLimiter = createRateLimiter(RATE_LIMIT_HEALTH_MAX);

// ── Error helpers ────────────────────────────────────────────────────────────

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

function sendError(res: Response, status: number, message: string, details?: unknown) {
  res.status(status).json({
    error: {
      message,
      details: details ?? null,
    },
  });
}

// ── Pagination / query-param constants ───────────────────────────────────────

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const SORTABLE_FIELDS = [
  "created_ledger",
  "updated_at",
  "round_amount",
  "member_count",
  "status",
] as const;
type SortableField = (typeof SORTABLE_FIELDS)[number];

// "Closed" is not a contract-enum variant — the contract records it as a
// boolean flag (DataKey::Closed), but the indexer projects it as a status
// string when it receives a circle/closed event.  Including it here lets
// callers filter GET /circles?status=Closed to retrieve fully-settled circles
// without a full scan and client-side filter.
const CIRCLE_STATUSES = ["Pending", "Active", "Completed", "Cancelled", "Closed"] as const;
type CircleStatus = (typeof CIRCLE_STATUSES)[number];

const HEALTH_CHECK_TIMEOUT_MS = 5_000;
void HEALTH_CHECK_TIMEOUT_MS; // retained for reference; checks now live in health.ts

type ParseResult<T> = T | { error: string };

function isParseError<T>(result: ParseResult<T>): result is { error: string } {
  return typeof result === "object" && result !== null && "error" in result;
}

function parsePage(value: unknown): ParseResult<number> {
  if (value === undefined) return DEFAULT_PAGE;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    return { error: "page must be a positive integer" };
  }
  return n;
}

function parseLimit(value: unknown): ParseResult<number> {
  if (value === undefined) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    return { error: `limit must be an integer between 1 and ${MAX_LIMIT}` };
  }
  return n;
}

function parseSort(value: unknown): ParseResult<SortableField> {
  if (value === undefined) return "created_ledger";
  if (
    typeof value === "string" &&
    (SORTABLE_FIELDS as readonly string[]).includes(value)
  ) {
    return value as SortableField;
  }
  return { error: `sort must be one of: ${SORTABLE_FIELDS.join(", ")}` };
}

function parseOrder(value: unknown): ParseResult<"asc" | "desc"> {
  if (value === undefined) return "desc";
  if (value === "asc" || value === "desc") return value;
  return { error: "order must be 'asc' or 'desc'" };
}

function parseStatus(value: unknown): ParseResult<CircleStatus | undefined> {
  if (value === undefined) return undefined;
  if (
    typeof value === "string" &&
    (CIRCLE_STATUSES as readonly string[]).includes(value)
  ) {
    return value as CircleStatus;
  }
  return { error: `status must be one of: ${CIRCLE_STATUSES.join(", ")}` };
}

// Stellar address: G-address (account) or C-address (contract), 56 base32 chars.
const STELLAR_ADDRESS_RE = /^[GC][A-Z2-7]{55}$/;

function isStellarAddress(value: string): boolean {
  return STELLAR_ADDRESS_RE.test(value);
}

function parseAddress(value: string | undefined, label: string): ParseResult<string> {
  if (!value || value.trim() === "") {
    return { error: `${label} is required` };
  }
  const trimmed = value.trim();
  if (!isStellarAddress(trimmed)) {
    return { error: `${label} must be a valid Stellar address (G… or C…, 56 characters)` };
  }
  return trimmed;
}

function parseCircleFilter(value: unknown): ParseResult<string | undefined> {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    return { error: "circle must be a non-empty string" };
  }
  const trimmed = value.trim();
  if (!isStellarAddress(trimmed)) {
    return { error: "circle must be a valid Stellar address (G… or C…, 56 characters)" };
  }
  return trimmed;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    }),
  ]);
}

interface ComponentHealth {
  status: "ok" | "error";
  latencyMs?: number;
  error?: string;
}

async function checkComponentHealth(
  check: () => Promise<unknown>,
): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    await withTimeout(check(), HEALTH_CHECK_TIMEOUT_MS);
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface CircleRow {
  address: string;
  creator: string;
  round_amount: string;
  member_count: number;
  status: string;
  current_round: number;
  total_rounds: number;
  created_ledger: string;
  round_deadline_ledgers: number | null;
  updated_at: string;
}

interface CircleMemberRow {
  circle_address: string;
  member_address: string;
  payout_order: number;
  join_order: number | null;
  collateral: string;
  defaults: number;
  joined_at: string | null;
  reputation_score: number | null;
}

interface CircleMemberWithContributionsRow extends CircleMemberRow {
  total_contributions: string;
}

interface CircleMemberTotalsRow {
  member_count: string;
  total_collateral: string;
  total_contributions: string;
}

interface ContributionRow {
  circle_address: string;
  member_address: string;
  round_index: number;
  amount: string;
  tx_hash: string;
  ledger: string;
  created_at: string;
}

interface PayoutRow {
  circle_address: string;
  recipient: string;
  round_index: number;
  amount: string;
  tx_hash: string;
  ledger: string;
  created_at: string;
}

interface DefaultRow {
  circle_address: string;
  member_address: string;
  round_index: number;
  penalty: string;
  tx_hash: string;
  ledger: string;
  created_at: string;
}

interface ReputationRow {
  member_address: string;
  score: number;
  updated_at: string;
}

interface ReputationContributionSummaryRow {
  circle_address: string;
  contributions: string;
  total_rounds: number;
}

interface ReputationDefaultSummaryRow {
  circle_address: string;
  count: string;
}

interface IndexerStateRow {
  last_ledger: string;
}

interface IndexerStateAuditRow {
  last_ledger: string;
  updated_at: string;
}

interface EventTypeCountRow {
  event_type: string | null;
  count: string;
}

interface EntityCountsSingleRow {
  circles: string;
  members: string;
  contributions: string;
  payouts: string;
  defaults: string;
}

interface CircleStatusCountRow {
  status: string;
  count: string;
}


export function createApp(options: { cachedMigrationHealth?: MigrationHealth | null } = {}) {
  const app = express();
  app.set("trust proxy", TRUST_PROXY_HOPS);
  app.use(cors(buildCorsOptions()));
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    const startedAt = Date.now();

    _res.on("finish", () => {
      logApiRequest({
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode: _res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    next();
  });

  // cors() calls next(err) for rejected origins instead of sending a response
  // itself — without this handler, Express's default error page would leak a
  // stack trace instead of a clean 403.
  app.use(
    (err: Error, req: Request, res: Response, next: express.NextFunction) => {
      if (err.message.startsWith("Origin ")) {
        logApiCorsRejected({
          method: req.method,
          path: req.originalUrl || req.url,
          origin: req.headers.origin ?? undefined,
        });
        res.status(403).json({ error: err.message });
        return;
      }
      next(err);
    },
  );

  // ── Health ───────────────────────────────────────────────────────────────────
  //
  // Runs all operational health checks in parallel:
  //   • Postgres connectivity
  //   • Soroban RPC connectivity
  //   • Indexer ledger lag (DB last_ledger vs RPC latest_ledger)
  //   • Schema migration health (surfaced from startup check or live query)
  //   • Contract state drift (DB current_round vs on-chain value for a sampled
  //     Active circle — skipped when RPC is unavailable)
  //
  // Returns HTTP 200 when all checks pass, 503 when any component is degraded
  // or errored, so load-balancers and uptime monitors can act on the status
  // code without parsing the body.

  app.get("/health", healthRateLimiter, async (_req: Request, res: Response) => {
    const report = await runAllHealthChecks({
      rpc,
      usdcAddress: USDC,
      cachedMigrationHealth: options.cachedMigrationHealth ?? null,
    });
    res.status(
      report.serviceStatus === "healthy" || report.status === "ok" ? 200 : 503,
    ).json(report);
  });

  // ── Circles ──────────────────────────────────────────────────────────────────

  app.get("/circles", listRateLimiter, async (req: Request, res: Response) => {
    const pageResult = parsePage(req.query.page);
    const limitResult = parseLimit(req.query.limit);
    const sortResult = parseSort(req.query.sort);
    const orderResult = parseOrder(req.query.order);
    const statusResult = parseStatus(req.query.status);

    const errors = [pageResult, limitResult, sortResult, orderResult, statusResult]
      .filter(isParseError)
      .map((r) => r.error);

    if (errors.length > 0) {
      res.status(400).json({ error: errors.join("; ") });
      return;
    }

    const page = pageResult as number;
    const limit = limitResult as number;
    const sort = sortResult as SortableField;
    const order = orderResult as "asc" | "desc";
    const status = statusResult as CircleStatus | undefined;

    const offset = (page - 1) * limit;
    const whereClause = status ? "WHERE c.status = $1" : "";
    const whereParams = status ? [status] : [];

    try {
      const [circles, [countRow]] = await Promise.all([
        query<
          Pick<
            CircleRow,
            | "address"
            | "creator"
            | "round_amount"
            | "member_count"
            | "status"
            | "current_round"
            | "total_rounds"
            | "created_ledger"
            | "updated_at"
          >
        >(
          `SELECT c.address, c.creator, c.round_amount, c.member_count,
                  c.status, c.current_round, c.total_rounds, c.created_ledger,
                  c.updated_at
           FROM circles c
           ${whereClause}
           ORDER BY c.${sort} ${order.toUpperCase()}
           LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}`,
          [...whereParams, limit, offset],
        ),
        query<{ count: string }>(
          `SELECT COUNT(*) as count FROM circles c ${whereClause}`,
          whereParams,
        ),
      ]);
      const total = Number(countRow.count);

      res.json({
        circles,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      console.error("[api] Failed to list circles", err);
      sendError(res, 500, "Failed to list circles", getErrorMessage(err));
    }
  });

  app.get("/circles/summary", detailRateLimiter, async (_req: Request, res: Response) => {
    try {
      const rows = await query<{ status: string; count: string }>(
        `SELECT status, COUNT(*) as count FROM circles GROUP BY status`,
      );

      const byStatus = CIRCLE_STATUSES.reduce(
        (acc, s) => ({ ...acc, [s]: 0 }),
        {} as Record<CircleStatus, number>,
      );

      let total = 0;
      for (const row of rows) {
        const count = Number(row.count);
        total += count;
        // Accept any known status, including the indexer-only "Closed" value
        // that the contract does not expose as an enum variant.
        if ((CIRCLE_STATUSES as readonly string[]).includes(row.status)) {
          byStatus[row.status as CircleStatus] = count;
        }
      }

      res.json({ total, byStatus });
    } catch (err) {
      console.error("[api] Failed to list circles", err);
      sendError(res, 500, "Failed to list circles", getErrorMessage(err));
    }
  });

  app.get("/circles/:address", detailRateLimiter, async (req: Request, res: Response) => {
    const addressResult = parseAddress(req.params.address, "Circle address");
    if (isParseError(addressResult)) {
      res.status(400).json({ error: addressResult.error });
      return;
    }
    const address = addressResult;
    try {
      const circle = await queryOne<CircleRow>(
        `SELECT * FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        res.status(404).json({
          error: "Circle not found",
          detail:
            `No circle with address '${address}' has been indexed yet. ` +
            `The circle may not exist on-chain, or the indexer may not have ` +
            `processed the factory/circle_created event for this address.`,
          address,
        });
        return;
      }

      const members = await query<CircleMemberRow>(
        `SELECT cm.*, r.score as reputation_score
         FROM circle_members cm
         LEFT JOIN reputation r ON r.member_address = cm.member_address
         WHERE cm.circle_address = $1
         ORDER BY cm.payout_order`,
        [address],
      );

      // Attach the latest indexed ledger so the client can derive wall-clock
      // estimates for the deadline countdown without a separate request.
      const indexerState = await queryOne<IndexerStateRow>(
        `SELECT last_ledger FROM indexer_state WHERE id = 1`,
      );
      const latestLedger = indexerState ? Number(indexerState.last_ledger) : null;

      // Compute deadline_ledger for the current active round when we have
      // enough data.  Formula:
      //   deadline = created_ledger
      //            + (current_round + 1) * round_deadline_ledgers
      //
      // This is an approximation based on the creation ledger; the contract
      // sets the exact deadline per-round, but the indexer does not yet store
      // the per-round deadline_ledger from contract state.
      let deadlineLedger: number | null = null;
      if (
        circle.round_deadline_ledgers != null &&
        circle.created_ledger != null &&
        circle.status === "Active"
      ) {
        deadlineLedger =
          Number(circle.created_ledger) +
          (Number(circle.current_round) + 1) *
            Number(circle.round_deadline_ledgers);
      }

      res.json({
        circle: {
          ...circle,
          deadline_ledger: deadlineLedger,
        },
        members,
        latestLedger,
      });
    } catch (err) {
      console.error(`[api] Failed to load circle ${redactAddress(address)}`, err);
      sendError(res, 500, "Failed to load circle", getErrorMessage(err));
    }
  });

  // ── Dedicated members endpoint (#539) ────────────────────────────────────────
  //
  // Returns all members for a single circle in payout_order with:
  //   • reputation score (joined from reputation table)
  //   • total historical contribution count across all rounds
  //   • hasContributedCurrentRound — whether the member has contributed in the
  //     circle's current round index (useful for the circle detail UI without
  //     needing to load the full rounds history)
  //   • totals aggregate: memberCount, totalCollateral, totalContributions
  //   • roundDeadlineLedgers — from the circle row, so clients can derive
  //     per-member deadline estimates without a second request

  app.get("/circles/:address/members", detailRateLimiter, async (req: Request, res: Response) => {
    const addressResult = parseAddress(req.params.address, "Circle address");
    if (isParseError(addressResult)) {
      res.status(400).json({ error: addressResult.error });
      return;
    }
    const address = addressResult;
    try {
      const circle = await queryOne<Pick<CircleRow, "address" | "current_round" | "round_deadline_ledgers">>(
        `SELECT address, current_round, round_deadline_ledgers FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        res.status(404).json({
          error: "Circle not found",
          detail:
            `No circle with address '${address}' has been indexed yet. ` +
            `The circle may not exist on-chain, or the indexer may not have ` +
            `processed the factory/circle_created event for this address.`,
          address,
        });
        return;
      }

      const [members, [totals]] = await Promise.all([
        query<CircleMemberWithContributionsRow>(
          `SELECT cm.member_address, cm.payout_order, cm.join_order, cm.collateral,
                  cm.defaults, cm.joined_at,
                  r.score as reputation_score,
                  COALESCE(
                    (SELECT COUNT(*) FROM contributions c2
                     WHERE c2.circle_address = cm.circle_address
                       AND c2.member_address = cm.member_address),
                    0
                  ) as total_contributions
           FROM circle_members cm
           LEFT JOIN reputation r ON r.member_address = cm.member_address
           WHERE cm.circle_address = $1
           ORDER BY cm.payout_order`,
          [address, circle.current_round],
        ),
        // COALESCE guards SUM/COUNT-derived totals against NULL, which
        // Postgres returns for aggregates over zero rows (e.g. a circle with
        // no members yet, or no contributions recorded) — without it, a
        // freshly created circle would report total_collateral: null instead
        // of "0", inconsistent with member_count: 0.
        queryOne<CircleMemberTotalsRow>(
          `SELECT
             COUNT(cm.*) as member_count,
             COALESCE(SUM(cm.collateral), 0) as total_collateral,
             COALESCE(
               (SELECT COUNT(*) FROM contributions c WHERE c.circle_address = $1),
               0
             ) as total_contributions
           FROM circle_members cm
           WHERE cm.circle_address = $1`,
          [address],
        ),
      ]);

      // totals will always have a row (COUNT over zero rows returns one row
      // with count=0); use queryOne default fallback just in case.
      const t = totals ?? { member_count: "0", total_collateral: "0", total_contributions: "0" };

      res.json({
        members: members.map((m) => ({
          ...m,
          total_contributions: Number(m.total_contributions),
        })),
        totals: {
          memberCount: Number(t.member_count),
          totalCollateral: t.total_collateral,
          totalContributions: Number(t.total_contributions),
        },
        roundDeadlineLedgers: circle.round_deadline_ledgers,
      });
    } catch (err) {
      console.error(`[api] Failed to load members for circle ${redactAddress(address)}`, err);
      sendError(res, 500, "Failed to load circle members", getErrorMessage(err));
    }
  });

  // ── Rounds history endpoint (#540) ───────────────────────────────────────────
  //
  // Returns all indexed rounds for a circle grouped by round_index.  Each round
  // includes its payout (if settled), all contributions, all defaults, and a
  // resolved `status` (completed | current | cancelled | open).
  //
  // Grouping improvements over a flat payout list:
  //   • Rounds that have contributions or defaults but no payout yet are
  //     surfaced in `openRounds` instead of being silently dropped.
  //   • The active current round is always present in `currentRound` even when
  //     it has no activity yet.
  //   • Duplicate payout rows (replay / ingest anomaly) are de-duplicated by
  //     `buildPayoutIndex` with a non-fatal warning log.
  //   • `deadlineLedger` is computed for every round from
  //     `created_ledger + (roundIndex + 1) * round_deadline_ledgers` so clients
  //     can display a countdown without a separate RPC call.

  app.get("/circles/:address/rounds", detailRateLimiter, async (req: Request, res: Response) => {
    const addressResult = parseAddress(req.params.address, "Circle address");
    if (isParseError(addressResult)) {
      res.status(400).json({ error: addressResult.error });
      return;
    }
    const address = addressResult;
    try {
      const circle = await queryOne<
        Pick<CircleRow, "address" | "current_round" | "total_rounds" | "status" | "created_ledger" | "round_deadline_ledgers">
      >(
        `SELECT address, current_round, total_rounds, status, created_ledger, round_deadline_ledgers FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        res.status(404).json({
          error: "Circle not found",
          detail:
            `No circle with address '${address}' has been indexed yet. ` +
            `The circle may not exist on-chain, or the indexer may not have ` +
            `processed the factory/circle_created event for this address.`,
          address,
        });
        return;
      }

      const [payouts, contributions, defaults] = await Promise.all([
        query<PayoutRow>(
          `SELECT * FROM payouts WHERE circle_address = $1 ORDER BY round_index`,
          [address],
        ),
        query<ContributionRow>(
          `SELECT * FROM contributions WHERE circle_address = $1 ORDER BY round_index, created_at`,
          [address],
        ),
        query<DefaultRow>(
          `SELECT * FROM defaults WHERE circle_address = $1 ORDER BY round_index`,
          [address],
        ),
      ]);

      // Single-pass grouping by round_index so contributions/defaults for
      // unpaid rounds are never silently dropped, and we avoid O(n×m)
      // filter scans per payout.
      //
      // Every GroupedRound carries a `status` field ("completed", "current",
      // "cancelled", or "open") that is included in the serialised JSON so
      // clients can branch on lifecycle phase directly rather than inferring
      // it from the presence/absence of payout fields (issue #529).
      const { rounds, currentRound, openRounds, pendingDefaults } =
        groupCircleRounds(circle, payouts, contributions, defaults);

      // Compute deadlineLedger for each round when the circle has the
      // round_deadline_ledgers field set (present on circles created after
      // migration 001). Formula:
      //   deadline = created_ledger + (roundIndex + 1) * round_deadline_ledgers
      //
      // This is an approximation derived from the creation ledger; the exact
      // per-round deadline is set inside the contract but is not yet stored
      // as a separate indexed column.
      //
      // `circle` is non-null here — the early return above guards that — but
      // TypeScript cannot narrow it across a function boundary, so we capture
      // the non-null value explicitly.
      const nonNullCircle = circle;
      const computeDeadlineLedger = (roundIndex: number): number | null => {
        if (nonNullCircle.round_deadline_ledgers == null || nonNullCircle.created_ledger == null) {
          return null;
        }
        return (
          Number(nonNullCircle.created_ledger) +
          (roundIndex + 1) * Number(nonNullCircle.round_deadline_ledgers)
        );
      };

      const annotate = <C extends { round_index: number }, D extends { round_index: number }>(
        r: import("./groupRounds").GroupedRound<C, D>,
      ) => ({ ...r, deadlineLedger: computeDeadlineLedger(r.roundIndex) });

      res.json({
        rounds: rounds.map(annotate),
        currentRound: currentRound ? annotate(currentRound) : null,
        // Unpaid non-current rounds that still have activity (rare, but
        // previously invisible to clients).
        openRounds: openRounds.map(annotate),
        pendingDefaults,
      });
    } catch (err) {
      console.error(`[api] Failed to load rounds for circle ${redactAddress(address)}`, err);
      sendError(res, 500, "Failed to load circle rounds", getErrorMessage(err));
    }
  });

  // ── Member contribution history endpoint (#541) ───────────────────────────────
  //
  // Read-only ledger of every indexed contribution for a member. Unlike
  // /reputation/:member (which returns per-circle counts) and
  // /circles/:address/rounds (which nests contributions under payouts), this
  // endpoint returns the raw contribution rows so clients can build a personal
  // history view without scanning every circle.
  //
  // Optional ?circle=<address> narrows results to one circle. Missing members
  // yield an empty list (not 404) — same convention as /reputation/:member.
  // An unknown ?circle= address is a 404 so callers get a clear signal that
  // the filter itself is invalid rather than a silently empty result.
  //
  // The response includes a `totalAmount` aggregate (sum of all contribution
  // amounts for the queried scope) and a `hasMore` boolean convenience field
  // derived from the pagination envelope so clients can page without computing
  // `page < totalPages` themselves.

  app.get("/members/:member/contributions", historyRateLimiter, async (req: Request, res: Response) => {
    const memberResult = parseAddress(req.params.member, "Member address");
    if (isParseError(memberResult)) {
      res.status(400).json({ error: memberResult.error });
      return;
    }
    const member = memberResult;

    const pageResult = parsePage(req.query.page);
    const limitResult = parseLimit(req.query.limit);
    const circleResult = parseCircleFilter(req.query.circle);

    const errors = [pageResult, limitResult, circleResult]
      .filter(isParseError)
      .map((r) => r.error);

    if (errors.length > 0) {
      res.status(400).json({ error: errors.join("; ") });
      return;
    }

    const page = pageResult as number;
    const limit = limitResult as number;
    const circleFilter = circleResult as string | undefined;
    const offset = (page - 1) * limit;

    try {
      if (circleFilter) {
        const circle = await queryOne<Pick<CircleRow, "address">>(
          `SELECT address FROM circles WHERE address = $1`,
          [circleFilter],
        );
        if (!circle) {
          res.status(404).json({
            error: "Circle not found",
            detail:
              `No circle with address '${circleFilter}' has been indexed yet. ` +
              `The ?circle= filter must reference an address that exists in the indexer.`,
            address: circleFilter,
          });
          return;
        }
      }

      const whereSql = circleFilter
        ? "WHERE c.member_address = $1 AND c.circle_address = $2"
        : "WHERE c.member_address = $1";
      const whereParams: (string | number)[] = circleFilter
        ? [member, circleFilter]
        : [member];

      interface ContribAggRow { count: string; total_amount: string }

      const [contributions, agg] = await Promise.all([
        query<ContributionRow>(
          `SELECT c.circle_address, c.member_address, c.round_index, c.amount::text as amount,
                  c.tx_hash, c.ledger, c.created_at
           FROM contributions c
           ${whereSql}
           ORDER BY c.ledger DESC, c.round_index DESC, c.created_at DESC
           LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}`,
          [...whereParams, limit, offset],
        ),
        queryOne<ContribAggRow>(
          `SELECT COUNT(*) as count, COALESCE(SUM(c.amount), 0)::text as total_amount
           FROM contributions c
           ${whereSql}`,
          whereParams,
        ),
      ]);

      const total = Number(agg?.count ?? 0);
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

      res.json({
        member,
        circle: circleFilter ?? null,
        contributions,
        totalAmount: agg?.total_amount ?? "0",
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasMore: page < totalPages,
        },
      });
    } catch (err) {
      console.error(
        `[api] Failed to load contributions for member ${redactAddress(member)}`,
        err,
      );
      sendError(
        res,
        500,
        "Failed to load member contributions",
        getErrorMessage(err),
      );
    }
  });

  // ── Reputation ───────────────────────────────────────────────────────────────

  app.get("/reputation/:member", detailRateLimiter, async (req: Request, res: Response) => {
    const memberResult = parseAddress(req.params.member, "Member address");
    if (isParseError(memberResult)) {
      res.status(400).json({ error: memberResult.error });
      return;
    }
    const member = memberResult;

    // Optional ?circle=<address> narrows the contributions/defaults
    // breakdown to a single circle, e.g. for a member-in-circle detail view
    // instead of the member's activity across every circle they've joined.
    const circleResult = parseCircleFilter(req.query.circle);
    if (isParseError(circleResult)) {
      res.status(400).json({ error: circleResult.error });
      return;
    }
    const circleFilter = circleResult;

    try {
      const row = await queryOne<ReputationRow>(
        `SELECT * FROM reputation WHERE member_address = $1`,
        [member],
      );
      const contributions = await query<ReputationContributionSummaryRow>(
        `SELECT c.circle_address, COUNT(*) as contributions,
                ci.total_rounds
         FROM contributions c
         JOIN circles ci ON ci.address = c.circle_address
         WHERE c.member_address = $1
         ${circleFilter ? "AND c.circle_address = $2" : ""}
         GROUP BY c.circle_address, ci.total_rounds`,
        circleFilter ? [member, circleFilter] : [member],
      );
      const defaults = await query<ReputationDefaultSummaryRow>(
        `SELECT circle_address, COUNT(*) as count
         FROM defaults WHERE member_address = $1
         ${circleFilter ? "AND circle_address = $2" : ""}
         GROUP BY circle_address`,
        circleFilter ? [member, circleFilter] : [member],
      );

      // A missing reputation row is not an error — it just means this member
      // has no recorded activity yet, so a fresh score of 0 is returned.
      // `found` lets clients distinguish that from a member with a real,
      // explicitly-tracked zero score.
      //
      // COUNT(*) in PostgreSQL always comes back as a string over the wire;
      // cast to number here so the JSON response shape matches the declared
      // ApiReputationResponse type in sdk/src/types.ts.
      res.json({
        member,
        found: row != null,
        // When `found` is false, the member has no recorded reputation activity
        // yet. This means either no reputation/increment event has been emitted
        // for this wallet address, or the indexer has not yet processed it.
        // A score of 0 is returned in either case; clients can use `found` to
        // distinguish an untracked wallet from one with an explicit zero score.
        detail: row == null
          ? `Member '${member}' has no reputation record in the indexer. ` +
            `This address has not completed any circle rounds yet, or the ` +
            `reputation/increment event has not been indexed.`
          : undefined,
        score: row?.score ?? 0,
        contributions: contributions.map((c) => ({
          circle_address: c.circle_address,
          contributions: Number(c.contributions),
          total_rounds: Number(c.total_rounds),
        })),
        defaults: defaults.map((d) => ({
          circle_address: d.circle_address,
          count: Number(d.count),
        })),
        updatedAt: row?.updated_at ?? null,
      });
    } catch (err) {
      console.error(`[api] Failed to load reputation for member ${redactAddress(member)}`, err);
      sendError(res, 500, "Failed to load reputation", getErrorMessage(err));
    }
  });

  // ── Circle audit events ───────────────────────────────────────────────────────
  //
  // Returns the structured audit log for terminal lifecycle transitions
  // (cancelled and closed) for a specific circle.  This is distinct from
  // /indexer/state (which reports aggregate event counts across all circles)
  // and /circles/:address (which returns the summarised status row).
  //
  // Callers can use this endpoint to:
  //   - Display the exact closer address and release amounts in the UI
  //   - Compute penalty forfeitures: total_expected_collateral - total_released
  //   - Audit which member triggered cancellation / closure and when
  //
  // Returns an empty `events` array (not 404) when no audit rows exist yet
  // for the circle, since events may arrive slightly after the status update
  // during indexer replay.

  app.get("/circles/:address/audit", detailRateLimiter, async (req: Request, res: Response) => {
    const addressResult = parseAddress(req.params.address, "Circle address");
    if (isParseError(addressResult)) {
      res.status(400).json({ error: addressResult.error });
      return;
    }
    const address = addressResult;

    try {
      const [circle] = await query<Pick<CircleRow, "address">>(
        `SELECT address FROM circles WHERE address = $1`,
        [address],
      );
      if (!circle) {
        res.status(404).json({ error: `Circle '${address}' not found` });
        return;
      }

      const events = await query<{
        id: number;
        circle_address: string;
        event_type: string;
        triggered_by: string | null;
        ledger: string | null;
        tx_hash: string | null;
        total_released: string | null;
        total_expected_collateral: string | null;
        close_reason: string | null;
        created_at: string;
      }>(
        `SELECT id, circle_address, event_type, triggered_by, ledger, tx_hash,
                total_released, total_expected_collateral, close_reason, created_at
         FROM circle_audit_events
         WHERE circle_address = $1
         ORDER BY created_at ASC`,
        [address],
      );

      res.json({ circle_address: address, events });
    } catch (err) {
      console.error(`[api] Failed to load audit events for circle ${redactAddress(address)}`, err);
      sendError(res, 500, "Failed to load circle audit events", getErrorMessage(err));
    }
  });

  // ── Indexer ──────────────────────────────────────────────────────────────────

  // Audit endpoint for ops/monitoring: reports how far the indexer has
  // progressed and how many events it has ingested per type, independent of
  // /health (which only checks connectivity, not indexing progress).
  app.get("/indexer/state", detailRateLimiter, async (_req: Request, res: Response) => {
    try {
      const [stateRows, eventCountRows, [entityCounts], statusRows] = await Promise.all([
        query<IndexerStateAuditRow>(
          `SELECT last_ledger, updated_at FROM indexer_state WHERE id = 1`,
        ),
        query<EventTypeCountRow>(
          `SELECT event_type, COUNT(*) as count FROM ingested_events GROUP BY event_type`,
        ),
        query<EntityCountsSingleRow>(
          `SELECT
             (SELECT COUNT(*) FROM circles)::text AS circles,
             (SELECT COUNT(*) FROM circle_members)::text AS members,
             (SELECT COUNT(*) FROM contributions)::text AS contributions,
             (SELECT COUNT(*) FROM payouts)::text AS payouts,
             (SELECT COUNT(*) FROM defaults)::text AS defaults`,
        ),
        query<CircleStatusCountRow>(
          `SELECT status, COUNT(*) as count FROM circles GROUP BY status`,
        ),
      ]);

      const state = stateRows[0] ?? null;
      if (!state) {
        sendError(res, 500, "Indexer state has not been initialized");
        return;
      }

      const eventCounts: Record<string, number> = {};
      let totalEvents = 0;
      for (const row of eventCountRows) {
        const count = Number(row.count);
        totalEvents += count;
        eventCounts[row.event_type ?? "unknown"] = count;
      }

      const circlesByStatus: Record<string, number> = {};
      for (const row of statusRows) {
        circlesByStatus[row.status] = Number(row.count);
      }

      res.json({
        lastLedger: Number(state.last_ledger),
        updatedAt: state.updated_at,
        totalEvents,
        eventCounts,
        entityCounts: {
          circles: Number(entityCounts?.circles ?? 0),
          members: Number(entityCounts?.members ?? 0),
          contributions: Number(entityCounts?.contributions ?? 0),
          payouts: Number(entityCounts?.payouts ?? 0),
          defaults: Number(entityCounts?.defaults ?? 0),
          circlesByStatus,
        },
      });
    } catch (err) {
      console.error("[api] Failed to load indexer state", err);
      sendError(res, 500, "Failed to load indexer state", getErrorMessage(err));
    }
  });

  // Operational health endpoint: exposes poll-cycle metrics, backoff state,
  // and event processing counts for monitoring dashboards and alerting.
  app.get("/indexer/health", detailRateLimiter, async (_req: Request, res: Response) => {
    try {
      const metrics = getIndexerMetrics();
      const running = isIndexerRunning();

      // Determine overall status: degraded if backoff is elevated, healthy otherwise
      const status = metrics.backoffConsecutiveFailures > 0 ? "degraded" : "ok";

      res.status(status === "ok" ? 200 : 503).json({
        status,
        running,
        events: {
          processed: metrics.totalEventsProcessed,
          failed: metrics.totalEventsFailed,
          skipped: metrics.totalEventsSkipped,
          retried: metrics.totalEventsRetried,
        },
        pollCycles: {
          completed: metrics.pollCyclesCompleted,
          failed: metrics.pollCyclesFailed,
        },
        lastPoll: {
          durationMs: metrics.lastPollDurationMs,
          ledgerRange: metrics.lastPollLedgerRange,
        },
        backoff: {
          consecutiveFailures: metrics.backoffConsecutiveFailures,
          currentIntervalMs: metrics.backoffCurrentIntervalMs,
        },
      });
    } catch (err) {
      console.error("[api] Failed to load indexer health", err);
      sendError(res, 500, "Failed to load indexer health", getErrorMessage(err));
    }
  });

  // Events the indexer skipped because their handler failed, and which have
  // not since been re-ingested or acknowledged.  Rows carry the event's
  // identity (RPC event id, ledger, tx hash, contract, type) and a redacted
  // error — never the event payload.  See docs/INDEXER_RELIABILITY.md for the
  // safe reprocessing path.
  app.get("/indexer/failures", detailRateLimiter, async (req: Request, res: Response) => {
    const limitResult = parseLimit(req.query.limit);
    if (isParseError(limitResult)) {
      sendError(res, 400, limitResult.error);
      return;
    }

    let ledger: number | undefined;
    if (req.query.ledger !== undefined) {
      const n = Number(req.query.ledger);
      if (!Number.isInteger(n) || n < 0) {
        sendError(res, 400, "ledger must be a non-negative integer");
        return;
      }
      ledger = n;
    }

    let eventId: string | undefined;
    if (req.query.eventId !== undefined) {
      if (typeof req.query.eventId !== "string" || !/^[0-9A-Za-z:_-]{1,200}$/.test(req.query.eventId)) {
        sendError(res, 400, "eventId must be an RPC event id");
        return;
      }
      eventId = req.query.eventId;
    }

    try {
      const failures = await listOpenEventFailures({ ledger, eventId, limit: limitResult });
      res.json({ failures, count: failures.length, limit: limitResult });
    } catch (err) {
      if (isUndefinedTable(err)) {
        sendError(res, 503, "event_failures table is missing — run migrations");
        return;
      }
      console.error("[api] Failed to load event failures", err);
      sendError(res, 500, "Failed to load event failures", getErrorMessage(err));
    }
  });

  // Exposes the full migration history for ops and diagnostics: which migrations
  // have been applied, which are pending, and whether the schema is clean.
  app.get("/indexer/schema", detailRateLimiter, async (_req: Request, res: Response) => {
    try {
      const { checkMigrationHealth } = await import("./db/migrate");
      const health = await checkMigrationHealth();
      res.json({
        state: health.state,
        summary: health.summary,
        canStartSafely: health.canStartSafely,
        currentVersion: health.status.currentVersion,
        applied: health.status.applied,
        pending: health.status.pending,
        missingOnDisk: health.status.missingOnDisk,
        modified: health.status.modified,
      });
    } catch (err) {
      console.error("[api] Failed to load schema status", err);
      sendError(res, 500, "Failed to load schema status", getErrorMessage(err));
    }
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const message = getErrorMessage(err);
    logApiRequestError({
      method: req.method,
      path: req.originalUrl || req.url,
      statusCode: 500,
      error: message,
    });
    console.error("[api] Unhandled error", err);
    sendError(res, 500, "Internal server error", message);
  });

  return app;
}
