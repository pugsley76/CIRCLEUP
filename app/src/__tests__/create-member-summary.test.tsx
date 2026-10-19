/**
 * Create form member counting — Issues #510 "Ignore blank member rows in create
 * summary calculations" and #511 "Enforce minimum and maximum member count
 * constraints in create form".
 *
 * Coverage:
 *   getMemberCountStatus() — MIN/MAX boundaries
 *   summarizeMemberRows()  — blank and whitespace rows ignored, duplicates
 *                            counted once
 *   validateCreateForm()   — count bounds apply to filled rows only
 *   Component render       — counter, live status, summary card, and pot all
 *                            ignore blank rows; bounds visible before submit;
 *                            row controls stop at MIN/MAX; an out-of-bounds
 *                            list never reaches the wallet
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/stellar", () => ({
  getWalletAddress: vi.fn().mockResolvedValue(null),
  invokeContract: vi.fn(),
  WalletError: class WalletError extends Error {
    constructor(
      public reason: string,
      message: string,
    ) {
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

import { getWalletAddress } from "@/lib/stellar";
import CreateClient, {
  MIN_MEMBERS,
  MAX_MEMBERS,
  getMemberCountStatus,
  summarizeMemberRows,
  validateCreateForm,
} from "../app/create/CreateClient";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Deterministic, checksum-valid G-addresses from the Stellar SDK encoder. */
const addrFor = (seed: number): string =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey();

const A = addrFor(1);
const B = addrFor(2);
const C = addrFor(3);

function memberInputs(): HTMLInputElement[] {
  return screen.getAllByRole("textbox", { name: /Member \d+ of \d+/ }) as HTMLInputElement[];
}

function typeInto(el: HTMLInputElement, value: string) {
  fireEvent.change(el, { target: { value } });
}

