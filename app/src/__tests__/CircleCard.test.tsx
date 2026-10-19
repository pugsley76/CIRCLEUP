import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/config", () => ({
  shortAddress: (addr: string) =>
    addr && addr.length >= 8 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr,
  formatUsdc: (stroops: bigint) => {
    const STROOP = 10_000_000n;
    const whole = stroops / STROOP;
    const frac = (stroops % STROOP).toString().padStart(7, "0").slice(0, 2);
    return `${whole}.${frac}`;
  },
  formatPot: (stroops: bigint, count: number) => {
    const STROOP = 10_000_000n;
    const total = stroops * BigInt(count);
    const whole = total / STROOP;
    const frac = (total % STROOP).toString().padStart(7, "0").slice(0, 2);
    return `${whole}.${frac}`;
  },
}));

// next/link mock: render as plain anchor
vi.mock("next/link", () => ({
  default: ({ href, children, className, "aria-label": ariaLabel }: any) => (
    <a href={href} className={className} aria-label={ariaLabel}>{children}</a>
  ),
}));

import { CircleCard, getStatusMeta, type Circle } from "@/components/CircleCard";

const baseCircle: Circle = {
  address: "CCIRCLE111111111111111111111111111111111111111111111111111",
  creator: "GCREATOR11111111111111111111111111111111111111111111111111",
  round_amount: "100000000", // $10.00
  member_count: 4,
  status: "Active",
  current_round: 2,
  total_rounds: 8,
  created_ledger: 1000,
};

describe("CircleCard — rendering", () => {
  it("renders round amount formatted as USDC", () => {
    render(<CircleCard circle={baseCircle} />);
    expect(screen.getByText(/\$10\.00 \/ round/)).toBeInTheDocument();
  });

  it("renders member count", () => {
    render(<CircleCard circle={baseCircle} />);
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("renders progress bar with correct aria-valuenow", () => {
    render(<CircleCard circle={baseCircle} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "25"); // 2/8 = 25%
  });

  it("links to the circle detail page", () => {
    render(<CircleCard circle={baseCircle} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", `/circles/${baseCircle.address}`);
  });
});

describe("CircleCard — status chip", () => {
  it.each([
    ["Active", /Active/],
    ["Pending", /Pending/],
    ["Completed", /Completed/],
    ["Cancelled", /Cancelled/],
    ["Closed", /Closed/],
  ])("renders %s status chip", (status, pattern) => {
    render(<CircleCard circle={{ ...baseCircle, status }} />);
    expect(screen.getByText(pattern)).toBeInTheDocument();
  });

  it("falls back gracefully for unknown status", () => {
    render(<CircleCard circle={{ ...baseCircle, status: "Weird" }} />);
    expect(screen.getByText("Weird")).toBeInTheDocument();
  });

  it("unknown status chip has accessible description mentioning unrecognized", () => {
    render(<CircleCard circle={{ ...baseCircle, status: "Weird" }} />);
    const chip = document.querySelector('span[aria-label^="Status: Weird"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("aria-label")).toMatch(/Unrecognized/i);
  });

  it("Closed status chip is visually distinct (slate, not a primary color)", () => {
    render(<CircleCard circle={{ ...baseCircle, status: "Closed" }} />);
    // The chip span carries aria-label "Status: Closed. ..." — target it directly
    const chip = document.querySelector('span[aria-label^="Status: Closed"]');
    expect(chip).not.toBeNull();
    expect(chip?.className).toMatch(/slate/);
  });

  it("Completed status chip uses green (success semantics)", () => {
    render(<CircleCard circle={{ ...baseCircle, status: "Completed" }} />);
    const chip = document.querySelector('span[aria-label^="Status: Completed"]');
    expect(chip).not.toBeNull();
    expect(chip?.className).toMatch(/green/);
  });
});

describe("CircleCard — input guards", () => {
  it("shows 0.00 for invalid round_amount instead of crashing", () => {
    render(<CircleCard circle={{ ...baseCircle, round_amount: "not-a-number" }} />);
    expect(screen.getByText(/\$0\.00 \/ round/)).toBeInTheDocument();
  });

  it("shows 0.00 pot when member_count is 0", () => {
    render(<CircleCard circle={{ ...baseCircle, member_count: 0 }} />);
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("omits progress bar when total_rounds is 0", () => {
    render(<CircleCard circle={{ ...baseCircle, total_rounds: 0, current_round: 0 }} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("clamps negative current_round to 0", () => {
    render(<CircleCard circle={{ ...baseCircle, current_round: -1, total_rounds: 4 }} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
  });
});

describe("CircleCard — accessibility", () => {
  it("link has descriptive aria-label including amount and status", () => {
    render(<CircleCard circle={baseCircle} />);
    const link = screen.getByRole("link");
    const label = link.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/\$10\.00/);
    expect(label).toMatch(/Active/);
  });

  it("round fraction reads as screen-reader-friendly text", () => {
    render(<CircleCard circle={baseCircle} />);
    expect(screen.getByText(/Round 2 of 8/)).toBeInTheDocument();
  });
});

describe("getStatusMeta", () => {
  it("is case-insensitive", () => {
    expect(getStatusMeta("ACTIVE").label).toBe("Active");
    expect(getStatusMeta("active").label).toBe("Active");
    expect(getStatusMeta("Active").label).toBe("Active");
  });

  it("returns known meta for all 5 valid statuses", () => {
    expect(getStatusMeta("Pending").label).toBe("Pending");
    expect(getStatusMeta("Active").label).toBe("Active");
    expect(getStatusMeta("Completed").label).toBe("Completed");
    expect(getStatusMeta("Cancelled").label).toBe("Cancelled");
    expect(getStatusMeta("Closed").label).toBe("Closed");
  });

  it("Closed has slate chip classes (visually de-emphasized)", () => {
    expect(getStatusMeta("Closed").chipClasses).toMatch(/slate/);
  });

  it("Completed uses green chip classes (success semantics)", () => {
    expect(getStatusMeta("Completed").chipClasses).toMatch(/green/);
  });

  it("returns unknown fallback for unrecognised status", () => {
    const meta = getStatusMeta("bogus");
    expect(meta.label).toBe("bogus");
    expect(meta.chipClasses).toMatch(/slate/);
    // Description should mention unrecognized so it's diagnosable
    expect(meta.description).toMatch(/Unrecognized/i);
  });

  it("returns explicit Unknown label for empty string", () => {
    const meta = getStatusMeta("");
    expect(meta.label).toBe("Unknown");
  });
});
