import {
  ProductSpecSchema,
  type ProductSpec,
  type PurposeProfile,
} from "../../shared/schemas.js";
import { withProductionAcceptanceCriteria } from "../workspace/completionEvidence.js";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";

const ProductSpecDraftSchema = ProductSpecSchema.omit({ purposeProfile: true });
type ProductSpecDraft = Omit<ProductSpec, "purposeProfile">;

/** Turns a raw idea into a structured product specification. */
export async function productSpecAgent(
  deps: AgentDeps,
  idea: string,
  purposeProfile?: PurposeProfile,
): Promise<ProductSpec> {
  const purposeContext = purposeProfile
    ? `\n\nEXISTING APP PURPOSE CONSTITUTION (citation-linked repository snapshot; interpretation is model-inferred):\n${JSON.stringify(
        purposeProfile,
        null,
        2,
      )}\n\nTreat the requested idea as a CHANGE to this existing app, not as permission to redefine it. Preserve cited invariants and core workflows unless the request explicitly requires a compatible evolution. Do not turn uncertainties into facts.`
    : "";
  const spec = await deps.provider.generateJson<ProductSpecDraft>({
    system: `${SYSTEM_PREAMBLE}\nYou are the PRODUCT SPEC agent.`,
    prompt: `Produce a product spec for this app idea:

"${idea}"${purposeContext}

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
do next in plain words"). When a purpose constitution is present, acceptance
criteria must also cover the affected cited workflows and invariants. Any
placeholder, TODO, FIXME, stubbed route, coming-soon surface, or missing code is
unfinished implementation, not an acceptable scaffold. Include executable
cross-platform criteria for every applicable surface: Safari/WebKit plus iOS and
Android mobile browser profiles for web apps, both native mobile targets for
mobile apps, and Windows plus macOS for local desktop/CLI apps.`,
    // Purpose evidence is orchestrator-owned. A model can neither mint nor
    // copy a profile into a greenfield spec through this output boundary.
    schema: ProductSpecDraftSchema,
    schemaName: "ProductSpec",
    intent: { role: "judge", needs: ["structured_json"] },
    temperature: 0.3,
    // Extend-mode composes a long idea (existing app + stack + goals), and a
    // real repo's spec comes back with 20-30 features across seven arrays.
    maxTokens: 16_000,
  });
  const hardened = withProductionAcceptanceCriteria(spec);
  return purposeProfile ? { ...hardened, purposeProfile } : hardened;
}
