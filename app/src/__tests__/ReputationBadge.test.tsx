import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ReputationBadge,
  ReputationLegend,
  getLevel,
  REPUTATION_LEVELS,
  TIER_THRESHOLD_NEW,
  TIER_THRESHOLD_STARTER,
  TIER_THRESHOLD_RELIABLE,
  TIER_THRESHOLD_TRUSTED,
  TIER_THRESHOLD_LEGEND,
} from "@/components/ReputationBadge";

// ─── getLevel — deterministic threshold boundaries ────────────────────────────

describe("getLevel — tier boundaries", () => {
  it.each([
    [0, "New"],
    [1, "Starter"],
    [2, "Starter"],
    [3, "Reliable"],
    [5, "Reliable"],
    [6, "Trusted"],
    [9, "Trusted"],
    [10, "Legend"],
    [100, "Legend"],
    [999, "Legend"],
  ])("score %i → %s", (score, expectedLabel) => {
    expect(getLevel(score).label).toBe(expectedLabel);
  });

  it("every tier boundary is covered without gaps (0..12)", () => {
    for (let s = 0; s <= 12; s++) {
      expect(getLevel(s)).toBeDefined();
    }
  });

  // Boundary: the exact threshold value maps to the higher tier, not the lower
  it("score === TIER_THRESHOLD_STARTER (1) maps to Starter, not New", () => {
    expect(getLevel(TIER_THRESHOLD_STARTER).label).toBe("Starter");
  });

  it("score === TIER_THRESHOLD_RELIABLE (3) maps to Reliable, not Starter", () => {
    expect(getLevel(TIER_THRESHOLD_RELIABLE).label).toBe("Reliable");
  });

  it("score === TIER_THRESHOLD_TRUSTED (6) maps to Trusted, not Reliable", () => {
    expect(getLevel(TIER_THRESHOLD_TRUSTED).label).toBe("Trusted");
  });

  it("score === TIER_THRESHOLD_LEGEND (10) maps to Legend, not Trusted", () => {
    expect(getLevel(TIER_THRESHOLD_LEGEND).label).toBe("Legend");
  });

  it("score one below TIER_THRESHOLD_STARTER (0) maps to New", () => {
    expect(getLevel(TIER_THRESHOLD_STARTER - 1).label).toBe("New");
  });

  it("score one below TIER_THRESHOLD_RELIABLE (2) maps to Starter", () => {
    expect(getLevel(TIER_THRESHOLD_RELIABLE - 1).label).toBe("Starter");
  });

  it("score one below TIER_THRESHOLD_TRUSTED (5) maps to Reliable", () => {
    expect(getLevel(TIER_THRESHOLD_TRUSTED - 1).label).toBe("Reliable");
  });

  it("score one below TIER_THRESHOLD_LEGEND (9) maps to Trusted", () => {
    expect(getLevel(TIER_THRESHOLD_LEGEND - 1).label).toBe("Trusted");
  });
});

// ─── getLevel — unknown / invalid / negative scores ──────────────────────────

describe("getLevel — unknown and negative scores", () => {
  it("null score returns Unknown tier", () => {
    expect(getLevel(null).label).toBe("Unknown");
  });

  it("undefined score returns Unknown tier", () => {
    expect(getLevel(undefined).label).toBe("Unknown");
  });

  it("negative score (-1) returns Unknown tier, not New", () => {
    expect(getLevel(-1).label).toBe("Unknown");
  });

  it("large negative score returns Unknown tier", () => {
    expect(getLevel(-999).label).toBe("Unknown");
  });

  it("NaN returns Unknown tier", () => {
    expect(getLevel(NaN).label).toBe("Unknown");
  });

  it("Unknown tier is not included in REPUTATION_LEVELS", () => {
    // Unknown is a sentinel; it must not appear in the legend or tier list
    const labels = REPUTATION_LEVELS.map((t) => t.label);
    expect(labels).not.toContain("Unknown");
  });

  it("Unknown tier is visually distinct (not a positive-looking colour)", () => {
    const unknown = getLevel(null);
    // The colour class must not be one of the positive tier colours
    const positiveTierColors = REPUTATION_LEVELS.map((t) => t.color);
    expect(positiveTierColors).not.toContain(unknown.color);
  });
});

// ─── ReputationBadge — rendering ─────────────────────────────────────────────

