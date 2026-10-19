/**
 * CircleErrorBody — bounded retry for transient fetch failures only.
 *
 * Retry is offered for transient reads (network / server / parse) and withheld
 * for configuration problems (misconfigured) and sustained service issues
 * (indexer_outage), so deterministic failures are never presented as retryable
 * network outages.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const refreshMock = vi.fn().mockResolvedValue(undefined);

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    refresh: refreshMock,
  }),
  usePathname: () => "/",
}));

import CircleErrorBody from "../app/circles/[address]/CircleErrorBody";

const transientErrors = ["network", "server", "parse"] as const;
const nonRetryableErrors = ["misconfigured", "indexer_outage"] as const;

describe("CircleErrorBody", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    refreshMock.mockClear();
  });

  it.each(transientErrors)("shows a retry button for transient error: %s", (error) => {
    render(<CircleErrorBody error={error} />);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByText(/Could not load circle details/i)).toBeInTheDocument();
  });

  it.each(nonRetryableErrors)(
    "does not show a retry button for non-retryable error: %s",
    (error) => {
      render(<CircleErrorBody error={error} />);
      expect(
        screen.queryByRole("button", { name: /try again/i }),
      ).not.toBeInTheDocument();
      // A way back is always offered
      expect(screen.getByText(/back to circles/i)).toBeInTheDocument();
    },
  );

  it("calls router.refresh when retrying a transient error", async () => {
    render(<CircleErrorBody error="network" />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("does not call router.refresh when there is no retry button", () => {
    render(<CircleErrorBody error="misconfigured" />);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("disables the retry button while a refresh is in flight", async () => {
    refreshMock.mockResolvedValueOnce(new Promise(() => {}));
    render(<CircleErrorBody error="network" />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    const btn = screen.getByRole("button", { name: /retrying…/i });
    expect(btn).toBeDisabled();
  });
});
