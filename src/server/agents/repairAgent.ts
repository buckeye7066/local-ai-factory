import {
  RepairResultSchema,
  type RepairResult,
  type QaReport,
  type FileBuild,
} from "../../shared/schemas.js";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";

/**
 * Takes QA issues + failing output and returns replacement file contents.
 * Only files already in the workspace may be modified; the orchestrator still
 * enforces the path jail when writing the returned files.
 */
export async function repairAgent(
  deps: AgentDeps,
  qa: QaReport,
  build: FileBuild,
  commandOutput: string,
): Promise<RepairResult> {
  const fileList = build.files.map((f) => f.path).join("\n");
  return deps.provider.generateJson<RepairResult>({
    system: `${SYSTEM_PREAMBLE}\nYou are the REPAIR agent. Fix only what the QA critic flagged. Return full replacement contents for each changed file. Do not invent new top-level files unless strictly required. Use relative paths only.`,
    prompt: `Fix these issues:\n${JSON.stringify(
      qa.issues,
      null,
      2,
    )}\n\nExisting files:\n${fileList}\n\nCOMMAND OUTPUT:\n${
      commandOutput || "(none)"
    }\n\nReturn { notes, files:[{path,purpose,contents}] } with corrected file contents.`,
    schema: RepairResultSchema,
    schemaName: "RepairResult",
    temperature: 0.2,
    maxTokens: 12000,
  });
}
