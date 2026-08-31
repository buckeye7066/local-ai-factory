import { z } from "zod";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";

/**
 * epicPlannerAgent — the factory's answer to tasks bigger than one run.
 *
 * A mature app evolution, large migration, curriculum corpus, documentation
 * corpus, media library, or other content-heavy product can be far larger than
 * a single model context or release. The planner turns that work into ordered,
 * independently releasable slices so Factory Deck can keep making verifiable
 * forward progress without pretending one huge generation is complete.
 */

export const EpicSliceSchema = z.object({
  title: z.string().min(1).max(120),
  /** The complete, self-contained goal text handed to the slice's run. */
  goals: z.string().min(1),
  /** Real files/modules/routes/data sets the slice must touch — wiring targets, not paper. */
  wiringTargets: z.array(z.string().min(1)).min(1),
  /** Checkable, behavior-level or content-quality acceptance criteria for the slice. */
  acceptance: z.array(z.string().min(1)).min(1),
});
export type EpicSlice = z.infer<typeof EpicSliceSchema>;

export const EpicPlanSchema = z.object({
  summary: z.string().min(1),
  // Large content programs such as K-12 curricula can legitimately require
  // dozens of independently releasable waves. Keep an upper bound so a bad
  // plan cannot create an unbounded queue, but do not force a 100-course
  // corpus into twelve unsafe mega-slices.
  slices: z.array(EpicSliceSchema).min(2).max(64),
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
      `You are the EVOLUTION PLANNER agent. A large product evolution cannot be built in one pass. ` +
      `Break it into 2-64 ordered SLICES, each small enough for one build run to genuinely implement, ` +
      `wire into the real product, verify, and auto-release before the next slice begins. ` +
      `Treat large CONTENT CORPORA (curricula, lesson libraries, templates, knowledge bases, media catalogs, ` +
      `localization sets, migration batches, generated datasets) as first-class product work when the runtime ` +
      `actually consumes that content. Do not compress a corpus into a handful of giant generations merely ` +
      `because it is data rather than executable code. For content-heavy work, choose a bounded natural unit ` +
      `(for example one course, one grade/subject pair, one module family, or another size that can be fully ` +
      `authored and validated in one run) and create as many slices as needed up to the cap. ` +
      `Rules for every slice: (1) it must change real product behavior OR real runtime-consumed product content; ` +
      `documentation-only, test-only, schema-only, placeholder-only, outline-only, or sample-only slices are forbidden; ` +
      `(2) name the REAL files/modules/routes/data manifests it wires into under wiringTargets; if you cannot name a ` +
      `real integration point, the slice is not ready to schedule; (3) each slice must leave the product working and ` +
      `releasable on its own; slices merge one at a time and later slices build on the merged result; ` +
      `(4) order by dependency, then by user value; (5) goals must be self-contained because the run executing a slice ` +
      `sees only that slice's goals text; (6) for authored coursework or other instructional content, require substantive ` +
      `finished material, assessments/answer keys where the product supports them, pacing/metadata expected by the app, ` +
      `and the repository's content validators. Never count a title list, outline, generated fallback, or sample lesson as ` +
      `completed coursework; (7) keep each slice small enough that all promised artifacts can be inspected and tested in ` +
      `the same run.`,
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
    maxTokens: 24_000,
  });
}
