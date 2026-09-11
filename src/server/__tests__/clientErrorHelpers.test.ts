import { describe, expect, it } from "vitest";
import { clientErrorStatus } from "../errors.js";
import {
  LOCAL_PROJECT_IDENTITY_REQUIRED,
  localProjectIdentityProblem,
  projectKeyForOptions,
} from "../orchestrator/projectMemory.js";

describe("clientErrorStatus", () => {
  it("returns an exposed 4xx from middleware errors", () => {
    expect(clientErrorStatus({ status: 400, expose: true })).toBe(400);
    expect(clientErrorStatus({ statusCode: 413, expose: true })).toBe(413);
  });

  it("treats unexposed, 5xx, and plain errors as server faults", () => {
    expect(clientErrorStatus({ status: 400 })).toBeNull();
    expect(clientErrorStatus({ status: 500, expose: true })).toBeNull();
    expect(clientErrorStatus(new Error("boom"))).toBeNull();
    expect(clientErrorStatus(null)).toBeNull();
  });
});

describe("localProjectIdentityProblem mirrors intake's deterministic refusals", () => {
  const cases = [
    { options: {}, refused: true },
    { options: { mode: "new" as const }, refused: true },
    { options: { newRepo: { name: "app", createRemote: false } }, refused: true },
    {
      options: { newRepo: { name: "app", createRemote: false }, projectId: "app" },
      refused: false,
    },
    { options: { projectId: "app" }, refused: false },
    { options: { newRepo: { name: "app" } }, refused: false },
    { options: { mode: "extend" as const }, refused: false },
    { options: { demo: true }, refused: false },
  ];

  it.each(cases)("options %j refused=$refused", ({ options, refused }) => {
    expect(localProjectIdentityProblem(options)).toBe(
      refused ? LOCAL_PROJECT_IDENTITY_REQUIRED : null,
    );
    if (refused) {
      // Never refuse a request intake would have accepted.
      expect(
        projectKeyForOptions(options, {
          localProjectId: (options as { projectId?: string }).projectId,
        }),
      ).toBeNull();
    }
  });
});
