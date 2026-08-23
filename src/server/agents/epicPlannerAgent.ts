import { z } from "zod";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";

/**
 * epicPlannerAgent — the factory's answer to tasks bigger than one run.
 *
 * Owner order 2026-08-16: "Look at the purpose factory deck was created. help
 * it reach that purpose even with larger systems and evolutions." The
 * grant-OS post-mortem showed WHY one run cannot absorb a mature codebase: a
 * model in over its head does not say so — it emits plausible paper that
 * survives the checks it knows about. The fix is not a smarter single run; it
 * is many HONEST small runs. This agent turns one oversized evolution into an
 * ordered list of slices, each small enough for one run to genuinely wire,
 * verify, and auto-release before the next slice begins on the merged result.
 */

export const EpicSliceSchema = z.object({
  title: z.string().min(1).max(120),
  /** The complete, self-contained goal text handed to the slice's run. */
  goals: z.string().min(1),
  /** Real files/modules/routes the slice must touch — wiring targets, not paper. */
  wiringTargets: z.array(z.string().min(1)).min(1),
  /** Checkable, behavior-level acceptance criteria for the slice. */
  acceptance: z.array(z.string().min(1)).min(1),
});
export type EpicSlice = z.infer<typeof EpicSliceSchema>;

export const EpicPlanSchema = z.object({
  summary: z.string().min(1),
  slices: z.array(EpicSliceSchema).min(2).max(12),
});
export type EpicPlan = z.infer<typeof EpicPlanSchema>;

export async function epicPlannerAgent(
  deps: AgentDeps,
  input: {
    idea: string;
    /** Repo context excerpts (file tree, manifest, README) when available. */
    existingContext?: string | null;
  },
): Promise<EpicPlan> {
  return deps.provider.generateJson<EpicPlan>({
    system:
      `${SYSTEM_PREAMBLE}\n` +
      `You are the EVOLUTION PLANNER agent. A large product evolution cannot be built in one pass — ` +
      `you break it into 2-12 ordered SLICES, each small enough for one build run to genuinely implement, ` +
      `wire into the real product code, and pass the host repo's full test suite. Rules for every slice: ` +
      `(1) it must change real product behavior — documentation-only, test-only, or schema-only slices are ` +
      `forbidden (they are refused release downstream); (2) name the REAL files/modules/routes it wires into ` +
      `under wiringTargets — if you cannot name a real integration point, the slice is not ready to schedule; ` +
      `(3) each slice must leave the product working and releasable on its own — slices merge one at a time ` +
      `and later slices build on the merged result; (4) order by dependency, then by user value; ` +
      `(5) goals must be self-contained — the run that executes a slice sees ONLY that slice's goals text.`,
    prompt:
      `Plan the evolution described below into ordered slices.\n\nEVOLUTION REQUEST:\n${input.idea}\n\n` +
      (input.existingContext
        ? `EXISTING CODEBASE CONTEXT:\n${input.existingContext}\n\n`
        : "") +
      `Return { summary, slices: [{ title, goals, wiringTargets, acceptance }] }.`,
    schema: EpicPlanSchema,
    schemaName: "EpicPlan",
    intent: { role: "judge", needs: ["structured_json"] },
    temperature: 0.2,
    maxTokens: 16_000,
  });
}
