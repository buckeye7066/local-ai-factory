import { describe, expect, it } from "vitest";
import { factoryIdeaFromInputs } from "../../cli/factoryInput.js";

describe("Factory Deck cloud prompt input", () => {
  it("prefers the exact environment prompt over positional arguments", () => {
    expect(
      factoryIdeaFromInputs(["node", "factory.ts", "ignored"], {
        FACTORY_IDEA: "  Build the exact paid proof.  ",
      }),
    ).toBe("Build the exact paid proof.");
  });

  it("does not interpret option-like environment prompts as CLI flags", () => {
    expect(
      factoryIdeaFromInputs(["node", "factory.ts"], {
        FACTORY_IDEA: "---\n--demo is text in this requested application",
      }),
    ).toBe("---\n--demo is text in this requested application");
  });

  it("retains positional and default behavior outside cloud verification", () => {
    expect(factoryIdeaFromInputs(["node", "factory.ts", "Build", "locally"], {})).toBe(
      "Build locally",
    );
    expect(factoryIdeaFromInputs(["node", "factory.ts"], {})).toBe(
      "Build a Bible reading habit tracker",
    );
  });
});
