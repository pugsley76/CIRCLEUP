import { pool } from "./pool";

/**
 * Runs EXPLAIN ANALYZE against the API's frequent query shapes so the
 * indexes added alongside this file can be re-verified after schema changes.
 * Picks the busiest circle/member from the connected DB so the plans reflect
 * actual data volume instead of an always-empty placeholder.
 *
 * Output, in order:
 *   1. Table cardinalities (row counts and per-circle / per-member fan-out),
 *      so a plan can be judged against the data it ran on.
 *   2. One summary line per query: total planner cost, execution time, and
 *      the scan/sort nodes used — the reproducible baseline recorded in
 *      docs/QUERY_PLANS.md.
 *   3. A note for any query whose plan does not use the index it is expected
 *      to use. On small tables a sequential scan is often the correct choice,
 *      so this is advisory, not a failure.
 *
 * Run directly: npm run explain --workspace=indexer
 * Flags:
 *   --text   also print the full text plan for each query
 */

interface ExplainQuery {
  label: string;
  sql: string;
  params: unknown[];
  /** Index the plan is expected to use once the table is non-trivial. */
  expectIndex?: string;
}

function buildQueries(circleAddress: string, memberAddress: string): ExplainQuery[] {
  return [
    {
      label: "GET /circles (list, ordered by created_ledger)",
      sql: `SELECT address, creator, round_amount, member_count, status,
                   current_round, total_rounds, created_ledger, updated_at
            FROM circles ORDER BY created_ledger DESC LIMIT 20 OFFSET 0`,
      params: [],
      expectIndex: "idx_circles_created_ledger",
    },
    {
      label: "GET /circles?status=... (status filter + created_ledger sort)",
      sql: `SELECT address, creator, round_amount, member_count, status,
                   current_round, total_rounds, created_ledger, updated_at
            FROM circles WHERE status = $1 ORDER BY created_ledger DESC LIMIT 20 OFFSET 0`,
      params: ["Active"],
      expectIndex: "idx_circles_status_created_ledger",
    },
    {
      label: "GET /circles/summary (status aggregate)",
      sql: `SELECT status, COUNT(*) as count FROM circles GROUP BY status`,
      params: [],
    },
    {
      label: "GET /circles/:address (circle row)",
      sql: `SELECT * FROM circles WHERE address = $1`,
      params: [circleAddress],
      expectIndex: "circles_address_key",
    },
    {
      label: "GET /circles/:address — members",
      sql: `SELECT cm.*, r.score as reputation_score
            FROM circle_members cm
            LEFT JOIN reputation r ON r.member_address = cm.member_address
            WHERE cm.circle_address = $1
            ORDER BY cm.payout_order`,
      params: [circleAddress],
      expectIndex: "idx_circle_members_circle_address",
    },
    {
      label: "GET /circles/:address/members (per-member contribution count)",
      sql: `SELECT cm.member_address, cm.payout_order,
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
      params: [circleAddress],
      expectIndex: "contributions_circle_address_member_address_round_index_key",
    },
    {
      label: "GET /circles/:address/rounds — contributions",
      sql: `SELECT * FROM contributions WHERE circle_address = $1 ORDER BY round_index, created_at`,
      params: [circleAddress],
      expectIndex: "idx_contributions_circle_round",
    },
    {
      label: "GET /circles/:address/rounds — defaults",
      sql: `SELECT * FROM defaults WHERE circle_address = $1 ORDER BY round_index`,
      params: [circleAddress],
      expectIndex: "idx_defaults_circle_address",
    },
    {
      label: "GET /circles/:address/rounds — payouts",
      sql: `SELECT * FROM payouts WHERE circle_address = $1 ORDER BY round_index`,
      params: [circleAddress],
      expectIndex: "payouts_circle_address_round_index_key",
    },
    {
      label: "GET /circles/:address/audit",
      sql: `SELECT id, circle_address, event_type, triggered_by, ledger, tx_hash,
                   total_released, total_expected_collateral, close_reason, created_at
            FROM circle_audit_events
            WHERE circle_address = $1
            ORDER BY created_at ASC`,
      params: [circleAddress],
    },
    {
      label: "GET /reputation/:member — contributions",
      sql: `SELECT c.circle_address, COUNT(*) as contributions, ci.total_rounds
            FROM contributions c
            JOIN circles ci ON ci.address = c.circle_address
            WHERE c.member_address = $1
            GROUP BY c.circle_address, ci.total_rounds`,
      params: [memberAddress],
      expectIndex: "idx_contributions_member",
    },
    {
      label: "GET /reputation/:member — defaults",
      sql: `SELECT circle_address, COUNT(*) as count
            FROM defaults WHERE member_address = $1 GROUP BY circle_address`,
      params: [memberAddress],
      expectIndex: "idx_defaults_member",
    },
    {
      label: "GET /members/:member/contributions",
      sql: `SELECT c.circle_address, c.member_address, c.round_index, c.amount::text as amount,
                   c.tx_hash, c.ledger, c.created_at
            FROM contributions c
            WHERE c.member_address = $1
            ORDER BY c.ledger DESC, c.round_index DESC, c.created_at DESC
            LIMIT $2 OFFSET $3`,
      params: [memberAddress, 20, 0],
      expectIndex: "idx_contributions_member_ledger",
    },
    {
      label: "GET /members/:member/contributions?circle=... (circle filter)",
      sql: `SELECT c.circle_address, c.member_address, c.round_index, c.amount::text as amount,
                   c.tx_hash, c.ledger, c.created_at
            FROM contributions c
            WHERE c.member_address = $1 AND c.circle_address = $2
            ORDER BY c.ledger DESC, c.round_index DESC, c.created_at DESC
            LIMIT $3 OFFSET $4`,
      params: [memberAddress, circleAddress, 20, 0],
      expectIndex: "idx_contributions_member_circle_ledger",
    },
  ];
}

// Picks the circle/member with the most contribution rows so the sample query
// is representative rather than hitting an empty result set.
async function pickSampleAddresses(): Promise<{
  circleAddress: string;
  memberAddress: string;
}> {
  const { rows: circleRows } = await pool.query<{ address: string }>(
    `SELECT c.address
     FROM circles c
     LEFT JOIN contributions co ON co.circle_address = c.address
     GROUP BY c.address
     ORDER BY COUNT(co.id) DESC, c.address
     LIMIT 1`,
  );
  const { rows: memberRows } = await pool.query<{ member_address: string }>(
    `SELECT cm.member_address
     FROM circle_members cm
     LEFT JOIN contributions co ON co.member_address = cm.member_address
     GROUP BY cm.member_address
     ORDER BY COUNT(co.id) DESC, cm.member_address
     LIMIT 1`,
  );

  return {
    circleAddress: circleRows[0]?.address ?? "GNO_CIRCLES_IN_DB",
    memberAddress: memberRows[0]?.member_address ?? "GNO_MEMBERS_IN_DB",
  };
}

// Row counts plus the fan-out the per-circle / per-member queries see. These
// are the cardinalities the plans in docs/QUERY_PLANS.md must be read against.
async function printCardinalities(): Promise<void> {
  const { rows: [counts] } = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT COUNT(*) FROM circles)::text              AS circles,
       (SELECT COUNT(*) FROM circle_members)::text       AS circle_members,
       (SELECT COUNT(*) FROM contributions)::text        AS contributions,
       (SELECT COUNT(*) FROM payouts)::text              AS payouts,
       (SELECT COUNT(*) FROM defaults)::text             AS defaults,
       (SELECT COUNT(*) FROM circle_audit_events)::text  AS circle_audit_events,
       (SELECT COUNT(DISTINCT status) FROM circles)::text AS distinct_statuses,
       (SELECT COALESCE(MAX(n), 0) FROM (SELECT COUNT(*) AS n FROM contributions GROUP BY circle_address) s)::text
         AS max_contributions_per_circle,
       (SELECT COALESCE(MAX(n), 0) FROM (SELECT COUNT(*) AS n FROM contributions GROUP BY member_address) s)::text
         AS max_contributions_per_member`,
  );
  console.log("[explain] Cardinalities:");
  for (const [key, value] of Object.entries(counts ?? {})) {
    console.log(`  ${key.padEnd(30)} ${value}`);
  }
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Total Cost": number;
  Plans?: PlanNode[];
}

interface ExplainJson {
  Plan: PlanNode;
  "Execution Time": number;
}

/** Flatten a plan tree into short node descriptions, e.g. "Index Scan using idx_x". */
function describeNodes(node: PlanNode, out: string[] = []): string[] {
  const type = node["Node Type"];
  if (node["Index Name"]) {
    out.push(`${type} using ${node["Index Name"]}`);
  } else if (node["Relation Name"]) {
    out.push(`${type} on ${node["Relation Name"]}`);
  } else if (type === "Sort" || type === "Incremental Sort") {
    out.push(type);
  }
  for (const child of node.Plans ?? []) describeNodes(child, out);
  return out;
}

async function main() {
  const printText = process.argv.includes("--text");
  const { circleAddress, memberAddress } = await pickSampleAddresses();
  console.log(
    `[explain] Using sample circle=${circleAddress} member=${memberAddress}`,
  );
  await printCardinalities();

  const notes: string[] = [];
  for (const { label, sql, params, expectIndex } of buildQueries(circleAddress, memberAddress)) {
    const { rows } = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      params,
    );
    const [result] = rows[0]["QUERY PLAN"] as ExplainJson[];
    const nodes = describeNodes(result.Plan);

    console.log(`\n=== ${label} ===`);
    console.log(
      `  cost=${result.Plan["Total Cost"].toFixed(2)} ` +
      `time=${result["Execution Time"].toFixed(3)}ms ` +
      `nodes=[${nodes.join(", ")}]`,
    );

    if (expectIndex && !nodes.some((n) => n.includes(expectIndex))) {
      notes.push(`${label}: expected ${expectIndex}, plan used [${nodes.join(", ")}]`);
    }

    if (printText) {
      const { rows: textRows } = await pool.query(`EXPLAIN (ANALYZE, FORMAT TEXT) ${sql}`, params);
      console.log(textRows.map((r) => r["QUERY PLAN"]).join("\n"));
    }
  }

  if (notes.length > 0) {
    console.log(
      "\n[explain] Plans not using their expected index (expected on small " +
      "tables; investigate if the table is large):",
    );
    for (const note of notes) console.log(`  - ${note}`);
  }
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[explain] Error:", err);
    process.exit(1);
  });
}
