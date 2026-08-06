import {
  TestPlanSchema,
  type TestPlan,
  type ProductSpec,
  type FileBuild,
} from "../../shared/schemas.js";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";

/** Writes a test plan plus at least one runnable unit/smoke test. */
export async function testWriterAgent(
  deps: AgentDeps,
  spec: ProductSpec,
  build: FileBuild,
): Promise<TestPlan> {
  const fileList = build.files.map((f) => f.path).join("\n");
  return deps.provider.generateJson<TestPlan>({
    system: `${SYSTEM_PREAMBLE}\nYou are the TEST WRITER agent. Prefer Vitest. Include at least one meaningful unit or smoke test.`,
    prompt: `Write tests for this app. Existing files:\n${fileList}\n\nSPEC:\n${JSON.stringify(
      spec,
    )}\n\nReturn a testPlan string and test files (path, purpose, contents). Use relative paths only.`,
    schema: TestPlanSchema,
    schemaName: "TestPlan",
    temperature: 0.2,
  });
}
