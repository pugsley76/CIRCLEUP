import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";

// ─── Module mocks (hoisted) ───────────────────────────────────────────────────
//
// Note: @testing-library/user-event is NOT imported here because user-event v14
// calls `new Pointer(document)` at module evaluation time, which throws
// `Cannot read properties of undefined (reading 'on')` under Node 24 / jsdom
// before the pointer API is shimmed. We use fireEvent for click simulation
// instead — it's synchronous, has no DOM bootstrapping side-effects, and is
// the correct choice for testing button click handlers (not pointer events).

vi.mock("@/lib/stellar", () => {
  class WalletError extends Error {
    reason: string;
    constructor(reason: string, message: string) {
      super(message);
      this.reason = reason;
      this.name = "WalletError";
    }
  }
  return {
    WalletError,
    isFreighterInstalled: vi.fn(),
    getWalletAddress: vi.fn(),
    connectWallet: vi.fn(),
  };
});

vi.mock("@/lib/config", () => ({
  shortAddress: (addr: string) =>
    addr && addr.length >= 8 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr,
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  CIRCLE_FACTORY_ADDRESS: "",
  REPUTATION_ADDRESS: "",
  USDC_ADDRESS: "",
  INDEXER_URL: "http://localhost:3001",
  ACTIVE_NETWORK: "testnet",
  getExplorerLink: () => null,
}));

// ─── Mock @/lib/walletCapabilities ────────────────────────────────────────────
//
// Single mock covering every export WalletButton uses.
// Default: canGetNetwork=false so the network-check path is a no-op in tests
// that don't care about it. Individual tests override as needed.

vi.mock("@/lib/walletCapabilities", () => ({
  detectWalletCapabilities: vi.fn(() => ({
    installed: true,
    canConnect: true,
    canSignTransaction: true,
    canGetNetwork: false,
    canWatchChanges: false,
  })),
  explainUnsupportedAction: vi.fn(() => null),
  checkNetworkMismatch: vi.fn(async () => ({ kind: "unsupported" })),
  describeNetworkMismatch: vi.fn(() => null),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { WalletButton } from "@/components/WalletButton";
import * as stellar from "@/lib/stellar";
import * as walletCaps from "@/lib/walletCapabilities";

const mockStellar = stellar as {
  isFreighterInstalled: ReturnType<typeof vi.fn>;
  getWalletAddress: ReturnType<typeof vi.fn>;
  connectWallet: ReturnType<typeof vi.fn>;
  WalletError: new (reason: string, msg: string) => Error & { reason: string };
};

const mockCaps = walletCaps as {
  detectWalletCapabilities: ReturnType<typeof vi.fn>;
  explainUnsupportedAction: ReturnType<typeof vi.fn>;
  checkNetworkMismatch: ReturnType<typeof vi.fn>;
  describeNetworkMismatch: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCaps.detectWalletCapabilities.mockReturnValue({
    installed: true,
    canConnect: true,
    canSignTransaction: true,
    canGetNetwork: false,
    canWatchChanges: false,
  });
  mockCaps.explainUnsupportedAction.mockReturnValue(null);
  mockCaps.checkNetworkMismatch.mockResolvedValue({ kind: "unsupported" });
  mockCaps.describeNetworkMismatch.mockReturnValue(null);
});

async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
  });
}

// ─── Idle state ───────────────────────────────────────────────────────────────

describe("WalletButton — idle state (Freighter installed, not connected)", () => {
  it("renders Connect Freighter button", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);

    render(<WalletButton />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /connect freighter/i }),
      ).toBeInTheDocument(),
    );
  });

  it("button is not disabled in idle state", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);

    render(<WalletButton />);
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /connect freighter/i });
      expect(btn).not.toBeDisabled();
    });
  });
});

// ─── Connected state ──────────────────────────────────────────────────────────

