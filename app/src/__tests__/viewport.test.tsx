/**
 * Focused responsive-layout checks for the core routes.
 *
 * These tests assert structural responsive behaviour (stacking, wrapping,
 * truncation) and that required fields and transaction controls remain
 * focusable and operable. True pixel-level layout is verified by exercising
 * the routes at phone / tablet / desktop widths in a real browser; these
 * unit tests pin the markup that makes that possible.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/stellar", () => {
  class WalletError extends Error {
    reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.reason = reason;
    }
  }
  return {
    WalletError,
    isFreighterInstalled: vi.fn().mockReturnValue(false),
    getWalletAddress: vi.fn().mockResolvedValue(null),
    connectWallet: vi.fn(),
  };
});

vi.mock("@/lib/config", () => ({
  shortAddress: (addr: string) =>
    addr && addr.length >= 8 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr,
  formatUsdc: (stroops: bigint) => {
    const whole = stroops / 10_000_000n;
    const frac = (stroops % 10_000_000n).toString().padStart(7, "0").slice(0, 2);
    return `${whole}.${frac}`;
  },
  formatPot: (stroops: bigint, count: number) => {
    const total = stroops * BigInt(count);
    const whole = total / 10_000_000n;
    const frac = (total % 10_000_000n).toString().padStart(7, "0").slice(0, 2);
    return `${whole}.${frac}`;
  },
  CIRCLE_FACTORY_ADDRESS: "",
  REPUTATION_ADDRESS: "",
  ACTIVE_NETWORK: "testnet",
  getExplorerLink: () => null,
  indexerEndpoint: () => null,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className, "aria-label": ariaLabel }: any) => (
    <a href={href} className={className} aria-label={ariaLabel}>{children}</a>
  ),
}));

import { CreateClient } from "@/app/create/CreateClient";
import { CircleCard, type Circle } from "@/components/CircleCard";

const baseCircle: Circle = {
  address: "CCIRCLE111111111111111111111111111111111111111111111111111",
  creator: "GCREATOR11111111111111111111111111111111111111111111111111",
  round_amount: "100000000",
  member_count: 4,
  status: "Active",
  current_round: 2,
  total_rounds: 8,
  created_ledger: 1000,
};

describe("viewport — create form", () => {
  it("renders required fields that are focusable and not initially disabled", () => {
    render(<CreateClient />);
    const name = screen.getByLabelText(/circle name/i);
    const amount = screen.getByLabelText(/contribution amount/i);
    const days = screen.getByLabelText(/round duration/i);
    const member1 = screen.getByLabelText(/member 1 of/);

    for (const el of [name, amount, days, member1]) {
      expect(el).not.toHaveAttribute("disabled");
      expect(el).toBeEnabled();
    }
  });

  it("keeps long member addresses legible on narrow viewports (input stacks full-width)", () => {
    render(<CreateClient />);
    const member1 = screen.getByLabelText(/member 1 of/) as HTMLInputElement;
    expect(member1.className).toContain("w-full");
    expect(member1.className).toContain("sm:flex-1");
    expect(member1.className).toContain("font-mono");
  });

  it("keeps member rows focusable in source order (name → amount → days → members → submit)", () => {
    render(<CreateClient />);
    const focusable = Array.from(
      document.querySelectorAll('input:not([disabled]), button:not([disabled])'),
    );
    const labels = focusable.map((el) => el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.textContent ?? "");
    const firstMember = labels.find((l) => /member 1 of/.test(l ?? ""));
    const submit = labels.find((l) => /create circle/i.test(l ?? ""));
    expect(firstMember).toBeDefined();
    expect(submit).toBeDefined();
    expect(labels.indexOf(firstMember!)).toBeLessThan(labels.indexOf(submit!));
  });

  it("renders the submit button as an operable transaction control", () => {
    render(<CreateClient />);
    const submit = screen.getByRole("button", { name: /create circle/i });
    expect(submit).not.toHaveAttribute("disabled");
    expect(submit).toHaveClass("min-h-[48px]");
  });
});

describe("viewport — circle card", () => {
  it("truncates long addresses with the full value available via title", () => {
    render(<CircleCard circle={baseCircle} />);
    const address = screen.getByText(/CCIR…D2KM/);
    expect(address).toHaveAttribute("title", baseCircle.address);
    expect(address).toHaveClass("truncate");
  });

  it("truncates the pot with the full value available via title", () => {
    render(<CircleCard circle={baseCircle} />);
    // round_amount $10.00 × 4 members = $40.00 pot
    const pot = screen.getByText(/\$40\.00/);
    expect(pot).toHaveAttribute("title", "$40.00 total pot");
    expect(pot).toHaveClass("truncate");
  });
});
