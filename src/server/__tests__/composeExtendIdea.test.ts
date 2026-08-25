import { describe, expect, it } from "vitest";
import {
  EXTEND_PERSISTENCE_CONTRACT,
  composeExtendIdea,
  withExtendPersistenceGoals,
} from "../orchestrator/composeExtendIdea.js";

describe("EXTEND PERSISTENCE CONTRACT", () => {
  it("protects existing applications without assuming one stack or schema dialect", () => {
    expect(EXTEND_PERSISTENCE_CONTRACT).toMatch(/EXTEND PERSISTENCE CONTRACT/);
    expect(EXTEND_PERSISTENCE_CONTRACT).toMatch(/repository-derived/);
    expect(EXTEND_PERSISTENCE_CONTRACT).toMatch(/_gh_\*/);
    expect(EXTEND_PERSISTENCE_CONTRACT).toMatch(/authoritative durable store/);
    expect(EXTEND_PERSISTENCE_CONTRACT).toMatch(/native mechanism/);
    expect(EXTEND_PERSISTENCE_CONTRACT).toMatch(/detected stores/);
    expect(EXTEND_PERSISTENCE_CONTRACT).toMatch(/instead of guessing/);
    expect(EXTEND_PERSISTENCE_CONTRACT).toMatch(/sibling/);
    expect(EXTEND_PERSISTENCE_CONTRACT).not.toMatch(/SQLite AND Postgres/);
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
        purposeEvidence: [],
      },
      ["Add invoicing"],
    );
    expect(idea).toContain("EXTEND PERSISTENCE CONTRACT");
    expect(idea).toContain("GrantFlow");
    expect(idea.match(/EXTEND PERSISTENCE CONTRACT/g)?.length).toBe(1);
  });
});
