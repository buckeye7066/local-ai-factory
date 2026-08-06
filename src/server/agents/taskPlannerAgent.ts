import {
  TaskPlanSchema,
  type TaskPlan,
  type ProductSpec,
  type Architecture,
} from "../../shared/schemas.js";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";

/** Produces an ordered, categorized build plan. */
export async function taskPlannerAgent(
  deps: AgentDeps,
  spec: ProductSpec,
  arch: Architecture,
): Promise<TaskPlan> {
  return deps.provider.generateJson<TaskPlan>({
    system: `${SYSTEM_PREAMBLE}\nYou are the TASK PLANNER agent.`,
    prompt: `Given this spec and architecture, produce an ordered list of concrete build tasks. Separate them by category (frontend, backend, database, tests, docs).\n\nSPEC:\n${JSON.stringify(
      spec,
    )}\n\nARCHITECTURE:\n${JSON.stringify(arch)}`,
    schema: TaskPlanSchema,
    schemaName: "TaskPlan",
    temperature: 0.2,
  });
}
