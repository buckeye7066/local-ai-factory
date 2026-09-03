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

  it("splits newline and semicolon sections without leaking across repos", () => {
    const routes = routePrompt(
      "FlexFactor: add prompt routing\nFactory Deck: add steering; FlexFactor: document the option",
      targets,
    );
    expect(routes[0]!.prompt).toContain("add prompt routing");
    expect(routes[0]!.prompt).toContain("document the option");
    expect(routes[0]!.prompt).not.toContain("add steering");
    expect(routes[1]!.prompt).toContain("add steering");
    expect(routes[1]!.prompt).not.toContain("document the option");
  });

  it("leaves an unmentioned target empty instead of leaking named work", () => {
    const routes = routePrompt("FlexFactor: repair billing.", targets);
    expect(routes[0]!.prompt).toContain("repair billing");
    expect(routes[1]!.prompt).toBe("");
  });

  it("keeps shared words and incidental repo names inside the addressed target", () => {
    const routes = routePrompt(
      "FlexFactor: show all programs and call Factory Deck only after login.",
      targets,
    );
    expect(routes[0]!.prompt).toContain("show all programs");
    expect(routes[1]!.prompt).toBe("");
  });

  it("keeps bullets under their target heading", () => {
    const routes = routePrompt(
      "FlexFactor:\n- add prompt routing\n- add routing tests\nFactory Deck:\n- add live steering",
      targets,
    );
    expect(routes[0]!.prompt).toContain("add prompt routing");
    expect(routes[0]!.prompt).toContain("add routing tests");
    expect(routes[0]!.prompt).not.toContain("live steering");
    expect(routes[1]!.prompt).toContain("live steering");
    expect(routes[1]!.prompt).not.toContain("routing tests");
  });
});
