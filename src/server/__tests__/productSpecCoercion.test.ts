import { describe, it, expect } from "vitest";
import { ProductSpecSchema, ArchitectureSchema } from "../../shared/schemas.js";

describe("ProductSpecSchema LLM shape coercion", () => {
  it("accepts object-shaped coreFeatures/userFlows and map-shaped dataModel", () => {
    const parsed = ProductSpecSchema.parse({
      appName: "StickyCounter",
      tagline: "Count sticky notes",
      targetUser: "Desk workers",
      coreFeatures: [
        { name: "Add note", description: "Create a sticky" },
        { title: "Increment counter" },
        "Reset",
      ],
      dataModel: {
        Note: { id: "string", text: "string", count: "number" },
        Settings: ["theme", "color"],
      },
      userFlows: [{ flow: "Add a note", detail: "click +" }, "Reset all"],
      acceptanceCriteria: [{ criterion: "User can add a note" }, "Counter updates"],
    });

    expect(parsed.coreFeatures.length).toBeGreaterThanOrEqual(3);
    expect(parsed.coreFeatures.every((s) => typeof s === "string")).toBe(true);
    expect(parsed.dataModel.some((e) => e.entity === "Note")).toBe(true);
    expect(parsed.userFlows.length).toBeGreaterThanOrEqual(2);
    expect(parsed.acceptanceCriteria.length).toBeGreaterThanOrEqual(2);
  });
});

describe("ArchitectureSchema LLM shape coercion", () => {
  it("coerces object fields into strings", () => {
    const parsed = ArchitectureSchema.parse({
      overview: { summary: "SPA counter" },
      frontend: { stack: "Vite+React" },
      backend: { note: "none — localStorage" },
      dataModel: { Note: ["id", "text"] },
      risks: [{ title: "Data loss", detail: "no sync" }, "XSS on note text"],
    });
    expect(typeof parsed.overview).toBe("string");
    expect(parsed.overview.length).toBeGreaterThan(0);
    expect(typeof parsed.frontend).toBe("string");
    expect(parsed.risks.every((r) => typeof r === "string")).toBe(true);
  });
});
