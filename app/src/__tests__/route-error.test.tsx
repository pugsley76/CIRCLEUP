/**
 * Route error boundary (circles/[address]/error.tsx).
 *
 * Retry is offered only for a likely transient indexer outage. Deterministic
 * / invalid failures are not presented as retryable network outages — the user
 * gets a clear message and a way back instead.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import CircleError from "../app/circles/[address]/error.tsx";

describe("circles/[address] error boundary", () => {
  it("offers 'Try again' for a likely indexer outage", () => {
    const error = new Error("The indexer is unreachable or degraded") as Error & {
      digest?: string;
    };
    error.digest = "abc123";
    render(<CircleError error={error} reset={vi.fn()} />);

    expect(screen.getByText(/Indexer unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByText(/Back to circles/i)).toBeInTheDocument();
  });

  it("treats a 503 as a retryable outage", () => {
    const error = new Error("indexer returned 503") as Error & { digest?: string };
    render(<CircleError error={error} reset={vi.fn()} />);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("does not offer retry for a deterministic failure", () => {
    const error = new Error("invalid circle address supplied") as Error & {
      digest?: string;
    };
    render(<CircleError error={error} reset={vi.fn()} />);

    expect(screen.getByText(/Something went wrong loading this circle/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /try again/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Back to circles/i)).toBeInTheDocument();
  });

  it("does not offer retry for a generic unexpected error", () => {
    const error = new Error("Something unexpected happened") as Error & {
      digest?: string;
    };
    render(<CircleError error={error} reset={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: /try again/i }),
    ).not.toBeInTheDocument();
  });
});
