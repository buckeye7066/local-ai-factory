/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
  it("waits for the catalog and includes only explicitly selected specialists", async () => {
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
      configured:
        stationId === "factory-deck" ||
        stationId === "crucible" ||
        stationId === "promo-pilot",
      destination: "test",
    }));
    const posted = { current: null as Record<string, unknown> | null };
    let obsidianPosted: Record<string, unknown> | null = null;
    let projects: unknown[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/foundry/stations") return json({ stations });
        if (url === "/api/foundry/adapters") return json({ adapters });
        if (url === "/api/foundry/projects" && init?.method === "POST") {
          posted.current = JSON.parse(String(init.body)) as Record<
            string,
            unknown
          >;
          const created = {
            id: "c2b867ad-7be9-44cc-b660-145d409e6142",
            name: posted.current.name,
            status: "draft",
            routingMode: posted.current.routingMode,
            constitution: {
              purpose: posted.current.purpose,
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
        if (url === "/api/foundry/obsidian/import" && init?.method === "POST") {
          obsidianPosted = JSON.parse(String(init.body)) as Record<
            string,
            unknown
          >;
          return json(
            {
              id: "dfa82a9c-c89d-4ce7-b35f-bf6389900b9f",
              name: "Obsidian job",
              status: "draft",
              constitution: {
                purpose: "Imported",
                targetUsers: [],
                successCriteria: [],
                constraints: [],
                nonGoals: [],
                targets: [],
              },
              source: { kind: "obsidian", path: "Obsidian/Purpose Foundry.md" },
              stations: [],
              updatedAt: Date.now(),
            },
            201,
          );
        }
        if (url === "/api/foundry/projects") return json({ projects });
        return json({ error: "not found" }, 404);
      }),
    );

    render(<FoundryFloor />);

    expect(
      (
        screen.getByRole("button", {
          name: /Release to the line/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.change(await screen.findByLabelText("Job name"), {
      target: { value: "Unified core job" },
    });
    fireEvent.change(screen.getByLabelText("What this job is for"), {
      target: { value: "Build and verify the core product" },
    });
    expect(
      screen.getByLabelText("Purpose Foundry model routing"),
    ).toHaveTextContent(/Strongest configured paid model/i);
    const promoPilot = await screen.findByLabelText("Include promo-pilot");
    expect((promoPilot as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(promoPilot);
    expect(
      (screen.getByLabelText("Include scout") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Include flexfactor") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: /Release to the line/i }),
    );

    await waitFor(() => expect(posted.current).not.toBeNull());
    expect(posted.current).toMatchObject({
      name: "Unified core job",
      purpose: "Build and verify the core product",
      routingMode: "auto",
      selectedStations: ["promo-pilot"],
    });
    expect(posted.current?.selectedStations).not.toContain("factory-deck");
    expect(posted.current?.selectedStations).not.toContain(
      "app-store-publisher",
    );

    fireEvent.change(screen.getByLabelText("Obsidian note"), {
      target: { value: "# Obsidian job\nBuild the same product." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Take in note/i }));
    await waitFor(() => expect(obsidianPosted).not.toBeNull());
    expect(obsidianPosted).toMatchObject({
      routingMode: "auto",
      selectedStations: ["promo-pilot"],
    });
  });
});
