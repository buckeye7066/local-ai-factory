import { z } from "zod";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";

/**
 * clarificationAgent.ts — the yes/no clarification loop. The owner states
 * what they want in free text; this agent asks ONE yes/no question at a time
 * until it is confident enough to hand off a concrete goal list — never an
 * open-ended question, per the owner's explicit format requirement.
 */

export const ClarificationTurnSchema = z.object({
  /** True once there is enough certainty to build exactly what's wanted. */
  confident: z.boolean(),
  /** Must be answerable with literally "yes" or "no". Null once confident. */
  nextQuestion: z.string().nullable().default(null),
  rationale: z.string().default(""),
  /** Concrete goal bullets — populated once confident=true. */
  refinedGoals: z.array(z.string()).default([]),
});
export type ClarificationTurn = z.infer<typeof ClarificationTurnSchema>;

export interface ClarificationHistoryItem {
  question: string;
  answer: "yes" | "no";
}

export interface ClarificationContext {
  initialRequest: string;
  history: ClarificationHistoryItem[];
}

/** True when a question is not phrased as a yes/no question. Best-effort heuristic. */
export function looksLikeYesNoQuestion(q: string): boolean {
  const t = q.trim();
  if (!t.endsWith("?")) return false;
  // Reject obviously open-ended stems.
  return !/^(what|which|how|why|describe|tell me|list)\b/i.test(t);
}

export async function clarificationAgent(
  deps: AgentDeps,
  ctx: ClarificationContext,
): Promise<ClarificationTurn> {
  const historyText = ctx.history.length
    ? ctx.history
        .map((h, i) => `${i + 1}. Q: ${h.question}\n   A: ${h.answer}`)
        .join("\n")
    : "(no questions asked yet)";

  const turn = await deps.provider.generateJson<ClarificationTurn>({
    system:
      `${SYSTEM_PREAMBLE}\nYou are the CLARIFICATION agent. Your job is to turn a vague request into a ` +
      `concrete, buildable goal list by asking YES/NO questions ONLY — never an open-ended question. ` +
      `Each question must be answerable with the single word "yes" or "no". Ask about the highest-leverage ` +
      `remaining ambiguity first. Stop asking (confident=true) as soon as you could hand this to an engineer ` +
      `and they'd build the right thing — do not over-ask.`,
    prompt: `Owner's initial request:\n"${ctx.initialRequest}"\n\nQuestions asked so far and answers:\n${historyText}\n\nDecide: are you confident enough to build this now? If not, ask exactly ONE yes/no question. If yes, set confident=true, nextQuestion=null, and return refinedGoals as a short list of concrete, buildable goal statements incorporating every "yes" answer as a requirement and every "no" answer as an exclusion.\n\nReturn { confident, nextQuestion, rationale, refinedGoals }.`,
    schema: ClarificationTurnSchema,
    schemaName: "ClarificationTurn",
    intent: { role: "judge", needs: ["structured_json"] },
    temperature: 0.2,
    maxTokens: 1200,
  });

  // Defense in depth: if the model produced an open-ended question despite the
  // instruction, force confidence rather than ship a broken conversation loop —
  // the owner's format requirement is yes/no, not "best effort."
  if (
    !turn.confident &&
    (!turn.nextQuestion || !looksLikeYesNoQuestion(turn.nextQuestion))
  ) {
    return {
      confident: true,
      nextQuestion: null,
      rationale:
        "Fell back to confident: the agent did not produce a valid yes/no question.",
      refinedGoals: turn.refinedGoals.length
        ? turn.refinedGoals
        : [
            ctx.initialRequest,
            ...ctx.history.map((h) => `${h.question} -> ${h.answer}`),
          ],
    };
  }
  return turn;
}
