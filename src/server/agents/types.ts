import type { LLMProvider } from "../../shared/types.js";

/**
 * agents/types.ts — every specialist agent is a pure async function that takes
 * a provider + typed input and returns a Zod-validated typed output. Agents
 * never touch the filesystem or the network directly; they only ask a provider
 * for structured data. This keeps them trivially testable with the stub.
 */
export interface AgentDeps {
  provider: LLMProvider;
}

export const SYSTEM_PREAMBLE =
  "You are a specialist agent inside a local AI software factory that builds small, working web apps. " +
  "Be concrete, pragmatic, and concise. Prefer Vite + React + TypeScript + Tailwind unless the idea clearly needs otherwise. " +
  "Never include secrets, API keys, or environment file contents in your output.";
