/**
 * glimmer.ts — run the deck on Muse Glimmer alone.
 *
 *   pnpm glimmer                      # status: installed? pinned? how fast?
 *   pnpm glimmer on                   # pin factory-deck to Glimmer
 *   pnpm glimmer on --app purpose-foundry
 *   pnpm glimmer on --app global      # every consumer, FlexFactor included
 *   pnpm glimmer off                  # release the pin, rotation resumes
 *
 * Why a pin rather than rotation membership (owner decision 2026-08-22):
 * Glimmer is excluded from the rotation ring on this machine because rotation
 * is cheapest-first and a local model is cost class 0, so it would be selected
 * FIRST on every sweep while generating at ~1.6 tok/s. See
 * `rotationExcludedReason` in server/providers/routeFitness.ts. A pin is the
 * deliberate, visible opposite of that: it says "use this one, on purpose".
 *
 * The exclusion is pin-aware (filterRoutableCatalog keeps a route the active
 * pin names), so `on` really does route work to Glimmer rather than producing
 * a PinUnavailable.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  StateStore,
  loadCatalog,
  rotationStatePath,
  unavailableReason,
} from "../server/rotation/aitimeRotation.js";

const MODEL = process.env.GLIMMER_MODEL || "muse-glimmer:30b";
const OLLAMA = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const KNOWN_APPS = ["factory-deck", "purpose-foundry", "global"];

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

/** Which Glimmer tags Ollama actually has right now. Live, not from cache. */
async function installedGlimmerTags(): Promise<string[] | null> {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? [])
      .map((m) => m.name ?? "")
      .filter((n) => n.toLowerCase().includes("glimmer"));
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let app = "factory-deck";
  let verb: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--app") {
      app = args[++i] || fail(`--app needs one of: ${KNOWN_APPS.join(" | ")}`);
    } else if (arg === "--model") {
      // Accepted for symmetry with rotation-pin; the tag still has to exist.
      process.env.GLIMMER_MODEL = args[++i] || fail("--model needs a value");
    } else if (arg.startsWith("--")) {
      fail(`unknown flag ${arg}`);
    } else if (verb === null) {
      verb = arg;
    } else {
      fail(`unexpected argument ${arg}`);
    }
  }
  if (verb && !["on", "off", "status"].includes(verb)) {
    fail(`unknown command "${verb}" — expected: on | off | status`);
  }
  if (!KNOWN_APPS.includes(app)) {
    console.warn(`note: "${app}" is not one of ${KNOWN_APPS.join(", ")}.`);
  }

  const store = new StateStore();

  if (verb === "off") {
    await store.setPin(null, app);
    console.log(`Glimmer released for "${app}" — rotation chooses again.`);
    return;
  }

  const tags = await installedGlimmerTags();

  if (!verb || verb === "status") {
    console.log(`rotation state : ${rotationStatePath()}`);
    const why = unavailableReason();
    console.log(
      why ? `rotation       : UNAVAILABLE — ${why}` : "rotation       : available",
    );
    if (tags === null) {
      console.log(`ollama         : UNREACHABLE at ${OLLAMA}`);
    } else if (tags.length === 0) {
      console.log("glimmer        : NOT INSTALLED — ollama pull muse-glimmer:30b");
    } else {
      console.log(`glimmer        : installed (${tags.join(", ")})`);
    }
    const pins = Object.entries(store.read().pin ?? {}).filter(([, v]) => v);
    if (pins.length === 0) console.log("pins           : none");
    else
      for (const [k, v] of pins)
        console.log(`pin[${k}]${" ".repeat(Math.max(0, 9 - k.length))}= ${v}`);
    console.log("");
    console.log("  pnpm glimmer on    # route this app's work to Glimmer");
    console.log("  pnpm glimmer off   # give it back to rotation");
    return;
  }

  // verb === "on"
  if (tags === null) {
    fail(
      `Ollama is not reachable at ${OLLAMA}, so I cannot confirm Glimmer is ` +
        `installed. Refusing to write a pin that may fail every call later.`,
    );
  }
  if (tags.length === 0) {
    fail(
      `No Glimmer model is installed in Ollama.\n` +
        `  Official build : ollama pull muse-glimmer:30b\n` +
        `  Your own quant : ollama create muse-glimmer:30b-q4kxl ` +
        `-f ${join(homedir(), "glimmer", "modelfiles", "Modelfile.q4kxl")}`,
    );
  }
  const target = tags.includes(MODEL) ? MODEL : tags[0];

  // The catalog is what rotation resolves a pin against. A pin naming a route
  // the catalog has never heard of fails at call time, far from here, so say it
  // now -- loudly -- rather than writing a booby-trap into shared state.
  const catalog = loadCatalog();
  if (!catalog) {
    console.warn(`warning: cannot read the route catalog (${unavailableReason()}).`);
    console.warn("         Refresh it with: python -m aitime.catalog");
  } else {
    const matches = catalog.routes.filter(
      (r) => r.id === target || r.model === target || r.wire_model === target,
    );
    if (matches.length === 0) {
      console.warn(
        `warning: "${target}" is installed in Ollama but absent from the route ` +
          `catalog (${catalog.routes.length} routes). Refresh it so rotation can ` +
          `resolve the pin:\n         python -m aitime.catalog`,
      );
    }
  }

  await store.setPin(target, app);
  console.log(`Glimmer pinned for "${app}": ${target}`);
  console.log("");
  console.log(
    "  Measured on this machine: ~1.6 tokens/second, 100% CPU, ~17 GB resident.",
  );
  console.log(
    "  A 2,000-token step takes roughly 20 minutes. That is expected, not a hang.",
  );
  console.log("");
  console.log(
    `  Release with: pnpm glimmer off${app === "factory-deck" ? "" : ` --app ${app}`}`,
  );
}

void main();
