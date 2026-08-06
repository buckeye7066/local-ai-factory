import { ProductSpecSchema, type ProductSpec } from "../../shared/schemas.js";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";

/** Turns a raw idea into a structured product specification. */
export async function productSpecAgent(
  deps: AgentDeps,
  idea: string,
): Promise<ProductSpec> {
  return deps.provider.generateJson<ProductSpec>({
    system: `${SYSTEM_PREAMBLE}\nYou are the PRODUCT SPEC agent.`,
    prompt: `Produce a product spec for this app idea:\n\n"${idea}"\n\nInclude appName, a short tagline, targetUser, coreFeatures, a small dataModel (entities + fields), userFlows, and acceptanceCriteria.`,
    schema: ProductSpecSchema,
    schemaName: "ProductSpec",
    temperature: 0.3,
  });
}
