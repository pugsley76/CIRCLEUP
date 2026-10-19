import { describe, it, expect } from "vitest";

import {
  CircleStatus,
  ALL_CIRCLE_STATUSES,
  normalizeCircleStatus,
  isKnownCircleStatus,
  getCircleStatusMeta,
  type CircleStatusPresentation,
} from "./circleStatus";

// ─── Supported values ─────────────────────────────────────────────────────────

const SUPPORTED: Record<CircleStatus, Partial<CircleStatusPresentation>> = {
  Pending: { label: "Pending", chipClasses: "bg-yellow-100", dotClasses: "bg-yellow-500" },
  Active:  { label: "Active",  chipClasses: "bg-brand-100",  dotClasses: "bg-brand-500" },
  Completed: { label: "Completed", chipClasses: "bg-green-100", dotClasses: "bg-green-500" },
  Cancelled: { label: "Cancelled", chipClasses: "bg-red-100", dotClasses: "bg-red-400" },
  Closed:  { label: "Closed",  chipClasses: "bg-slate-100", dotClasses: "bg-slate-400" },
};

describe("circleStatus — supported values", () => {
  it("exposes all five contract + indexer statuses", () => {
    expect(ALL_CIRCLE_STATUSES).toEqual([
      "Pending", "Active", "Completed", "Cancelled", "Closed",
    ]);
  });

  it.each(Object.keys(SUPPORTED) as CircleStatus[])("renders %s consistently", (status) => {
    const meta = getCircleStatusMeta(status);
    expect(meta.label).toBe(SUPPORTED[status].label);
    expect(meta.chipClasses).toContain(SUPPORTED[status].chipClasses);
    expect(meta.dotClasses).toContain(SUPPORTED[status].dotClasses);
    expect(typeof meta.description).toBe("string");
    expect(meta.description.length).toBeGreaterThan(0);
  });

  it("is case-insensitive for every supported status", () => {
    for (const status of ALL_CIRCLE_STATUSES) {
      expect(getCircleStatusMeta(status.toUpperCase()).label).toBe(status);
      expect(getCircleStatusMeta(status.toLowerCase()).label).toBe(status);
      expect(getCircleStatusMeta(` ${status} `).label).toBe(status);
    }
  });

  it("isKnownCircleStatus returns true for supported, false otherwise", () => {
    for (const status of ALL_CIRCLE_STATUSES) {
      expect(isKnownCircleStatus(status)).toBe(true);
    }
    expect(isKnownCircleStatus("bogus")).toBe(false);
    expect(isKnownCircleStatus("")).toBe(false);
    expect(isKnownCircleStatus(null)).toBe(false);
    expect(isKnownCircleStatus(undefined)).toBe(false);
    expect(isKnownCircleStatus(123)).toBe(false);
  });
});

// ─── Unknown values ───────────────────────────────────────────────────────────

describe("circleStatus — unknown values (safe fallback)", () => {
  it("preserves the raw value as the label for an unrecognised status", () => {
    const meta = getCircleStatusMeta("WeirdStatus");
    expect(meta.label).toBe("WeirdStatus");
    expect(meta.chipClasses).toContain("slate");
    expect(meta.dotClasses).toContain("slate");
  });

  it("describes an unrecognised status as unrecognized", () => {
    const meta = getCircleStatusMeta("bogus");
    expect(meta.description).toMatch(/Unrecognized/i);
    expect(meta.description).toContain("bogus");
  });

  it("returns an explicit Unknown label for empty string", () => {
    expect(getCircleStatusMeta("").label).toBe("Unknown");
    expect(getCircleStatusMeta("  ").label).toBe("Unknown");
  });

  it("returns an explicit Unknown label for null / undefined / non-strings", () => {
    expect(getCircleStatusMeta(null).label).toBe("Unknown");
    expect(getCircleStatusMeta(undefined).label).toBe("Unknown");
    expect(getCircleStatusMeta(null).description).toMatch(/Unrecognized/i);
  });

  it("never returns a known-status presentation for an unknown value", () => {
    const labels = new Set(ALL_CIRCLE_STATUSES.map((s) => getCircleStatusMeta(s).label));
    expect(labels.has(getCircleStatusMeta("bogus").label)).toBe(false);
  });
});
