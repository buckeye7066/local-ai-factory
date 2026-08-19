import { describe, expect, it } from "vitest";
import { describeUserFacingError, safeErrorMessage } from "../errors.js";

const SECRET = "sk-ant-DEADBEEFdeadbeef0123456789";

describe("describeUserFacingError", () => {
  it.each([
    [
      "network failures",
      Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:11434 ${SECRET}`), {
        code: "ECONNREFUSED",
      }),
      /could not reach the provider|could not reach/i,
      true,
    ],
    [
      "disk full failures",
      Object.assign(new Error("write ENOSPC: no space left on device"), {
        code: "ENOSPC",
      }),
      /disk is full/i,
      false,
    ],
    [
      "out of memory failures",
      Object.assign(new Error("JavaScript heap out of memory"), {
        code: "ENOMEM",
      }),
      /out of memory/i,
      false,
    ],
    [
      "API timeouts",
      Object.assign(new Error("Request timed out after 30000ms"), {
        code: "ETIMEDOUT",
        status: 408,
      }),
      /timed out/i,
      false,
    ],
    [
      "invalid model configuration",
      Object.assign(new Error(`400 invalid model parameter ${SECRET}`), {
        status: 400,
      }),
      /configured model|request parameters/i,
      true,
    ],
  ])(
    "surfaces clear, redacted messages for %s",
    (_label, err, pattern, expectsRedaction) => {
      const message = describeUserFacingError(err);
      expect(message).toMatch(pattern);
      expect(message).not.toContain(SECRET);
      if (expectsRedaction) expect(message).toMatch(/\[REDACTED/);
    },
  );
});

describe("safeErrorMessage", () => {
  it("redacts secrets from raw error text", () => {
    expect(safeErrorMessage(new Error(`OPENAI_API_KEY=${SECRET}`))).not.toContain(
      SECRET,
    );
  });
});