describe("WalletButton — connected state", () => {
  it("shows shortened address without a connect button", async () => {
    const addr = "G" + "A".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(addr);

    render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByText("GAAA…AAAA")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not show a network warning when mismatch returns null description", async () => {
    const addr = "G" + "A".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(addr);
    mockCaps.describeNetworkMismatch.mockReturnValue(null);

    render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByText("GAAA…AAAA")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows network mismatch warning when mismatch is detected", async () => {
    const addr = "G" + "A".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(addr);
    mockCaps.detectWalletCapabilities.mockReturnValue({
      installed: true,
      canConnect: true,
      canSignTransaction: true,
      canGetNetwork: true,
      canWatchChanges: false,
    });
    mockCaps.checkNetworkMismatch.mockResolvedValue({
      kind: "mismatch",
      detectedPassphrase: "Public Global Stellar Network ; September 2015",
      configuredPassphrase: "Test SDF Network ; September 2015",
    });
    mockCaps.describeNetworkMismatch.mockReturnValue(
      "Your wallet is connected to a different network.",
    );

    render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument(),
    );
    expect(screen.getByText(/different network/i)).toBeInTheDocument();
  });

  it("network mismatch alert has aria-live polite", async () => {
    const addr = "G" + "A".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(addr);
    mockCaps.detectWalletCapabilities.mockReturnValue({
      installed: true,
      canConnect: true,
      canSignTransaction: true,
      canGetNetwork: true,
      canWatchChanges: false,
    });
    mockCaps.checkNetworkMismatch.mockResolvedValue({
      kind: "mismatch",
      detectedPassphrase: "Public Global Stellar Network ; September 2015",
      configuredPassphrase: "Test SDF Network ; September 2015",
    });
    mockCaps.describeNetworkMismatch.mockReturnValue("Wrong network detected.");

    render(<WalletButton />);
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveAttribute("aria-live", "polite");
    });
  });
});

// ─── Limited capabilities ─────────────────────────────────────────────────────

describe("WalletButton — limited capabilities state", () => {
  it("shows warning when wallet cannot sign transactions", async () => {
    const addr = "G" + "A".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(addr);
    mockCaps.explainUnsupportedAction.mockReturnValue(
      "Your wallet does not support the ability to sign this transaction.",
    );

    render(<WalletButton />);
    await waitFor(() => {
      expect(
        screen.getByText(/does not support the ability to sign/i),
      ).toBeInTheDocument();
    });
  });
});

// ─── Not installed ────────────────────────────────────────────────────────────

describe("WalletButton — not_installed state", () => {
  it("renders install link pointing to freighter.app", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(false);
    mockStellar.getWalletAddress.mockResolvedValue(null);

    render(<WalletButton />);
    await waitFor(() => {
      const link = screen.getByRole("link", { name: /install freighter/i });
      expect(link).toHaveAttribute("href", "https://freighter.app");
    });
  });

  it("install link opens in a new tab with noopener", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(false);
    mockStellar.getWalletAddress.mockResolvedValue(null);

    render(<WalletButton />);
    await waitFor(() => {
      const link = screen.getByRole("link", { name: /install freighter/i });
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    });
  });
});

// ─── Connecting flow ──────────────────────────────────────────────────────────

describe("WalletButton — connecting flow", () => {
  it("shows connecting spinner then connected address on success", async () => {
    const addr = "G" + "B".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockResolvedValue(addr);

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await click(btn);

    await waitFor(() =>
      expect(screen.getByText("GBBB…BBBB")).toBeInTheDocument(),
    );
  });

  it("shows error message when permission denied", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockRejectedValue(
      new mockStellar.WalletError(
        "permission_denied",
        "Wallet access was denied.",
      ),
    );

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await click(btn);

    await waitFor(() =>
      expect(
        screen.getByText(/wallet access was denied/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /retry connection/i }),
    ).toBeInTheDocument();
  });

  it("transitions to not_installed when connect throws not_installed", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockRejectedValue(
      new mockStellar.WalletError(
        "not_installed",
        "Freighter not installed.",
      ),
    );

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await click(btn);

    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: /install freighter/i }),
      ).toBeInTheDocument(),
    );
  });
});

// ─── Account change / disconnect ──────────────────────────────────────────────

