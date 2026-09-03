import { describe, expect, it } from "vitest";
import { routePrompt } from "./promptRouter.js";

const targets = [
  {
    id: "a",
    name: "FlexFactor",
    source: "https://github.com/acme/flexfactor.git",
  },
  {
    id: "b",
    name: "Factory Deck",
    source: "https://github.com/acme/local-ai-factory.git",
  },
];

describe("routePrompt", () => {
  it("routes named requirements and shares unscoped requirements", () => {
    const routes = routePrompt(
      "FlexFactor should accept a session prompt. Factory Deck should show live steering. Add tests.",
      targets,
    );
    expect(routes[0]!.prompt).toContain("FlexFactor should accept");
    expect(routes[0]!.prompt).toContain("Add tests");
    expect(routes[0]!.prompt).not.toContain("Factory Deck should show");
    expect(routes[1]!.prompt).toContain("Factory Deck should show");
    expect(routes[1]!.prompt).toContain("Add tests");
  });

  it("routes explicit shared language to every program", () => {
    const routes = routePrompt("Both programs must persist steering.", targets);
    expect(routes.every((route) => route.prompt.includes("persist steering"))).toBe(
      true,
    );
  });
});
