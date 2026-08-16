/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary.js";

/**
 * One panel's crash must not blank the whole deck.
 *
 * The measured incident: the Files tab threw during render
 * (`match.contents.length` on undefined, because the server served
 * FileSummary where FileContent was declared). With no boundary in the tree,
 * React unmounted the ENTIRE app — the owner got a white page, mid-run, with
 * no navigation and no error.
 *
 * These tests render a component that really throws, so they exercise the
 * actual React error path rather than asserting on the boundary's internals.
 */

/** A component that throws during render, exactly like the Files-tab bug. */
function Boom({ message = "contents is undefined" }: { message?: string }): never {
  throw new Error(message);
}

afterEach(() => cleanup());

describe("ErrorBoundary", () => {
  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary label="the Files tab">
        <p>healthy panel</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("healthy panel")).toBeTruthy();
  });

  it("catches a render-time throw instead of unmounting the tree", () => {
    // React logs caught errors; silence the expected noise.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary label="the Files tab">
        <Boom />
      </ErrorBoundary>,
    );
    // The fallback rendered — the app did NOT go blank.
    const alert = screen.getByRole("alert");
    expect(alert).toBeTruthy();
    expect(alert.textContent).toMatch(/Something went wrong in the Files tab/);
    expect(alert.textContent).toMatch(/rest of Factory Deck is still working/i);
    err.mockRestore();
  });

  it("preserves full developer diagnostics in the fallback", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary label="the Files tab">
        <Boom message="contents is undefined" />
      </ErrorBoundary>,
    );
    // The real message is available to the developer, not swallowed.
    expect(screen.getByRole("alert").textContent).toMatch(/contents is undefined/);
    err.mockRestore();
  });

  it("logs the error and component stack to the console", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary label="the Files tab">
        <Boom message="diagnostic-marker" />
      </ErrorBoundary>,
    );
    const logged = err.mock.calls.flat().map(String).join(" ");
    expect(logged).toMatch(/diagnostic-marker/);
    err.mockRestore();
  });

  it("recovers when 'Try again' is clicked and the child no longer throws", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error("transient");
      return <p>recovered panel</p>;
    }
    render(
      <ErrorBoundary label="the Files tab">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();

    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.getByText("recovered panel")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    err.mockRestore();
  });

  it("clears the error when the owner navigates to another view", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary label="the Files tab" resetKey="run">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();

    // Navigating away must not strand the owner on a broken panel.
    rerender(
      <ErrorBoundary label="Settings" resetKey="settings">
        <p>settings panel</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("settings panel")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    err.mockRestore();
  });
});
