import {
  TaskPlanSchema,
  type TaskPlan,
  type ProductSpec,
  type Architecture,
  type PurposeProfile,
} from "../../shared/schemas.js";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";

/** Produces an ordered, categorized build plan. */
export async function taskPlannerAgent(
  deps: AgentDeps,
  spec: ProductSpec,
  arch: Architecture,
  purposeProfile?: PurposeProfile,
): Promise<TaskPlan> {
  const purposeContext = purposeProfile
    ? `\n\nEXISTING APP PURPOSE CONSTITUTION (citation-linked repository snapshot; interpretation is model-inferred):\n${JSON.stringify(
        purposeProfile,
        null,
        2,
      )}\n\nPlan explicit implementation and regression-test tasks for every affected core workflow and invariant. Cite relevant PE-* evidence IDs in task detail so the builder can trace why preserved behavior matters.`
    : "";
  return deps.provider.generateJson<TaskPlan>({
    system: `${SYSTEM_PREAMBLE}\nYou are the TASK PLANNER agent.`,
    prompt: `Given this spec and architecture, produce an ordered list of concrete build tasks.

Return JSON shaped exactly as:
{ "tasks": [ { "order": 1, "category": "frontend"|"backend"|"database"|"tests"|"docs", "title": string, "detail": string } ] }

SPEC:
${JSON.stringify(spec)}

ARCHITECTURE:
${JSON.stringify(arch)}${purposeContext}`,
    schema: TaskPlanSchema,
    schemaName: "TaskPlan",
    intent: { role: "judge", needs: ["structured_json"] },
    temperature: 0.2,
    // Spec + architecture in, an ordered task list out: the other big-output
    // agent that inherited the 8192 default. See architectAgent.
    maxTokens: 16_000,
  });
}
