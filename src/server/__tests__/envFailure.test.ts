import { describe, expect, it } from "vitest";
import { classifyEnvironmentFailure } from "../orchestrator/envFailure.js";

const failing = (command: string, outputTail: string) => ({
  executed: [{ command, exitCode: 1, outputTail }],
});

describe("classifyEnvironmentFailure", () => {
  it("classifies the verbatim d687f5fd missing-binding failure", () => {
    // The real output that burned three paid repair loops on 2026-08-15.
    const hit = classifyEnvironmentFailure(
      failing(
        "npm test",
        "Error: Could not locate the bindings file. Tried:\n" +
          " → C:\\ws\\node_modules\\better-sqlite3\\build\\better_sqlite3.node",
      ),
    );
    expect(hit?.signature).toBe("native_binding_missing");
    expect(hit?.command).toBe("npm test");
    expect(hit?.remedy).toMatch(/rebuild/i);
  });

  it("classifies ABI mismatches, gyp failures, missing binaries, and engine refusals", () => {
    expect(
      classifyEnvironmentFailure(
        failing(
          "npm test",
          "Error: The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115. This version requires NODE_MODULE_VERSION 137.",
        ),
      )?.signature,
    ).toBe("native_abi_mismatch");
    expect(
      classifyEnvironmentFailure(
        failing("npm ci", "gyp ERR! stack Error: not found: msbuild"),
      ),
    ).toMatchObject({ signature: "native_toolchain_failure" });
    expect(
      classifyEnvironmentFailure(
        failing(
          "npm test",
          "'playwright' is not recognized as an internal or external command",
        ),
      ),
    ).toMatchObject({ signature: "missing_binary" });
    expect(
      classifyEnvironmentFailure(
        failing("npm ci", "npm ERR! code EBADENGINE\nUnsupported engine"),
      ),
    ).toMatchObject({ signature: "engine_mismatch" });
  });

  it("classifies disk, memory, network, and timeout environment failures", () => {
    expect(
      classifyEnvironmentFailure(
        failing("npm test", "Error: ENOSPC: no space left on device, write"),
      )?.signature,
    ).toBe("disk_full");
    expect(
      classifyEnvironmentFailure(
        failing("npm test", "FATAL ERROR: JavaScript heap out of memory"),
      )?.signature,
    ).toBe("out_of_memory");
    expect(
      classifyEnvironmentFailure(
        failing("npm test", "fetch failed: connect ECONNREFUSED 127.0.0.1:11434"),
      )?.signature,
    ).toBe("network_unreachable");
    expect(
      classifyEnvironmentFailure(failing("npm test", "request timed out after 30000ms"))
        ?.signature,
    ).toBe("request_timeout");
  });

  it("does NOT classify ordinary repairable failures (lint, unit assertions)", () => {
    expect(
      classifyEnvironmentFailure(
        failing(
          "npm test",
          "error  Strings must use singlequote  quotes\n✖ 3 problems (2 errors, 1 warning)\nAssertionError: expected 4 to be 5",
        ),
      ),
    ).toBeNull();
  });

  it("ignores signature text inside PASSING commands (a test asserting on these messages is not a failure)", () => {
    expect(
      classifyEnvironmentFailure({
        executed: [
          {
            command: "npm test",
            exitCode: 0,
            outputTail:
              "✓ classifies 'Could not locate the bindings file' (envFailure.test.ts)",
          },
        ],
      }),
    ).toBeNull();
  });

  it("returns null with no executed evidence at all", () => {
    expect(classifyEnvironmentFailure({ executed: [] })).toBeNull();
  });
});
