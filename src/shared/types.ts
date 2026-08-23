import type { z } from "zod";
import type { ProviderName } from "./schemas.js";

/**
 * shared/types.ts — non-schema cross-cutting types.
 *
 * The provider interface lives here because it is the contract every LLM
 * backend (Anthropic, OpenAI, stub) implements identically. The orchestrator
 * depends only on this interface, never on a concrete SDK.
 */

/**
 * What a model call is FOR, so a rotating provider can fit the route to the
 * job instead of only to the cheapest ledger. Twin of flexfactor_rotation
 * .CallIntent. Every field optional: a call without an intent rotates exactly
 * as before.
 */
export interface CallIntent {
  /** author | reviewer | judge | vision */
  role?: "author" | "reviewer" | "judge" | "vision";
  /** Capabilities the route MUST have when its capability list is known. */
  needs?: Array<"code_author" | "structured_json" | "code_review" | "honest" | "vision">;
  /** Model family the route must not be, when any alternative exists. */
  avoidFamily?: string;
  /** Short slug of the program purpose this call serves (journaled). */
  purpose?: string;
}

export interface GenerateTextInput {
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  intent?: CallIntent;
}

export interface GenerateTextResult {
  text: string;
  provider: ProviderName;
}

export interface GenerateJsonInput<T> {
  system: string;
  prompt: string;
  // Third generic param (Input) is `unknown` so schemas with `.default()` —
  // whose parsed input has optional fields — are still assignable to ZodType<T>.
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Human-readable name of the shape, used to instruct the model. */
  schemaName: string;
  temperature?: number;
  maxTokens?: number;
  intent?: CallIntent;
}

export interface LLMProvider {
  name: ProviderName;
  /** True only when the provider has a usable API key (stub is always ready). */
  isConfigured(): boolean;
  generateText(input: GenerateTextInput): Promise<GenerateTextResult>;
  generateJson<T>(input: GenerateJsonInput<T>): Promise<T>;
}

/** Re-exported here so callers can import provider name from one place. */
export type { ProviderName };