describe("WalletButton — account change and disconnect", () => {
  it("re-resolves to idle when account changes and wallet is disconnected", async () => {
    const addr = "G" + "C".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress
      .mockResolvedValueOnce(addr)
      .mockResolvedValueOnce(null);

    let accountChangedCallback: (() => void) | null = null;
    const providerMock = {
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === "accountChanged") accountChangedCallback = cb;
      }),
      removeEventListener: vi.fn(),
    };
    (window as any).freighter = providerMock;

    render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByText("GCCC…CCCC")).toBeInTheDocument(),
    );

    await act(async () => {
      accountChangedCallback?.();
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /connect freighter/i }),
      ).toBeInTheDocument(),
    );
    try { Object.defineProperty(window, "freighter", { configurable: true, value: undefined }); delete (window as any).freighter; } catch { /* jsdom cleanup */ }
  });

  it("re-resolves to new address when account switches", async () => {
    const addr1 = "G" + "D".repeat(55);
    const addr2 = "G" + "E".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress
      .mockResolvedValueOnce(addr1)
      .mockResolvedValueOnce(addr2);

    let accountChangedCallback: (() => void) | null = null;
    const providerMock = {
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === "accountChanged") accountChangedCallback = cb;
      }),
      removeEventListener: vi.fn(),
    };
    (window as any).freighter = providerMock;

    render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByText("GDDD…DDDD")).toBeInTheDocument(),
    );

    await act(async () => {
      accountChangedCallback?.();
    });

    await waitFor(() =>
      expect(screen.getByText("GEEE…EEEE")).toBeInTheDocument(),
    );
    try { Object.defineProperty(window, "freighter", { configurable: true, value: undefined }); delete (window as any).freighter; } catch { /* jsdom cleanup */ }
  });

  it("removes event listeners on unmount", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);

    const removeEventListener = vi.fn();
    const providerMock = {
      addEventListener: vi.fn(),
      removeEventListener,
    };
    (window as any).freighter = providerMock;

    const { unmount } = render(<WalletButton />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /connect freighter/i }),
      ).toBeInTheDocument(),
    );

    unmount();

    expect(removeEventListener).toHaveBeenCalledWith(
      "accountChanged",
      expect.any(Function),
    );
    expect(removeEventListener).toHaveBeenCalledWith(
      "networkChanged",
      expect.any(Function),
    );
    try { Object.defineProperty(window, "freighter", { configurable: true, value: undefined }); delete (window as any).freighter; } catch { /* jsdom cleanup */ }
  });

  it("does not update state after unmount when probe resolves late", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockReturnValue(new Promise(() => {}));

    const { unmount } = render(<WalletButton />);
    unmount(); // no React warning expected
  });
});

// ─── Changing state ───────────────────────────────────────────────────────────

describe("WalletButton — changing state", () => {
  it("shows Updating spinner during the changing transition", async () => {
    const addr = "G" + "F".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress
      .mockResolvedValueOnce(addr)
      .mockReturnValueOnce(new Promise(() => {}));

    let accountChangedCallback: (() => void) | null = null;
    const providerMock = {
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === "accountChanged") accountChangedCallback = cb;
      }),
      removeEventListener: vi.fn(),
    };
    (window as any).freighter = providerMock;

    render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByText("GFFF…FFFF")).toBeInTheDocument(),
    );

    act(() => {
      accountChangedCallback?.();
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /updating/i }),
      ).toBeInTheDocument(),
    );
    try { Object.defineProperty(window, "freighter", { configurable: true, value: undefined }); delete (window as any).freighter; } catch { /* jsdom cleanup */ }
  });
});

// ─── Accessibility ────────────────────────────────────────────────────────────

