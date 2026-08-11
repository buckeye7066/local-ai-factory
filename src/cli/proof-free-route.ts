/**
 * proof:free-route — prove the deck's own provider stack serves a real model
 * call from the FREE local route, at zero cost.
 *
 * This is deliberately ONE call rather than a full factory journey: a complete
 * assembly line on the free route is ~30 calls at 130-300s each, which is
 * hours. What needs proving here is narrower and sharper — that the deck's
 * configured chain resolves to free, actually reaches the local backend, and
 * reports free as the serving provider with zero paid calls.
 *
 * Writes docs/evidence/free-route-proof.json. Costs $0.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, getSecrets, isFreeConfigured } from "../server/config.js";
import { createProviderRegistry } from "../server/providers/index.js";
import { snapshotRoute, probeLiveness } from "../server/providers/freeRoute.js";
import { paidBudgetStatus } from "../server/providers/paidBudget.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = resolve(ROOT, "docs/evidence/free-route-proof.json");

function utc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function main() {
  const config = getConfig();
  const secrets = getSecrets();

  console.log("Factory Deck - FREE route proof");
  console.log(`  freeConfigured : ${isFreeConfigured(config)}`);
  console.log(`  baseUrl        : ${config.free.baseUrl}`);
  console.log(`  model          : ${config.free.model}`);
  console.log(`  defaultCode    : ${config.defaultCodeProvider}`);
  console.log(`  defaultReview  : ${config.defaultReviewProvider}`);

  const liveness = await probeLiveness(config.free.baseUrl, config.free.ollamaUrl);
  console.log(`  liveness       : ${liveness.verdict} (${liveness.detail})`);

  const registry = createProviderRegistry(config, secrets, (kind, message) =>
    console.log(`  ${kind}: ${message}`),
  );
  const provider = registry.resolveLive(undefined, config.defaultCodeProvider);
  console.log(`  resolved chain : ${provider.name}`);

  const started = Date.now();
  const res = await provider.generateText({
    system: "You are terse.",
    prompt: "Reply with exactly: FREE ROUTE OK",
    maxTokens: 32,
  });
  const elapsedMs = Date.now() - started;

  const route = snapshotRoute();
  const budget = paidBudgetStatus();
  const paidCalls = route.counts.anthropic + route.counts.openai;

  const payload = {
    ok: route.serving === "free" && paidCalls === 0 && res.text.trim().length > 0,
    recorded_at: utc(),
    freeBaseUrl: config.free.baseUrl,
    freeModel: config.free.model,
    defaultCodeProvider: config.defaultCodeProvider,
    defaultReviewProvider: config.defaultReviewProvider,
    resolvedProvider: provider.name,
    servingProvider: route.serving,
    elapsedMs,
    responseText: res.text.trim().slice(0, 200),
    liveness,
    counts: route.counts,
    paidCallsMade: paidCalls,
    wouldHaveFailedOver: route.wouldHaveFailedOver,
    backpressureRetries: route.backpressureRetries,
    estimatedPaidSpendUsdLast24h: budget.usdLastDay,
    routeEvents: route.events,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
