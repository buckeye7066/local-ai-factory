/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FoundryFloor } from "./FoundryFloor.js";

const stationIds = [
  "factory-deck",
  "scout",
  "repo-rewards",
  "promo-pilot",
  "flexfactor",
  "crucible",
  "app-store-publisher",
  "watchtower",
] as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Purpose Foundry intake UI", () => {
  it("includes configured bays without forcing unconfigured bays", async () => {
    const stations = stationIds.map((id, order) => ({
      id,
      name: id,
      department: "test",
      purpose: "test",
      standalone: true,
      order,
      color: "cyan",
    }));
    const adapters = stationIds.map((stationId) => ({
      stationId,
      mode: "internal",
      configured: stationId === "factory-deck" || stationId === "crucible",
      destination: "test",
    }));
    let posted: Record<string, unknown> | null = null;
    let projects: unknown[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/foundry/stations") return json({ stations });
        if (url === "/api/foundry/adapters") return json({ adapters });
        if (url === "/api/foundry/projects" && init?.method === "POST") {
          posted = JSON.parse(String(init.body)) as Record<string, unknown>;
          const created = {
            id: "c2b867ad-7be9-44cc-b660-145d409e6142",
            name: posted.name,
            status: "draft",
            routingMode: posted.routingMode,
            constitution: {
              purpose: posted.purpose,
              targetUsers: [],
              successCriteria: [],
              constraints: [],
              nonGoals: [],
              targets: [],
            },
            source: { kind: "manual", path: null },
            stations: [],
            updatedAt: Date.now(),
          };
          projects = [created];
          return json(created, 201);
        }
        if (url === "/api/foundry/projects") return json({ projects });
        return json({ error: "not found" }, 404);
      }),
    );

    render(<FoundryFloor />);

    fireEvent.change(await screen.findByLabelText("Job name"), {
      target: { value: "Paid core job" },
    });
    fireEvent.change(screen.getByLabelText("What this job is for"), {
      target: { value: "Build and verify the core product" },
    });
    fireEvent.change(screen.getByLabelText("Purpose Foundry provider routing"), {
      target: { value: "paid" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Release to the line/i }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toMatchObject({
      name: "Paid core job",
      purpose: "Build and verify the core product",
      routingMode: "paid",
      selectedStations: ["factory-deck", "crucible"],
    });
    expect(posted?.selectedStations).not.toContain("promo-pilot");
    expect(posted?.selectedStations).not.toContain("app-store-publisher");
  });
});
