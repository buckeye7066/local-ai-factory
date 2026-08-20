import type { LLMProvider } from "../../shared/types.js";
import { stampWorkTheme } from "../orchestrator/workTheme.js";

/**
 * agents/types.ts — every specialist agent is a pure async function that takes
 * a provider + typed input and returns a Zod-validated typed output. Agents
 * never touch the filesystem or the network directly; they only ask a provider
 * for structured data. This keeps them trivially testable with the stub.
 */
export interface AgentDeps {
  provider: LLMProvider;
}

const SYSTEM_PREAMBLE_BASE =
  "You are a specialist agent inside a local AI software factory that builds small, working web apps. " +
  "Be concrete, pragmatic, and concise. Prefer Vite + React + TypeScript + Tailwind unless the idea clearly needs otherwise. " +
  "Never include secrets, API keys, or environment file contents in your output. " +
  "USER-FRIENDLINESS IS A TOP PRIORITY (standing owner directive 2026-08-15): the person using the finished app is a " +
  "non-technical everyday user. Plain language everywhere — no jargon, no raw error dumps, no unexplained empty screens. " +
  "The first screen must make the next action obvious with zero instructions. Prefer sensible defaults over settings, " +
  "large clear controls, and forgiving inputs. Every failure the user can see must say what happened and what to do " +
  "next in words a non-programmer understands.";

/**
 * Shared system preamble. Template-string interpolation (`${SYSTEM_PREAMBLE}`)
 * calls toString(), which stamps the run's directed WorkTheme (when one is
 * bound via withWorkTheme) so every concurrent/rotated model stays on the
 * same open issue instead of wandering.
 */
export const SYSTEM_PREAMBLE = {
  toString: () => stampWorkTheme(SYSTEM_PREAMBLE_BASE),
  valueOf: () => stampWorkTheme(SYSTEM_PREAMBLE_BASE),
  [Symbol.toPrimitive]: () => stampWorkTheme(SYSTEM_PREAMBLE_BASE),
} as unknown as string;
