import { describe, it, expect } from "vitest";
import {
  clarificationAgent,
  looksLikeYesNoQuestion,
  ClarificationTurnSchema,
} from "../agents/clarificationAgent.js";
import type { LLMProvider, GenerateJsonInput } from "../../shared/types.js";

class ScriptedProvider implements LLMProvider {
  readonly name = "mock" as const;
  private calls = 0;
  constructor(private script: unknown[]) {}
  isConfigured() {
    return true;
  }
  async generateText() {
    return { text: "", provider: this.name };
  }
  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    const raw = this.script[this.calls] ?? this.script[this.script.length - 1];
    this.calls += 1;
    return input.schema.parse(raw) as T;
  }
}

describe("looksLikeYesNoQuestion", () => {
  it("accepts a genuine yes/no question", () => {
    expect(looksLikeYesNoQuestion("Should the dashboard be visible to students?")).toBe(
      true,
    );
    expect(
      looksLikeYesNoQuestion(
        "Do you want this to support multiple children per account?",
      ),
    ).toBe(true);
  });
  it("rejects open-ended questions", () => {
    expect(looksLikeYesNoQuestion("What features do you want?")).toBe(false);
    expect(looksLikeYesNoQuestion("How should this look?")).toBe(false);
    expect(looksLikeYesNoQuestion("Describe the target user.")).toBe(false);
  });
  it("rejects a non-question", () => {
    expect(looksLikeYesNoQuestion("This will support multiple children.")).toBe(false);
  });
});

describe("clarificationAgent", () => {
  it("asks a yes/no question when not yet confident", async () => {
    const provider = new ScriptedProvider([
      {
        confident: false,
        nextQuestion: "Should this be visible to parents too?",
        rationale: "",
        refinedGoals: [],
      },
    ]);
    const turn = await clarificationAgent(
      { provider },
      { initialRequest: "Add a progress dashboard", history: [] },
    );
    expect(turn.confident).toBe(false);
    expect(turn.nextQuestion).toBe("Should this be visible to parents too?");
  });

  it("returns refined goals once confident", async () => {
    const provider = new ScriptedProvider([
      {
        confident: true,
        nextQuestion: null,
        rationale: "enough detail",
        refinedGoals: [
          "Add a parent-visible progress dashboard",
          "Show per-subject completion percentage",
        ],
      },
    ]);
    const turn = await clarificationAgent(
      { provider },
      {
        initialRequest: "Add a progress dashboard",
        history: [
          { question: "Should this be visible to parents too?", answer: "yes" },
        ],
      },
    );
    expect(turn.confident).toBe(true);
    expect(turn.refinedGoals.length).toBeGreaterThan(0);
  });

  it("forces confidence when the model returns an open-ended question instead of yes/no", async () => {
    const provider = new ScriptedProvider([
      {
        confident: false,
        nextQuestion: "What should the dashboard show?",
        rationale: "",
        refinedGoals: [],
      },
    ]);
    const turn = await clarificationAgent(
      { provider },
      { initialRequest: "Add a progress dashboard", history: [] },
    );
    // Defense-in-depth: an invalid (non yes/no) question must never be handed
    // to the UI as if it were a valid turn — the loop terminates instead.
    expect(turn.confident).toBe(true);
    expect(turn.nextQuestion).toBeNull();
  });

  it("ClarificationTurnSchema round-trips a well-formed turn", () => {
    const parsed = ClarificationTurnSchema.parse({
      confident: false,
      nextQuestion: "Should grades sync automatically?",
      rationale: "need clarity on sync",
      refinedGoals: [],
    });
    expect(parsed.confident).toBe(false);
  });
});