describe("WalletButton — accessibility", () => {
  it("button carries aria-busy=true during connecting", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockReturnValue(new Promise(() => {}));

    render(<WalletButton />);
    const btn = await screen.findByRole("button", {
      name: /connect freighter/i,
    });
    await click(btn);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /connecting/i }),
      ).toHaveAttribute("aria-busy", "true"),
    );
  });

  it("error message has aria-live polite region", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockRejectedValue(
      new mockStellar.WalletError("unknown", "Unexpected failure"),
    );

    render(<WalletButton />);
    const btn = await screen.findByRole("button", {
      name: /connect freighter/i,
    });
    await click(btn);

    await waitFor(() => {
      const live = document.querySelector("[aria-live='polite']");
      expect(live).toBeInTheDocument();
    });
  });

  it("retry button has a visible focus ring class", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockRejectedValue(
      new mockStellar.WalletError("permission_denied", "Denied."),
    );

    render(<WalletButton />);
    const btn = await screen.findByRole("button", {
      name: /connect freighter/i,
    });
    await click(btn);

    await waitFor(() => {
      const retryBtn = screen.getByRole("button", {
        name: /retry connection/i,
      });
      expect(retryBtn.className).toMatch(/focus-visible/);
    });
  });

  it("announces wallet connected to screen readers via sr-only live region", async () => {
    const addr = "G" + "A".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(addr);

    render(<WalletButton />);

    await waitFor(() => {
      const srRegion = document.querySelector("[role='status'][aria-live='polite'].sr-only");
      expect(srRegion).toBeInTheDocument();
      expect(srRegion?.textContent).toMatch(/wallet connected/i);
      expect(srRegion?.textContent).toContain(addr);
    });
  });

  it("re-announces when wallet account changes to a new address", async () => {
    const addr1 = "G" + "A".repeat(55);
    const addr2 = "G" + "B".repeat(55);
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress
      .mockResolvedValueOnce(addr1)
      .mockResolvedValueOnce(addr2);

    let accountChangedCallback: (() => void) | null = null;
    const providerMock = {
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === "accountChanged") accountChangedCallback = cb;
      }),
      removeEventListener: vi.fn(),
    };
    (window as any).freighter = providerMock;

    render(<WalletButton />);
    await waitFor(() =>
      expect(screen.getByText("GAAA…AAAA")).toBeInTheDocument(),
    );

    await act(async () => { accountChangedCallback?.(); });

    await waitFor(() => {
      const srRegion = document.querySelector("[role='status'][aria-live='polite'].sr-only");
      expect(srRegion?.textContent).toContain(addr2);
    });
    try { Object.defineProperty(window, "freighter", { configurable: true, value: undefined }); delete (window as any).freighter; } catch { /* jsdom cleanup */ }
  });
});

// ─── Initial probe error handling ────────────────────────────────────────────
//
// resolveAccount runs on mount as a silent probe. Before this fix, ALL errors
// from getWalletAddress() were mapped to the not_installed state regardless of
// reason — a permission_denied or unknown error during the silent probe would
// render the "Install Freighter" link instead of an error with retry guidance.
// These tests pin the corrected behaviour.

describe("WalletButton — initial probe error handling", () => {
  it("shows error state (not install link) when probe throws permission_denied", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockRejectedValue(
      new mockStellar.WalletError("permission_denied", "Wallet access was denied."),
    );

    render(<WalletButton />);

    // Must NOT show the install link — permission_denied means wallet IS installed
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: /install freighter/i })).not.toBeInTheDocument(),
    );

    // Must show the error panel with retry button
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /retry connection/i })).toBeInTheDocument(),
    );
  });

  it("permission_denied probe shows the correct guidance message", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockRejectedValue(
      new mockStellar.WalletError("permission_denied", "Wallet access was denied."),
    );

    render(<WalletButton />);

    await waitFor(() =>
      expect(
        screen.getByText(/dismissed the Freighter prompt/i),
      ).toBeInTheDocument(),
    );
  });

  it("shows error state when probe throws a generic (non-WalletError) exception", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockRejectedValue(
      new Error("Extension communication failed"),
    );

    render(<WalletButton />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /retry connection/i })).toBeInTheDocument(),
    );
    // Should NOT show install link — this is not a not_installed error
    expect(screen.queryByRole("link", { name: /install freighter/i })).not.toBeInTheDocument();
  });

  it("generic probe error shows the unknown guidance message", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockRejectedValue(
      new Error("Extension communication failed"),
    );

    render(<WalletButton />);

    await waitFor(() =>
      expect(
        screen.getByText(/connection error occurred/i),
      ).toBeInTheDocument(),
    );
  });

  it("shows error state when probe throws WalletError with unknown reason", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockRejectedValue(
      new mockStellar.WalletError("unknown", "RPC connection refused."),
    );

    render(<WalletButton />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /retry connection/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("link", { name: /install freighter/i })).not.toBeInTheDocument();
  });

  it("still shows not_installed when probe throws WalletError with not_installed reason", async () => {
    // Belt-and-suspenders: the not_installed path must still work correctly.
    mockStellar.isFreighterInstalled.mockReturnValue(false);
    mockStellar.getWalletAddress.mockRejectedValue(
      new mockStellar.WalletError("not_installed", "Freighter not installed."),
    );

    render(<WalletButton />);

    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: /install freighter/i }),
      ).toBeInTheDocument(),
    );
  });
});

