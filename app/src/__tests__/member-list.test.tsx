/**
 * Member list — remove, add, and accessibility tests.
 *
 * Coverage:
 *   - Component render  — remove produces the intended remaining order
 *                       — remove never shifts another row's value into the
 *                         wrong slot
 *                       — remove button has accessible name (including at-min
 *                         state)
 *                       — address input has accessible name with position info
 *                       — accessible names update after add / remove
 *                       — member list container has an accessible label
 *
 * Note: reorder (move up/down) controls and stable DOM row identity were
 * reverted upstream in #584 along with issues #471-475; this suite tests the
 * tooling that remains: index-keyed add/remove + accessible naming.
 *
 * Runner: vitest + @testing-library/react (jsdom, globals: true)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import CreateClient from "../app/create/CreateClient";

// ─── Mock heavy dependencies so the component renders without a real wallet ──

vi.mock("@/lib/stellar", () => ({
  getWalletAddress: vi.fn().mockResolvedValue(null),
  invokeContract:   vi.fn(),
  WalletError: class WalletError extends Error {
    constructor(public reason: string, message: string) {
      super(message);
      this.name = "WalletError";
    }
  },
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    CIRCLE_FACTORY_ADDRESS: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    ACTIVE_NETWORK: "testnet",
    getExplorerLink: () => null,
  };
});

// ─── Address fixtures ─────────────────────────────────────────────────────────

/**
 * Deterministic, checksum-valid G-addresses. Generated through the Stellar
 * SDK so they satisfy both the shape and the strkey checksum (Issue #477).
 */
const addrFor = (seed: number): string =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey();

const A = addrFor(1);
const B = addrFor(2);
const C = addrFor(3);
const D = addrFor(4);

// ─── Component: helpers ───────────────────────────────────────────────────────

/**
 * Fill all four default member inputs with the given values.
 */
function fillMembers(values: string[]) {
  const inputs = screen.getAllByRole("textbox", {
    name: /member \d+ of \d+ — stellar address/i,
  });
  values.forEach((v, i) => {
    if (inputs[i]) fireEvent.change(inputs[i], { target: { value: v } });
  });
  return inputs;
}

/** Return current values of all member address inputs in DOM order. */
function getMemberValues(): string[] {
  return screen
    .getAllByRole("textbox", { name: /member \d+ of \d+ — stellar address/i })
    .map((el) => (el as HTMLInputElement).value);
}

// ─── Component: remove behaviour ─────────────────────────────────────────────

describe("Member list — remove", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removing a middle row never shifts another row's value into the wrong slot", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Remove row 2 (value B, 0-indexed position 1)
    const removeBtns = screen.getAllByRole("button", { name: /remove member/i });
    fireEvent.click(removeBtns[1]); // removes member at position 2

    // Remaining values must be exactly [A, C, D] — B gone, no contamination
    expect(getMemberValues()).toEqual([A, C, D]);
  });

  it("removing the first row gives [B, C, D]", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    const removeBtns = screen.getAllByRole("button", { name: /remove member/i });
    fireEvent.click(removeBtns[0]);

    expect(getMemberValues()).toEqual([B, C, D]);
  });

  it("removing the last row gives [A, B, C]", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    const removeBtns = screen.getAllByRole("button", { name: /remove member/i });
    fireEvent.click(removeBtns[removeBtns.length - 1]);

    expect(getMemberValues()).toEqual([A, B, C]);
  });

  it("remove button is aria-disabled at minimum member count", () => {
    render(<CreateClient />);
    // Default starts with 4 rows; remove down to 2 (MIN_MEMBERS)
    const remove = () =>
      screen.getAllByRole("button", { name: /remove member|cannot remove/i })[0];

    fireEvent.click(remove());
    fireEvent.click(remove());
    // Now at MIN_MEMBERS — buttons should be aria-disabled
    const btns = screen.getAllByRole("button", { name: /cannot remove/i });
    expect(btns.length).toBeGreaterThan(0);
    btns.forEach((btn) => expect(btn).toHaveAttribute("aria-disabled", "true"));
  });

  it("remove button accessible name mentions minimum when at minimum", () => {
    render(<CreateClient />);
    const remove = () =>
      screen.getAllByRole("button", { name: /remove member|cannot remove/i })[0];

    fireEvent.click(remove());
    fireEvent.click(remove());

    const btns = screen.getAllByRole("button", { name: /cannot remove/i });
    btns.forEach((btn) => {
      expect(btn.getAttribute("aria-label")).toMatch(/at least \d+ member/i);
    });
  });
});

