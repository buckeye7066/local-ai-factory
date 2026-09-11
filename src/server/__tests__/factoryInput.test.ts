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

  it("uses the positional idea outside cloud verification", () => {
    expect(factoryIdeaFromInputs(["node", "factory.ts", "Build", "locally"], {})).toBe(
      "Build locally",
    );
    expect(
      parseFactoryCliInputs(["node", "factory.ts", "Build", "locally"], {}),
    ).toEqual({ idea: "Build locally" });
  });

  it("refuses to start a real run on an idea the owner never gave", () => {
    expect(() => parseFactoryCliInputs(["node", "factory.ts"], {})).toThrow(
      FactoryCliArgumentError,
    );
    expect(() =>
      parseFactoryCliInputs(["node", "factory.ts"], { FACTORY_IDEA: "  " }),
    ).toThrow(/idea/i);
  });

  it.each(["--demo", "--demo=true", "--demo=false"])(
    "rejects the removed %s flag instead of running a mock preview",
    (option) => {
      expect(() =>
        parseFactoryCliInputs(["node", "factory.ts", option, "Build", "this"], {}),
      ).toThrow(/removed/);
    },
  );

  it.each(["--dmeo", "--unknown", "-d"])(
    "rejects unknown option %s instead of silently starting live work",
    (option) => {
      expect(() =>
        parseFactoryCliInputs(["node", "factory.ts", option, "Build", "this"], {}),
      ).toThrow(FactoryCliArgumentError);
    },
  );
});
