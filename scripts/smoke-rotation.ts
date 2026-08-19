/**
 * smoke-rotation.ts — LIVE proof that pool-first rotation serves a real call.
 *
 * Builds the actual provider registry (rotation on, real AI Time catalog,
 * real shared state), resolves the live chain, and performs one real
 * generateText. $0 classes only — this can never spend money.
 *
 *   pnpm tsx scripts/smoke-rotation.ts
 */
import "dotenv/config";
import { loadConfig, loadSecrets } from "../src/server/config.js";
import { createProviderRegistry } from "../src/server/providers/index.js";

async function main(): Promise<void> {
  process.env.AI_ROTATE = process.env.AI_ROTATE || "on";
  const config = loadConfig();
  const secrets = loadSecrets();
  const registry = createProviderRegistry(
    config,
    secrets,
    (kind, message) => console.log(`[${kind}] ${message}`),
    undefined,
    "factory-deck",
  );
  const provider = registry.resolveLive(undefined, config.defaultCodeProvider);
  console.log(`resolved live provider: ${provider.name}`);
  const started = Date.now();
  const result = await provider.generateText({
    system: "You are a terse assistant.",
    prompt: "Reply with exactly: ROTATION-SMOKE-OK",
    maxTokens: 64,
  });
  console.log(
    `served in ${Math.round((Date.now() - started) / 1000)}s by provider=` +
      `${result.provider}: ${result.text.slice(0, 200).trim()}`,
  );
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