describe("ReputationBadge — rendering", () => {
  it("renders score number", () => {
    render(<ReputationBadge score={7} />);
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("renders the correct tier label", () => {
    render(<ReputationBadge score={7} />);
    expect(screen.getByText("Trusted")).toBeInTheDocument();
  });

  it("applies sm size class", () => {
    const { container } = render(<ReputationBadge score={3} size="sm" />);
    expect(container.firstChild).toHaveClass("text-xs");
  });

  it("applies lg size class", () => {
    const { container } = render(<ReputationBadge score={3} size="lg" />);
    expect(container.firstChild).toHaveClass("text-base");
  });

  it("renders a shape marker (non-colour distinction) alongside the label", () => {
    const { container } = render(<ReputationBadge score={7} />);
    // At least one child span carries a shape marker (marker is a Unicode symbol)
    const markerSpans = Array.from(container.querySelectorAll("span[aria-hidden='true']"))
      .map((el) => el.textContent ?? "");
    // The marker for "Trusted" is "◕"
    expect(markerSpans).toContain("◕");
  });

  it("each tier has a unique non-colour marker", () => {
    const markers = REPUTATION_LEVELS.map((t) => t.marker);
    const uniqueMarkers = new Set(markers);
    expect(uniqueMarkers.size).toBe(REPUTATION_LEVELS.length);
  });
});

// ─── ReputationBadge — unknown/negative score rendering ───────────────────────

describe("ReputationBadge — unknown and negative scores", () => {
  it("null score renders Unknown label, not a positive tier label", () => {
    render(<ReputationBadge score={null} />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    // Must not render any positive tier label
    for (const tier of REPUTATION_LEVELS) {
      expect(screen.queryByText(tier.label)).not.toBeInTheDocument();
    }
  });

  it("undefined score renders Unknown label", () => {
    render(<ReputationBadge score={undefined} />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });

  it("negative score renders Unknown label, not New", () => {
    render(<ReputationBadge score={-5} />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.queryByText("New")).not.toBeInTheDocument();
  });

  it("null score shows '—' as the numeric display, not '0' or 'null'", () => {
    render(<ReputationBadge score={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("negative score shows '—' as the numeric display", () => {
    render(<ReputationBadge score={-1} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("unknown score aria-label communicates unavailability, not a tier", () => {
    render(<ReputationBadge score={null} />);
    const badge = screen.getByRole("img");
    const label = badge.getAttribute("aria-label") ?? "";
    expect(label.toLowerCase()).toMatch(/unknown|not available/);
    // Must not claim any positive tier
    for (const tier of REPUTATION_LEVELS) {
      expect(label).not.toMatch(new RegExp(tier.label, "i"));
    }
  });
});

// ─── ReputationBadge — large scores ──────────────────────────────────────────

describe("ReputationBadge — large scores", () => {
  it("score 999 renders Legend tier", () => {
    render(<ReputationBadge score={999} />);
    expect(screen.getByText("Legend")).toBeInTheDocument();
  });

  it("score 999 renders the numeric score '999'", () => {
    render(<ReputationBadge score={999} />);
    expect(screen.getByText("999")).toBeInTheDocument();
  });
});

// ─── ReputationBadge — accessibility ─────────────────────────────────────────

describe("ReputationBadge — accessibility", () => {
  it("has a meaningful aria-label announcing level and score", () => {
    render(<ReputationBadge score={10} />);
    const badge = screen.getByLabelText(/reputation level: legend, score 10/i);
    expect(badge).toBeInTheDocument();
  });

  it("shape marker is aria-hidden", () => {
    const { container } = render(<ReputationBadge score={1} />);
    const hiddenTexts = Array.from(
      container.querySelectorAll("[aria-hidden='true']")
    ).map((el) => el.textContent ?? "");
    // Starter marker is "◔"
    expect(hiddenTexts).toContain("◔");
  });

  it("score text is aria-hidden (label already announces it)", () => {
    const { container } = render(<ReputationBadge score={5} />);
    const hiddenSpans = Array.from(
      container.querySelectorAll("[aria-hidden='true']")
    ).map((el) => el.textContent ?? "");
    expect(hiddenSpans).toContain("5");
  });
});

// ─── ReputationLegend ─────────────────────────────────────────────────────────

describe("ReputationLegend", () => {
  it("renders all tier labels", () => {
    render(<ReputationLegend />);
    for (const tier of REPUTATION_LEVELS) {
      expect(screen.getAllByText(tier.label).length).toBeGreaterThan(0);
    }
  });

  it("renders tier descriptions", () => {
    render(<ReputationLegend />);
    expect(screen.getByText(/1–2 completed rounds/i)).toBeInTheDocument();
    expect(screen.getByText(/10 or more completed rounds/i)).toBeInTheDocument();
  });

  it("renders score ranges in the legend", () => {
    render(<ReputationLegend />);
    // Reliable tier: 3–5
    expect(screen.getByText("3–5")).toBeInTheDocument();
    // Legend tier: 10+
    expect(screen.getByText("10+")).toBeInTheDocument();
  });

  it("uses a table element for semantic correctness", () => {
    const { container } = render(<ReputationLegend />);
    expect(container.querySelector("table")).toBeInTheDocument();
  });

  it("each tier row shows its unique shape marker", () => {
    const { container } = render(<ReputationLegend />);
    for (const tier of REPUTATION_LEVELS) {
      // markers live in aria-hidden spans inside th cells
      const cells = Array.from(container.querySelectorAll("th, td")).map(
        (el) => el.textContent ?? ""
      );
      const hasMarker = cells.some((text) => text.includes(tier.marker));
      expect(hasMarker, `marker "${tier.marker}" for tier "${tier.label}" not found`).toBe(true);
    }
  });

  it("Unknown tier is not included in the legend", () => {
    render(<ReputationLegend />);
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  });

  // ── Issue #481 — visibility legend and accessibility labeling ─────────────

  it("section is labelled via aria-labelledby pointing at the visible heading", () => {
    const { container } = render(<ReputationLegend />);
    const section = container.querySelector("section");
    expect(section).not.toBeNull();
    // aria-labelledby must reference the heading id, not duplicate via aria-label
    expect(section!.getAttribute("aria-labelledby")).toBe("rep-legend-heading");
    expect(section!.hasAttribute("aria-label")).toBe(false);
  });

  it("section is discoverable as a region landmark named 'Badge levels'", () => {
    render(<ReputationLegend />);
    expect(
      screen.getByRole("region", { name: /badge levels/i })
    ).toBeInTheDocument();
  });

  it("table has visible column headers (not sr-only)", () => {
    const { container } = render(<ReputationLegend />);
    const thead = container.querySelector("thead");
    expect(thead).toBeInTheDocument();
    // Visible headers must NOT carry the sr-only class
    const ths = Array.from(thead!.querySelectorAll("th[scope='col']"));
    expect(ths.length).toBe(3);
    for (const th of ths) {
      expect(th.className).not.toMatch(/\bsr-only\b/);
    }
  });

  it("each data row uses a th[scope='row'] for the tier name", () => {
    const { container } = render(<ReputationLegend />);
    const rowHeaders = Array.from(
      container.querySelectorAll("tbody th[scope='row']")
    );
    // One row header per tier
    expect(rowHeaders.length).toBe(REPUTATION_LEVELS.length);
  });

  it("each row header includes an sr-only tier name for assistive technology", () => {
    const { container } = render(<ReputationLegend />);
    const rowHeaders = Array.from(
      container.querySelectorAll("tbody th[scope='row']")
    );
    const srOnlyTexts = rowHeaders.map((th) => {
      const srSpan = th.querySelector(".sr-only");
      return srSpan?.textContent ?? "";
    });
    for (const tier of REPUTATION_LEVELS) {
      expect(srOnlyTexts).toContain(tier.label);
    }
  });

  it("score range cells carry aria-label for full accessible announcement", () => {
    const { container } = render(<ReputationLegend />);
    const rangeCells = Array.from(
      container.querySelectorAll("tbody td[aria-label]")
    ).filter((el) =>
      (el.getAttribute("aria-label") ?? "").startsWith("Score range:")
    );
    // One per tier row
    expect(rangeCells.length).toBe(REPUTATION_LEVELS.length);
  });

  it("decorative badge span inside each row header is aria-hidden", () => {
    const { container } = render(<ReputationLegend />);
    const rowHeaders = Array.from(
      container.querySelectorAll("tbody th[scope='row']")
    );
    for (const th of rowHeaders) {
      const badgeSpan = th.querySelector("span[aria-hidden='true']");
      expect(badgeSpan).not.toBeNull();
    }
  });
});

// ─── REPUTATION_LEVELS integrity ─────────────────────────────────────────────

describe("REPUTATION_LEVELS structural integrity", () => {
  it("tiers are in ascending order of minScore", () => {
    for (let i = 1; i < REPUTATION_LEVELS.length; i++) {
      expect(REPUTATION_LEVELS[i].minScore).toBeGreaterThan(
        REPUTATION_LEVELS[i - 1].minScore
      );
    }
  });

  it("each tier's maxScore equals the next tier's minScore (no gaps)", () => {
    for (let i = 0; i < REPUTATION_LEVELS.length - 1; i++) {
      expect(REPUTATION_LEVELS[i].maxScore).toBe(
        REPUTATION_LEVELS[i + 1].minScore
      );
    }
  });

  it("the top tier's maxScore is Infinity", () => {
    expect(REPUTATION_LEVELS[REPUTATION_LEVELS.length - 1].maxScore).toBe(Infinity);
  });

  it("each tier has a non-empty unique marker", () => {
    const markers = new Set<string>();
    for (const tier of REPUTATION_LEVELS) {
      expect(tier.marker.length).toBeGreaterThan(0);
      expect(markers.has(tier.marker)).toBe(false);
      markers.add(tier.marker);
    }
  });

  it("exported threshold constants match REPUTATION_LEVELS minScore values", () => {
    expect(TIER_THRESHOLD_NEW).toBe(REPUTATION_LEVELS[0].minScore);
    expect(TIER_THRESHOLD_STARTER).toBe(REPUTATION_LEVELS[1].minScore);
    expect(TIER_THRESHOLD_RELIABLE).toBe(REPUTATION_LEVELS[2].minScore);
    expect(TIER_THRESHOLD_TRUSTED).toBe(REPUTATION_LEVELS[3].minScore);
    expect(TIER_THRESHOLD_LEGEND).toBe(REPUTATION_LEVELS[4].minScore);
  });
});
