/**
 * rotation-pin.ts — the manual toggle for cross-app model rotation.
 *
 *   pnpm rotation:pin                          # show status + current pins
 *   pnpm rotation:pin openrouter/x-ai/grok-4.6 # pin factory-deck to one route
 *   pnpm rotation:pin groq --app global        # pin EVERY consumer to a backend
 *   pnpm rotation:pin --clear                  # unpin factory-deck
 *   pnpm rotation:pin --clear --app global     # unpin everyone
 *
 * A pin may name a route id, a backend, a pool, or a bare model id. Pins live
 * in the SHARED rotation state (%LOCALAPPDATA%\AITime\rotation-state.json), so
 * FlexFactor and Purpose Foundry see the same pin surface. Rotation itself is
 * disabled with AI_ROTATE=off, not with a pin.
 */
import {
  StateStore,
  loadCatalog,
  rotationStatePath,
  unavailableReason,
} from "../server/rotation/aitimeRotation.js";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let app = "factory-deck";
  let clear = false;
  let target: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--app") {
      app =
        args[++i] ||
        fail("--app needs a value (factory-deck | purpose-foundry | global)");
    } else if (arg === "--clear") {
      clear = true;
    } else if (arg.startsWith("--")) {
      fail(`unknown flag ${arg}`);
    } else if (target === null) {
      target = arg;
    } else {
      fail(`unexpected argument ${arg}`);
    }
  }

  const store = new StateStore();

  if (clear) {
    if (target) fail("--clear does not take a target");
    await store.setPin(null, app);
    console.log(`pin cleared for "${app}" — rotation chooses again.`);
    return;
  }

  if (!target) {
    const state = store.read();
    const pins = Object.entries(state.pin ?? {}).filter(([, v]) => v);
    const reason = unavailableReason();
    console.log(`rotation state: ${rotationStatePath()}`);
    console.log(reason ? `rotation: UNAVAILABLE — ${reason}` : "rotation: available");
    if (pins.length === 0) {
      console.log("pins: none — every consumer rotates.");
    } else {
      for (const [key, value] of pins) console.log(`pin[${key}] = ${value}`);
    }
    return;
  }

  // Refuse a pin that names nothing — a typo'd pin would otherwise sit in
  // shared state failing every consumer's calls loudly later. Fail loudly NOW.
  const catalog = loadCatalog();
  if (!catalog) {
    fail(`cannot verify pin target: ${unavailableReason()}`);
  }
  const matches = catalog.routes.filter(
    (r) =>
      target === r.id ||
      target === r.backend ||
      target === r.pool ||
      target === r.model ||
      target === r.wire_model,
  );
  if (matches.length === 0) {
    fail(
      `"${target}" matches no route, backend, pool, or model among the ` +
        `${catalog.routes.length} routes in the catalog. Refresh with ` +
        `\`python -m aitime.catalog\` or check the spelling.`,
    );
  }

  await store.setPin(target, app);
  const enabled = matches.filter((r) => r.enabled).length;
  console.log(
    `pin[${app}] = ${target} — matches ${matches.length} route(s), ` +
      `${enabled} enabled. Clear with \`pnpm rotation:pin --clear` +
      (app === "factory-deck" ? "" : ` --app ${app}`) +
      "`.",
  );
}

void main();
