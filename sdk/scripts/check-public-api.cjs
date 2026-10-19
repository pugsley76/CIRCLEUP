#!/usr/bin/env node
/**
 * Release check for the @circleup/sdk public API.
 *
 * Run after a clean build (`npm run check:api` does both). It fails when:
 *
 *   1. a symbol that the docs or examples import from "@circleup/sdk" is not
 *      exported by the built root declaration (dist/index.d.ts);
 *   2. a helper that is internal by design is exported from the root;
 *   3. a consumer in this repo, or a doc, imports a deep path such as
 *      "@circleup/sdk/dist/client";
 *   4. test code was emitted into dist/;
 *   5. package.json "exports" exposes anything beyond the root entry point.
 *
 * Every problem is reported at once, and the exit code is non-zero if any were found.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const SDK_DIR = path.resolve(__dirname, "..");
const REPO_DIR = path.resolve(SDK_DIR, "..");
const DIST_ENTRY = path.join(SDK_DIR, "dist", "index.d.ts");

/** Exported from client.ts for unit tests only — never part of the root API. */
const INTERNAL_ONLY = ["isTransientRpcError", "withRpcRetry", "mayHaveReachedServer"];

/** Markdown and TypeScript files whose `@circleup/sdk` imports are documentation. */
const DOC_SOURCES = [
  "README.md",
  "QUICK_REFERENCE.md",
  "sdk/CONTRACT_FIXTURES.md",
  "docs",
  "sdk/examples",
];

/**
 * Docs whose imports are illustrative rather than real API — the deprecation
 * policy walks through a hypothetical `formatUsdcLegacy` symbol.
 */
const ILLUSTRATIVE_DOCS = new Set(["docs/DEPRECATION_POLICY.md"]);

/** Consumer code scanned for deep imports. */
const CONSUMER_SOURCES = ["app/src", "scripts/src", "indexer/src", "tests", "sdk/examples"];

const problems = [];

// ── Helpers ──────────────────────────────────────────────────────────────────

function listFiles(rel, exts) {
  const abs = path.join(REPO_DIR, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const child = path.posix.join(rel.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) out.push(...listFiles(child, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(child);
  }
  return out;
}

function read(rel) {
  return fs.readFileSync(path.join(REPO_DIR, rel), "utf8");
}

/** Names imported from the package root, e.g. `import { a, type B as C } from "@circleup/sdk"`. */
function rootImports(text) {
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@circleup\/sdk["']/g;
  const names = [];
  let m;
  while ((m = re.exec(text))) {
    m[1]
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
      .filter(Boolean)
      .forEach((n) => names.push(n));
  }
  return names;
}

/** Every name exported by the built root declaration, resolved through `export *`. */
function builtExports() {
  const program = ts.createProgram([DIST_ENTRY], {
    noEmit: true,
    skipLibCheck: true,
    moduleResolution: ts.ModuleResolutionKind.Node10,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(DIST_ENTRY);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!moduleSymbol) return null;
  return new Set(checker.getExportsOfModule(moduleSymbol).map((s) => s.getName()));
}

// ── 1 & 2. Root exports vs docs, and internal helpers ────────────────────────

if (!fs.existsSync(DIST_ENTRY)) {
  problems.push(`dist/index.d.ts is missing — run "npm run build" first.`);
} else {
  const exported = builtExports();
  if (!exported) {
    problems.push("could not read the exports of dist/index.d.ts.");
  } else {
    for (const rel of DOC_SOURCES.flatMap((s) => listFiles(s, [".md", ".ts"]))) {
      if (ILLUSTRATIVE_DOCS.has(rel)) continue;
      for (const name of new Set(rootImports(read(rel)))) {
        if (!exported.has(name)) {
          problems.push(`${rel} imports "${name}" from "@circleup/sdk", but the root does not export it.`);
        }
      }
    }
    for (const name of INTERNAL_ONLY) {
      if (exported.has(name)) {
        problems.push(`internal helper "${name}" is exported from the package root.`);
      }
    }
    console.log(`Root exports: ${exported.size} symbols.`);
  }
}

// ── 3. Deep imports ──────────────────────────────────────────────────────────

const DEEP_IMPORT_RE = /(?:from\s*|require\(\s*|import\(\s*)["']@circleup\/sdk\/(?!package\.json)[^"']*["']/g;
for (const rel of [
  ...CONSUMER_SOURCES.flatMap((s) => listFiles(s, [".ts", ".tsx", ".js", ".mjs", ".cjs"])),
  ...DOC_SOURCES.flatMap((s) => listFiles(s, [".md"])),
]) {
  const text = read(rel);
  let m;
  while ((m = DEEP_IMPORT_RE.exec(text))) {
    const line = text.slice(0, m.index).split("\n").length;
    problems.push(`${rel}:${line} uses a deep import (${m[0]}); import from "@circleup/sdk" instead.`);
  }
}

// ── 4. Test code in dist ─────────────────────────────────────────────────────

const distDir = path.join(SDK_DIR, "dist");
if (fs.existsSync(distDir)) {
  for (const rel of listFiles(path.relative(REPO_DIR, distDir), [""])) {
    if (/(^|\/)__tests__(\/|$)|\.test\.(js|d\.ts|js\.map|d\.ts\.map)$/.test(rel)) {
      problems.push(`${rel} is test code and must not be published.`);
    }
  }
}

// ── 5. package.json entry points ─────────────────────────────────────────────

const pkg = JSON.parse(fs.readFileSync(path.join(SDK_DIR, "package.json"), "utf8"));
const allowedEntries = new Set([".", "./package.json"]);
if (!pkg.exports || typeof pkg.exports !== "object") {
  problems.push(`package.json has no "exports" map, so every file in dist/ is importable.`);
} else {
  for (const key of Object.keys(pkg.exports)) {
    if (!allowedEntries.has(key)) {
      problems.push(`package.json "exports" advertises "${key}"; only the root entry point is stable.`);
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

if (problems.length > 0) {
  console.error(`Public API check failed (${problems.length} problem${problems.length === 1 ? "" : "s"}):`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}
console.log("Public API check passed.");
