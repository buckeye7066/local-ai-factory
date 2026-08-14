import { QaReportSchema, type QaReport, type FileBuild } from "../../shared/schemas.js";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";

/**
 * Reviews generated files + any command/test output and returns structured
 * issues with severities and concrete repair instructions.
 */
export async function qaCriticAgent(
  deps: AgentDeps,
  build: FileBuild,
  commandOutput: string,
): Promise<QaReport> {
  const fileList = build.files.map((f) => `- ${f.path}: ${f.purpose}`).join("\n");
  return deps.provider.generateJson<QaReport>({
    system: `${SYSTEM_PREAMBLE}\nYou are the QA CRITIC agent. Be strict but fair. Only flag issues that genuinely block the app from running or passing tests.`,
    prompt: `Review this build.\n\nFILES:\n${fileList}\n\nCOMMAND / TEST OUTPUT:\n${
      commandOutput || "(no commands executed)"
    }\n\nReturn { summary, passed, issues:[{severity,title,detail,file,repairInstruction}] }. Set passed=true only if there are no high or critical issues.`,
    schema: QaReportSchema,
    schemaName: "QaReport",
    temperature: 0.2,
  });
}
