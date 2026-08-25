import {
  ArchitectureSchema,
  type Architecture,
  type ProductSpec,
  type PurposeProfile,
} from "../../shared/schemas.js";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";

/** Designs the technical architecture from the product spec. */
export async function architectAgent(
  deps: AgentDeps,
  spec: ProductSpec,
  purposeProfile?: PurposeProfile,
): Promise<Architecture> {
  const purposeContext = purposeProfile
    ? `\n\nEXISTING APP PURPOSE CONSTITUTION (citation-linked repository snapshot; interpretation is model-inferred):\n${JSON.stringify(
        purposeProfile,
        null,
        2,
      )}\n\nPreserve the detected application's established architecture, cited invariants, and core workflows. Recommend migration only when the requested change requires it; do not replace the current stack merely because another stack is the default.`
    : "";
  return deps.provider.generateJson<Architecture>({
    system: `${SYSTEM_PREAMBLE}\nYou are the ARCHITECT agent.`,
    prompt: `Design the architecture for this product spec:\n\n${JSON.stringify(
      spec,
      null,
      2,
    )}${purposeContext}\n\nKeep it as simple as possible. For a new app, prefer a local-first single-page app with no backend unless the features truly require one. Return overview, frontend, backend, dataModel, and risks.`,
    schema: ArchitectureSchema,
    schemaName: "Architecture",
    intent: { role: "judge", needs: ["structured_json"] },
    temperature: 0.3,
    // The prompt embeds the ENTIRE spec, which for an extend run against a real
    // repo is routinely 20-30 core features, and the answer (overview +
    // frontend + backend + dataModel + risks) scales with it. On the free
    // route's old 8192 default the model spent its budget and got cut off —
    // one of the two shapes that killed the architect stage on 2026-08-13.
    maxTokens: 16_000,
  });
}
