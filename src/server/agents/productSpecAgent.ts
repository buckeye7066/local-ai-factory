import { ProductSpecSchema, type ProductSpec } from "../../shared/schemas.js";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";

/** Turns a raw idea into a structured product specification. */
export async function productSpecAgent(
  deps: AgentDeps,
  idea: string,
): Promise<ProductSpec> {
  return deps.provider.generateJson<ProductSpec>({
    system: `${SYSTEM_PREAMBLE}\nYou are the PRODUCT SPEC agent.`,
    prompt: `Produce a product spec for this app idea:

"${idea}"

Return JSON with:
- appName (string)
- tagline (string)
- targetUser (string)
- coreFeatures (array of plain strings — NOT objects)
- dataModel (array of { "entity": string, "fields": string[] } — NOT a keyed object)
- userFlows (array of plain strings)
- acceptanceCriteria (array of plain strings)

acceptanceCriteria MUST include at least two ease-of-use criteria a non-technical
user could check themselves (e.g. "a first-time user can complete the core task
from the opening screen without instructions", "every error message says what to
do next in plain words").`,
    schema: ProductSpecSchema,
    schemaName: "ProductSpec",
    temperature: 0.3,
    // Extend-mode composes a long idea (existing app + stack + goals), and a
    // real repo's spec comes back with 20-30 features across seven arrays.
    maxTokens: 16_000,
  });
}