function summary() {
  return within(screen.getByLabelText("Circle summary"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe("getMemberCountStatus", () => {
  it("is too_few below MIN_MEMBERS", () => {
    expect(getMemberCountStatus(0)).toBe("too_few");
    expect(getMemberCountStatus(MIN_MEMBERS - 1)).toBe("too_few");
  });

  it("is ok from MIN_MEMBERS to MAX_MEMBERS inclusive", () => {
    expect(getMemberCountStatus(MIN_MEMBERS)).toBe("ok");
    expect(getMemberCountStatus(MAX_MEMBERS)).toBe("ok");
  });

  it("is too_many above MAX_MEMBERS", () => {
    expect(getMemberCountStatus(MAX_MEMBERS + 1)).toBe("too_many");
  });
});

describe("summarizeMemberRows", () => {
  it("counts nothing for the form's initial four blank rows", () => {
    expect(summarizeMemberRows(["", "", "", ""])).toEqual({
      count: 0,
      blankRows: 4,
      duplicateRows: 0,
      status: "too_few",
    });
  });

  it("ignores empty and whitespace-only rows wherever they sit", () => {
    const s = summarizeMemberRows(["", A, "   ", B, "\t", ""]);
    expect(s.count).toBe(2);
    expect(s.blankRows).toBe(4);
    expect(s.status).toBe("ok");
  });

  it("counts an address once however many times it is entered", () => {
    const s = summarizeMemberRows([A, B, A, ` ${B} `, a(A)]);
    expect(s.count).toBe(2);
    expect(s.duplicateRows).toBe(3);
  });

  function a(addr: string) {
    return addr.toLowerCase();
  }
});

describe("validateCreateForm — member count bounds use filled rows only", () => {
  const ok = (members: string[]) => validateCreateForm("Circle", members, "100", "30");

  it("accepts MIN_MEMBERS addresses padded with blank rows", () => {
    const result = ok([A, "", "   ", B, ""]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.validMembers).toEqual([A, B]);
  });

  it("does not let blank rows make up the minimum", () => {
    const result = ok([A, "", "", ""]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.membersGeneral).toMatch(/at least 2 .*You have 1/i);
  });

  it("names how many to remove when over MAX_MEMBERS", () => {
    const tooMany = Array.from({ length: MAX_MEMBERS + 2 }, (_, i) => addrFor(i + 1));
    const result = ok(tooMany);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.membersGeneral).toMatch(/more than 20 members/i);
      expect(result.errors.membersGeneral).toMatch(/You have 22; remove 2/);
    }
  });

  it("accepts exactly MAX_MEMBERS with trailing blank rows", () => {
    const max = Array.from({ length: MAX_MEMBERS }, (_, i) => addrFor(i + 1));
    expect(ok([...max, "", " "]).ok).toBe(true);
  });
});

// ─── Component: summary ignores blank rows (#510) ────────────────────────────

describe("CreateClient — summary ignores blank member rows", () => {
  it("shows zero members and a zero pot for the untouched form", () => {
    render(<CreateClient />);
    expect(screen.getByText("0 / 20 members")).toBeInTheDocument();
    expect(summary().getByText(/0 members/)).toBeInTheDocument();
    expect(summary().getByText(/Pot per round: \$0\.00$/)).toBeInTheDocument();
  });

  it("counts only the filled rows in the summary, counter, and pot hint", () => {
    render(<CreateClient />);
    const inputs = memberInputs();
    expect(inputs).toHaveLength(4);
    typeInto(inputs[0], A);
    typeInto(inputs[2], B); // rows 2 and 4 stay blank

    expect(summary().getByText(/^👥 2 members$/)).toBeInTheDocument();
    expect(summary().getByText(/Pot per round: \$200\.00$/)).toBeInTheDocument();
    expect(screen.getByText("2 / 20 members")).toBeInTheDocument();
    expect(screen.getByText(/\$100\.00 × 2 members = \$200\.00/)).toBeInTheDocument();
  });

  it("does not count a whitespace-only row", () => {
    render(<CreateClient />);
    const inputs = memberInputs();
    typeInto(inputs[0], A);
    typeInto(inputs[1], B);
    typeInto(inputs[2], "    ");

    expect(summary().getByText(/^👥 2 members$/)).toBeInTheDocument();
    expect(summary().getByText(/Pot per round: \$200\.00$/)).toBeInTheDocument();
  });

  it("does not count a duplicate twice, and says so", () => {
    render(<CreateClient />);
    const inputs = memberInputs();
    typeInto(inputs[0], A);
    typeInto(inputs[1], B);
    typeInto(inputs[2], A);

    expect(screen.getByLabelText("Circle summary")).toHaveTextContent(/2 members · 1 duplicate not counted/);
    expect(summary().getByText(/Pot per round: \$200\.00$/)).toBeInTheDocument();
  });
});

// ─── Component: member count bounds (#511) ───────────────────────────────────

describe("CreateClient — member count bounds", () => {
  it("shows how many more addresses are needed before the first submit", () => {
    render(<CreateClient />);
    expect(screen.getByText(/Add 2 more addresses\. A circle needs 2 to 20 members\./)).toBeInTheDocument();

    typeInto(memberInputs()[0], A);
    expect(screen.getByText(/Add 1 more address\. /)).toBeInTheDocument();
    expect(summary().getByText(/1 member \(at least 2 needed\)/)).toBeInTheDocument();

    typeInto(memberInputs()[3], B);
    expect(screen.getByText(/A circle needs 2 to 20 members\. Empty rows are ignored\./)).toBeInTheDocument();
    expect(summary().queryByText(/needed/)).toBeNull();
  });

  it("stops adding rows at MAX_MEMBERS", () => {
    render(<CreateClient />);
    const add = screen.getByRole("button", { name: /add member/i });
    for (let i = 0; i < MAX_MEMBERS + 5; i++) fireEvent.click(add);

    expect(memberInputs()).toHaveLength(MAX_MEMBERS);
    expect(add).toBeDisabled();
    expect(screen.getByText(`Maximum of ${MAX_MEMBERS} members reached.`)).toBeInTheDocument();
  });

  it("stops removing rows at MIN_MEMBERS", () => {
    render(<CreateClient />);
    // Four rows → remove down to the minimum.
    fireEvent.click(screen.getAllByRole("button", { name: /^Remove member/ })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: /^Remove member/ })[0]);
    expect(memberInputs()).toHaveLength(MIN_MEMBERS);

    // At the minimum every remove control is announced as blocked, and
    // clicking it does nothing.
    const blocked = screen.getAllByRole("button", {
      name: /Cannot remove member .* at least 2 members/,
    });
    expect(blocked).toHaveLength(MIN_MEMBERS);
    blocked.forEach((btn) => fireEvent.click(btn));
    expect(memberInputs()).toHaveLength(MIN_MEMBERS);
    expect(screen.queryByRole("button", { name: /^Remove member/ })).toBeNull();
  });

  it("blocks submit before the wallet when too few rows are filled", async () => {
    render(<CreateClient />);
    fireEvent.change(screen.getByLabelText(/circle name/i), { target: { value: "Family" } });
    typeInto(memberInputs()[1], A); // three blank rows around one address

    fireEvent.click(screen.getByRole("button", { name: /create circle/i }));

    expect(
      await screen.findByText(/At least 2 members are required\. You have 1\./),
    ).toBeInTheDocument();
    expect(getWalletAddress).not.toHaveBeenCalled();
  });
});