// ─── Component: editing after remove ─────────────────────────────────────────

describe("Member list — editing after remove", () => {
  beforeEach(() => vi.clearAllMocks());

  it("editing row 1 after removing row 2 does not affect row 3's value", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Remove row 2 (value B) → [A, C, D]
    const removeBtns = screen.getAllByRole("button", { name: /remove member/i });
    fireEvent.click(removeBtns[1]);

    // Edit position 1 (value A) to something new
    const inputs = screen.getAllByRole("textbox", {
      name: /member \d+ of \d+ — stellar address/i,
    });
    fireEvent.change(inputs[0], { target: { value: B } });

    // Row 1 = B (edited), row 2 = C (was row 3 before remove — untouched), row 3 = D
    expect(getMemberValues()).toEqual([B, C, D]);
  });
});

// ─── Component: accessible names ─────────────────────────────────────────────

describe("Member list — accessible names", () => {
  beforeEach(() => vi.clearAllMocks());

  it("each address input has an accessible name that includes its position", () => {
    render(<CreateClient />);
    const inputs = screen.getAllByRole("textbox", {
      name: /member \d+ of \d+ — stellar address/i,
    });
    // Default renders 4 rows
    expect(inputs.length).toBe(4);
    inputs.forEach((input, i) => {
      const label = input.getAttribute("aria-label") ?? "";
      expect(label).toMatch(new RegExp(`member ${i + 1} of \\d+`, "i"));
    });
  });

  it("each address input mentions payout position in its accessible name", () => {
    render(<CreateClient />);
    const inputs = screen.getAllByRole("textbox", {
      name: /member \d+ of \d+ — stellar address/i,
    });
    inputs.forEach((input, i) => {
      expect(input.getAttribute("aria-label")).toMatch(
        new RegExp(`payout position ${i + 1}`, "i"),
      );
    });
  });

  it("each remove button has an accessible name with the member's position", () => {
    render(<CreateClient />);
    // At 4 rows (> MIN_MEMBERS) all remove buttons show the position name
    const removeBtns = screen.getAllByRole("button", { name: /remove member \d+/i });
    expect(removeBtns.length).toBe(4);
    removeBtns.forEach((btn, i) => {
      expect(btn.getAttribute("aria-label")).toMatch(
        new RegExp(`remove member ${i + 1}`, "i"),
      );
    });
  });

  it("accessible names update after adding a member", () => {
    render(<CreateClient />);
    fireEvent.click(screen.getByRole("button", { name: /\+ add member/i }));
    const inputs = screen.getAllByRole("textbox", {
      name: /member \d+ of \d+ — stellar address/i,
    });
    expect(inputs.length).toBe(5);
    // Last input should say "member 5 of 5"
    expect(inputs[4].getAttribute("aria-label")).toMatch(/member 5 of 5/i);
  });

  it("accessible names update after removing a member", () => {
    render(<CreateClient />);
    fillMembers([A, B, C, D]);

    // Remove middle row → 3 rows remain, positions should be 1-of-3, 2-of-3, 3-of-3
    const removeBtns = screen.getAllByRole("button", { name: /remove member \d+/i });
    fireEvent.click(removeBtns[1]);

    const inputs = screen.getAllByRole("textbox", {
      name: /member \d+ of \d+ — stellar address/i,
    });
    expect(inputs.length).toBe(3);
    expect(inputs[0].getAttribute("aria-label")).toMatch(/member 1 of 3/i);
    expect(inputs[2].getAttribute("aria-label")).toMatch(/member 3 of 3/i);
  });

  it("member list container has an accessible label", () => {
    render(<CreateClient />);
    const list = screen.getByRole("list", {
      name: /member list — payout rotation order/i,
    });
    expect(list).toBeInTheDocument();
  });
});