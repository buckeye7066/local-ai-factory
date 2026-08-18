import { describe, expect, it } from "vitest";
import {
  EXTEND_PERSISTENCE_CONTRACT,
  composeExtendIdea,
  withExtendPersistenceGoals,
} from "../orchestrator/composeExtendIdea.js";

describe("EXTEND PERSISTENCE CONTRACT", () => {
  it("names the measured ba870e71 pitfalls", () => {
    expect(EXTEND_PERSISTENCE_CONTRACT).toMatch(/EXTEND PERSISTENCE CONTRACT/);
    expect(EXTEND_PERSISTENCE_CONTRACT).toMatch(/_gh_\*/);
    expect(EXTEND_PERSISTENCE_CONTRACT).toMatch(/createStubEntityClient/);
    expect(EXTEND_PERSISTENCE_CONTRACT).toMatch(/ON CONFLICT/);
    expect(EXTEND_PERSISTENCE_CONTRACT).toMatch(/IF NOT EXISTS/);
    expect(EXTEND_PERSISTENCE_CONTRACT).toMatch(/sibling/);
  });

  it("appends the contract once to composed ideas and goal lists", () => {
    const goals = withExtendPersistenceGoals(["Add invoicing"]);
    expect(goals).toHaveLength(2);
    expect(goals[1]).toBe(EXTEND_PERSISTENCE_CONTRACT);
    expect(withExtendPersistenceGoals(goals)).toEqual(goals);

    const idea = composeExtendIdea(
      {
        rootPath: "/tmp/grantflow",
        appNameGuess: "GrantFlow",
        detectedStack: ["react", "express"],
        stackSummary: "React + Express",
        readmeExcerpt: "",
        fileTree: ["src/App.jsx"],
        manifestExcerpts: [],
      },
      ["Add invoicing"],
    );
    expect(idea).toContain("EXTEND PERSISTENCE CONTRACT");
    expect(idea).toContain("GrantFlow");
    expect(idea.match(/EXTEND PERSISTENCE CONTRACT/g)?.length).toBe(1);
  });
});
