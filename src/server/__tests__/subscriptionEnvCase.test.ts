import { afterEach, expect, it, vi } from "vitest";
import { recursionGuardEnv } from "../providers/cliProvider.js";

afterEach(() => vi.unstubAllGlobals());
it("removes all casing variants without changing parent or unrelated routes", () => {
  const fixture = {
    OpenAI_Api_Key: "fixture-openai",
    anthropic_api_key: "fixture-anthropic",
    CodeX_Api_Key: "fixture-codex",
    Anthropic_Auth_Token: "fixture-proxy",
    openai_base_url: "https://example.invalid",
    Anthropic_Base_Url: "https://example.invalid",
    Claude_Code_Use_Bedrock: "1",
    claude_code_use_vertex: "1",
    CLAUDE_code_USE_foundry: "1",
    Anthropic_Profile: "fixture",
    anthropic_federation_rule_id: "fixture",
    Anthropic_Organization_Id: "fixture",
    PATH: "fixture-path",
    CLAUDE_CODE_OAUTH_TOKEN: "fixture-subscription",
  };
  vi.stubGlobal("process", { ...process, env: { ...fixture } });
  for (const api of ["claude-code", "codex-cli"]) {
    const child = recursionGuardEnv(api);
    for (const key of Object.keys(fixture)) {
      if (key !== "PATH" && key !== "CLAUDE_CODE_OAUTH_TOKEN")
        expect(child, `${api}: ${key}`).not.toHaveProperty(key);
    }
    expect(child.PATH).toBe(fixture.PATH);
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBe(fixture.CLAUDE_CODE_OAUTH_TOKEN);
    expect(process.env).toEqual(fixture);
  }
  expect(recursionGuardEnv("other")).toMatchObject(fixture);
});
