/**
 * proof:free-route - prove the terminal $0 rung can serve a real model call.
 *
 * Production work does not start here: Factory Deck uses one automatic
 * paid-first model ladder and reaches this rung only after paid capacity is not
 * usable. This command isolates the terminal rung deliberately and proves that
 * doing so makes zero paid calls.
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

  console.log("Factory Deck - terminal free/local rung proof");
  console.log(`  freeConfigured : ${isFreeConfigured(config)}`);
  console.log(`  baseUrl        : ${config.free.baseUrl}`);
  console.log(`  model          : ${config.free.model}`);

  const liveness = await probeLiveness(config.free.baseUrl, config.free.ollamaUrl);
  console.log(`  liveness       : ${liveness.verdict} (${liveness.detail})`);

  const registry = createProviderRegistry(config, secrets, (kind, message) =>
    console.log(`  ${kind}: ${message}`),
  );
  const provider = registry.get("free");
  if (!provider.isConfigured()) {
    throw new Error("Terminal free/local rung is not configured.");
  }

  const before = snapshotRoute();
  const started = Date.now();
  const res = await provider.generateText({
    system: "You are terse.",
    prompt: "Reply with exactly: FREE ROUTE OK",
    maxTokens: 32,
  });
  const elapsedMs = Date.now() - started;
  const after = snapshotRoute();
  const budget = paidBudgetStatus();
  const paidCallsMade =
    after.counts.anthropic -
    before.counts.anthropic +
    (after.counts.openai - before.counts.openai);

  const payload = {
    ok: paidCallsMade === 0 && res.text.trim().length > 0,
    recorded_at: utc(),
    freeBaseUrl: config.free.baseUrl,
    freeModel: config.free.model,
    resolvedProvider: provider.name,
    servingProvider: after.serving,
    elapsedMs,
    responseText: res.text.trim().slice(0, 200),
    liveness,
    counts: after.counts,
    paidCallsMade,
    estimatedPaidSpendUsdLast24h: budget.usdLastDay,
    routeEvents: after.events,
  };

  if (payload.ok) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }
  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
