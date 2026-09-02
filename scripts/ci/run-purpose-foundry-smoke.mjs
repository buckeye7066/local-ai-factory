const base = process.env.FACTORY_BASE_URL || "http://127.0.0.1:5179";
const timeoutMs = Number(process.env.PURPOSE_FOUNDRY_SMOKE_TIMEOUT_MS || 21000000);
const deadline = Date.now() + timeoutMs;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, init) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

while (Date.now() < deadline) {
  try {
    await request("/api/health");
    break;
  } catch {
    await sleep(1000);
  }
}
if (Date.now() >= deadline) throw new Error("Factory Deck server did not become healthy.");

const project = await request("/api/foundry/projects", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    name: "purpose-foundry-smoke",
    purpose: "Build and verify a minimal accessible task checklist as a private local artifact.",
    targetUsers: ["individual users"],
    successCriteria: [
      "Users can add, complete, and delete tasks.",
      "Tasks persist after reload.",
      "Automated tests verify the primary workflow.",
    ],
    constraints: ["No external repository or deployment.", "Use a minimal maintainable implementation."],
    nonGoals: ["Authentication", "Payments", "Public deployment"],
    targets: [],
    source: "api",
    routingMode: "paid",
    selectedStations: ["factory-deck", "crucible", "watchtower"],
  }),
});

await request(`/api/foundry/projects/${project.id}/start`, { method: "POST" });
let last = "";
let current = project;
while (Date.now() < deadline) {
  current = await request(`/api/foundry/projects/${project.id}`);
  const state = current.stations
    .filter((station) => station.status !== "not_selected")
    .map((station) => `${station.stationId}=${station.status}`)
    .join(" ");
  if (state !== last) {
    console.log(`[purpose-foundry] project=${current.status} ${state}`);
    last = state;
  }
  if (["completed", "failed", "needs_attention"].includes(current.status)) break;
  await sleep(5000);
}

if (current.status !== "completed") {
  const details = current.stations
    .filter((station) => station.status === "failed" || station.status === "needs_attention")
    .map((station) => `${station.stationId}: ${station.summary}`)
    .join("; ");
  throw new Error(`Purpose Foundry ended ${current.status}: ${details || "no terminal detail"}`);
}

const readiness = await request(`/api/foundry/projects/${project.id}/readiness`);
if (readiness.status !== "ready" || readiness.receipt?.ready !== true) {
  throw new Error(`Purpose Foundry completed without a ready receipt: ${JSON.stringify(readiness)}`);
}

console.log(
  `[purpose-foundry] PRODUCTION READY project=${project.id} digest=${readiness.receipt.evidenceDigest}`,
);