// ─── Error render — per-reason guidance ──────────────────────────────────────
//
// Each WalletErrorReason must produce distinct, actionable guidance text so the
// user knows their exact next step rather than a generic "something went wrong".

describe("WalletButton — error render per-reason guidance", () => {
  it("permission_denied connect shows dismiss guidance", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockRejectedValue(
      new mockStellar.WalletError("permission_denied", "Access denied by user."),
    );

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await click(btn);

    await waitFor(() =>
      expect(
        screen.getByText(/dismissed the Freighter prompt/i),
      ).toBeInTheDocument(),
    );
  });

  it("unknown WalletError connect shows generic connection guidance", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockRejectedValue(
      new mockStellar.WalletError("unknown", "Unexpected extension error."),
    );

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await click(btn);

    await waitFor(() =>
      expect(
        screen.getByText(/connection error occurred/i),
      ).toBeInTheDocument(),
    );
  });

  it("unsupported_capability connect shows update guidance", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockRejectedValue(
      new mockStellar.WalletError(
        "unsupported_capability",
        "This action is not supported by your wallet.",
      ),
    );

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await click(btn);

    await waitFor(() =>
      expect(
        screen.getByText(/version of Freighter does not support/i),
      ).toBeInTheDocument(),
    );
  });

  it("error panel uses role=alert so screen readers announce it immediately", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockRejectedValue(
      new mockStellar.WalletError("permission_denied", "Denied."),
    );

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await click(btn);

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toBeInTheDocument();
      // The alert must be a panel element (div/section), not just a span —
      // confirms the full panel pattern, not the old truncated span.
      expect(alert.tagName.toLowerCase()).toBe("div");
    });
  });

  it("technical error message is visible in the DOM, not just a tooltip", async () => {
    const technicalMsg = "Unexpected extension failure";
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockRejectedValue(
      new mockStellar.WalletError("unknown", technicalMsg),
    );

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await click(btn);

    // The message must appear as visible text — NOT only in a title attribute.
    await waitFor(() =>
      expect(screen.getByText(technicalMsg)).toBeInTheDocument(),
    );
    // Confirm it is NOT only in a tooltip by checking the element is visible text
    const el = screen.getByText(technicalMsg);
    expect(el.tagName.toLowerCase()).not.toBe("button"); // not stuffed into title
  });

  it("retry button is linked to the error panel via aria-describedby", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockResolvedValue(null);
    mockStellar.connectWallet.mockRejectedValue(
      new mockStellar.WalletError("permission_denied", "Denied."),
    );

    render(<WalletButton />);
    const btn = await screen.findByRole("button", { name: /connect freighter/i });
    await click(btn);

    await waitFor(() => {
      const retryBtn = screen.getByRole("button", { name: /retry connection/i });
      expect(retryBtn).toHaveAttribute("aria-describedby", "wallet-error-panel");
    });
  });
});

// ─── Checking state ───────────────────────────────────────────────────────────
//
// On mount the component sets status:"checking" while getWalletAddress() is
// in-flight. The button must be rendered as disabled and aria-busy during
// this window.

describe("WalletButton — checking state", () => {
  it("renders a disabled, aria-busy button while the initial probe is in-flight", async () => {
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    // Never resolves — simulates the probe still in-flight
    mockStellar.getWalletAddress.mockReturnValue(new Promise(() => {}));

    render(<WalletButton />);

    // During checking the button is rendered but disabled and aria-busy
    const btn = await screen.findByRole("button");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
  });

  it("button label is 'Connect Freighter' (not a loading variant) during checking", async () => {
    // The checking state uses the default "Connect Freighter" label since the
    // user has not initiated a connection yet — it would be confusing to show
    // "Connecting…" before they clicked anything.
    mockStellar.isFreighterInstalled.mockReturnValue(true);
    mockStellar.getWalletAddress.mockReturnValue(new Promise(() => {}));

    render(<WalletButton />);

    const btn = await screen.findByRole("button");
    expect(btn).toHaveTextContent(/connect freighter/i);
  });
});
