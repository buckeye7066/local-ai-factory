import {
  FileBuildSchema,
  type FileBuild,
  type ProductSpec,
  type Architecture,
  type TaskPlan,
} from "../../shared/schemas.js";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";

/**
 * Generates the actual app files. Each file has a path, a purpose, and full
 * contents. The orchestrator writes these into the workspace (jailed).
 */
export async function fileBuilderAgent(
  deps: AgentDeps,
  spec: ProductSpec,
  arch: Architecture,
  plan: TaskPlan,
): Promise<FileBuild> {
  return deps.provider.generateJson<FileBuild>({
    system: `${SYSTEM_PREAMBLE}\nYou are the FILE BUILDER agent. Output a complete, runnable Vite + React + TypeScript app by default. Use relative paths only (no leading slash, no "..").`,
    prompt: `Build the files for this app. Include package.json, index.html, src/main.tsx, src/App.tsx, styles, and a README.md. If the app needs an API, add a tiny local backend.\n\nSPEC:\n${JSON.stringify(
      spec,
    )}\n\nARCHITECTURE:\n${JSON.stringify(arch)}\n\nPLAN:\n${JSON.stringify(
      plan,
    )}\n\nReturn { files: [{ path, purpose, contents }] }.`,
    schema: FileBuildSchema,
    schemaName: "FileBuild",
    temperature: 0.2,
    maxTokens: 16000,
  });
}
