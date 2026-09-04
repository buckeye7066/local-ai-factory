import { describe, expect, it } from "vitest";
import {
  FactoryCliArgumentError,
  factoryIdeaFromInputs,
  parseFactoryCliInputs,
} from "../../cli/factoryInput.js";

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

  it("accepts assignment-style demo syntax without starting a live run", () => {
    expect(
      parseFactoryCliInputs(
        ["node", "factory.ts", "--demo=true", "Build", "offline"],
        {},
      ),
    ).toEqual({ idea: "Build offline", demo: true });
  });

  it.each(["--demo=false", "--dmeo", "--unknown", "-d"])(
    "rejects unknown option %s instead of silently starting live work",
    (option) => {
      expect(() =>
        parseFactoryCliInputs(["node", "factory.ts", option, "Build", "this"], {}),
      ).toThrow(FactoryCliArgumentError);
    },
  );
});
