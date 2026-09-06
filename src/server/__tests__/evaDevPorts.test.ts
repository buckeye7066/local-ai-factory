import { describe, expect, it } from "vitest";
import { developmentServerConfig } from "../../../vite.config.js";

describe("EVA development port isolation", () => {
  it("preserves existing developer defaults and loopback binding", () => {
    const config = developmentServerConfig({});
    expect(config.port).toBe(5190);
    expect(config.host).toBe("127.0.0.1");
    expect(config.strictPort).toBe(true);
    expect(config.proxy["/api"].target).toBe("http://127.0.0.1:5179");
  });

  it("moves the API proxy with the disposable test server", () => {
    const config = developmentServerConfig({
      FACTORY_UI_PORT: "45206",
      FACTORY_API_PROXY_PORT: "45106",
    });
    expect(config.port).toBe(45206);
    expect(config.proxy["/api"].target).toBe("http://127.0.0.1:45106");
    expect(config.strictPort).toBe(true);
  });

  it("rejects invalid ports and UI/API collisions", () => {
    for (const invalid of ["0", "-1", "65536", "1.5", "5179junk", " "]) {
      for (const key of ["FACTORY_UI_PORT", "FACTORY_API_PROXY_PORT"]) {
        expect(() => developmentServerConfig({ [key]: invalid })).toThrow();
      }
    }
    expect(() =>
      developmentServerConfig({
        FACTORY_UI_PORT: "45106",
        FACTORY_API_PROXY_PORT: "45106",
      }),
    ).toThrow("must differ");
  });
});
