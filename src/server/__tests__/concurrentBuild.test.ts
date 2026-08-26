import { describe, it, expect } from "vitest";
import { buildFilesConcurrently } from "../orchestrator/concurrentBuild.js";
import type { LLMProvider, GenerateJsonInput } from "../../shared/types.js";
import type { ProductSpec, Architecture, TaskPlan } from "../../shared/schemas.js";

const spec: ProductSpec = {
  appName: "TestApp",
  tagline: "",
  targetUser: "testers",
  coreFeatures: ["feature 1"],
  dataModel: [],
  userFlows: [],
  acceptanceCriteria: ["works"],
};
const arch: Architecture = {
  overview: "o",
  frontend: "f",
  backend: "b",
  dataModel: "d",
  risks: [],
};

class FakeBuilderProvider implements LLMProvider {
  calls = 0;
  constructor(readonly name: "free" | "anthropic" | "openai" | "mock" | "stub") {}
  isConfigured() {
    return true;
  }
  async generateText() {
    return { text: "", provider: this.name };
  }
  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    this.calls += 1;
    // The prompt embeds the plan (JSON.stringify) — pull the category out of it
    // so each dispatched call produces a distinguishable, traceable file.
    const match = input.prompt.match(/"category":"(\w+)"/);
    const category = match ? match[1] : "unknown";
    return input.schema.parse({
      files: [
        {
          path: `${category}.txt`,
          purpose: category,
          contents: `built by ${this.name}`,
        },
      ],
    }) as T;
  }
}

function planWithCategories(...categories: string[]): TaskPlan {
  return {
    tasks: categories.map((category, i) => ({
      order: i + 1,
      category: category as TaskPlan["tasks"][number]["category"],
      title: `task ${i}`,
      detail: "",
    })),
  };
}

describe("buildFilesConcurrently", () => {
  it("falls back to a single call on the primary provider with <2 providers configured", async () => {
    const primary = new FakeBuilderProvider("free");
    const plan = planWithCategories("frontend", "backend");
    const result = await buildFilesConcurrently(
      primary,
      [primary],
      spec,
      arch,
      plan,
      undefined,
    );
    expect(result.usedConcurrency).toBe(false);
    expect(primary.calls).toBe(1);
    expect(result.build.files).toHaveLength(1); // one combined call, one file back
  });

  it("falls back to a single call when there's only one task category, even with multiple providers", async () => {
    const primary = new FakeBuilderProvider("free");
    const other = new FakeBuilderProvider("anthropic");
    const plan = planWithCategories("frontend");
    const result = await buildFilesConcurrently(
      primary,
      [primary, other],
      spec,
      arch,
      plan,
      undefined,
    );
    expect(result.usedConcurrency).toBe(false);
    expect(primary.calls + other.calls).toBe(1);
  });

  it("dispatches one call PER CATEGORY concurrently across multiple providers and merges the files", async () => {
    const p1 = new FakeBuilderProvider("free");
    const p2 = new FakeBuilderProvider("anthropic");
    const plan = planWithCategories("frontend", "backend", "tests");
    const result = await buildFilesConcurrently(
      p1,
      [p1, p2],
      spec,
      arch,
      plan,
      undefined,
    );

    expect(result.usedConcurrency).toBe(true);
    // All 3 categories produced a file, merged into one build.
    const paths = result.build.files.map((f) => f.path).sort();
    expect(paths).toEqual(["backend.txt", "frontend.txt", "tests.txt"]);
    // Real work was spread across BOTH providers, not funneled through one.
    expect(Object.keys(result.tasksByProvider).length).toBe(2);
    expect(p1.calls + p2.calls).toBe(3);
  });

  it("passes the existing-repo context through in extend mode", async () => {
    const p1 = new FakeBuilderProvider("free");
    const p2 = new FakeBuilderProvider("anthropic");
    const plan = planWithCategories("frontend", "backend");
    const existing = {
      fileTreeExcerpt: "a.ts\nb.ts",
      manifestExcerpt: "{}",
      readmeExcerpt: "",
    };
    const result = await buildFilesConcurrently(
      p1,
      [p1, p2],
      spec,
      arch,
      plan,
      existing,
    );
    expect(result.usedConcurrency).toBe(true);
    expect(result.build.files.length).toBe(2);
  });
});

describe("no silent category loss (run f0077040 class)", () => {
  class EmptyForCategory extends FakeBuilderProvider {
    constructor(
      name: "free" | "anthropic" | "openai",
      readonly emptyCategory: string,
    ) {
      super(name);
    }
    override async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
      const match = input.prompt.match(/"category":"(\w+)"/);
      if (match && match[1] === this.emptyCategory) {
        return input.schema.parse({ files: [] }) as T;
      }
      return super.generateJson(input);
    }
  }

  it("an empty category fails schema (.min(1)) and is NAMED in failures - never silent", async () => {
    const p1 = new EmptyForCategory("free", "backend");
    const p2 = new EmptyForCategory("anthropic", "backend");
    const plan = planWithCategories("frontend", "backend");
    const existing = {
      fileTreeExcerpt: "a.ts",
      manifestExcerpt: "{}",
      readmeExcerpt: "",
    };
    const result = await buildFilesConcurrently(
      p1,
      [p1, p2],
      spec,
      arch,
      plan,
      existing,
    );
    expect(result.failures.some((f) => f.id.includes("backend"))).toBe(true);
    expect(result.build.files.map((f) => f.path)).toEqual(["frontend.txt"]);
  });

  class FailForCategory extends FakeBuilderProvider {
    constructor(
      name: "free" | "anthropic" | "openai",
      readonly failCategory: string,
    ) {
      super(name);
    }
    override async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
      const match = input.prompt.match(/"category":"(\w+)"/);
      if (match && match[1] === this.failCategory) {
        throw new Error(`${this.name} exploded on ${this.failCategory}`);
      }
      return super.generateJson(input);
    }
  }

  it("a category that fails on every provider is reported with its reason", async () => {
    const p1 = new FailForCategory("free", "backend");
    const p2 = new FailForCategory("anthropic", "backend");
    const plan = planWithCategories("frontend", "backend");
    const existing = {
      fileTreeExcerpt: "a.ts",
      manifestExcerpt: "{}",
      readmeExcerpt: "",
    };
    const result = await buildFilesConcurrently(
      p1,
      [p1, p2],
      spec,
      arch,
      plan,
      existing,
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].id).toContain("backend");
    expect(result.failures[0].reason).toMatch(/exploded on backend/);
  });
});
