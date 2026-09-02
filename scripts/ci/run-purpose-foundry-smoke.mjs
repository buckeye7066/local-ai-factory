import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const base = process.env.FACTORY_BASE_URL || "http://127.0.0.1:5179";
const timeoutMs = Number(process.env.PURPOSE_FOUNDRY_SMOKE_TIMEOUT_MS || 21000000);
const phase = process.env.PURPOSE_FOUNDRY_SMOKE_PHASE || "complete";
const deadline = Date.now() + timeoutMs;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const statePath = resolve(
  process.env.FACTORY_DATA_DIR || ".factory",
  "purpose-foundry-cloud-smoke.json",
);

async function request(path, init) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `${path} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${path} returned HTTP ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

async function waitForServer() {
  while (Date.now() < deadline) {
    try {
      await request("/api/health");
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error("Factory Deck server did not become healthy.");
}

async function saveProjectState(projectId) {
  const temporary = `${statePath}.tmp`;
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(
    temporary,
    `${JSON.stringify({ projectId, headSha: process.env.GITHUB_SHA || null })}\n`,
    "utf8",
  );
  await rename(temporary, statePath);
}

async function loadHeldProject() {
  const saved = JSON.parse(await readFile(statePath, "utf8"));
  if (typeof saved.projectId !== "string") {
    throw new Error("Purpose Foundry smoke state has no project id.");
  }
  if (
    saved.headSha &&
    process.env.GITHUB_SHA &&
    saved.headSha !== process.env.GITHUB_SHA
  ) {
    throw new Error(
      `Refused to resume Purpose Foundry state from ${saved.headSha} on ${process.env.GITHUB_SHA}.`,
    );
  }
  const project = await request(`/api/foundry/projects/${saved.projectId}`);
  const factory = project.stations.find(
    (station) => station.stationId === "factory-deck",
  );
  if (project.status !== "needs_attention" || factory?.status !== "needs_attention") {
    throw new Error(
      `Purpose Foundry resume expected a held Factory station, found project=${project.status} factory=${factory?.status || "missing"}.`,
    );
  }
  await request(`/api/foundry/projects/${project.id}/stations/factory-deck/run`, {
    method: "POST",
  });
  return project;
}

async function createProject() {
  const project = await request("/api/foundry/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "purpose-foundry-smoke",
      purpose:
        "Build and verify a minimal TypeScript command-line task checklist as a private local artifact. It must not create HTML, browser, or web UI files.",
      targetUsers: ["individual command-line users"],
      successCriteria: [
        "The CLI can add, list, complete, and delete tasks.",
        "Tasks persist in a local JSON file across separate CLI invocations.",
        "Automated tests execute and verify the complete primary CLI workflow.",
      ],
      constraints: [
        "No external repository or deployment.",
        "Command-line only; do not generate HTML, browser, or web UI code.",
        "Use a minimal maintainable TypeScript implementation.",
      ],
      nonGoals: [
        "Authentication",
        "Payments",
        "Public deployment",
        "Browser interface",
      ],
      targets: [],
      source: "api",
      routingMode: "paid",
    }),
  });
  await saveProjectState(project.id);
  await request(`/api/foundry/projects/${project.id}/start`, { method: "POST" });
  return project;
}

async function waitForTerminal(project) {
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
    if (["completed", "failed", "needs_attention"].includes(current.status)) {
      return current;
    }
    await sleep(5000);
  }
  throw new Error("Purpose Foundry did not reach a terminal state before timeout.");
}

function terminalDetails(project) {
  return project.stations
    .filter(
      (station) => station.status === "failed" || station.status === "needs_attention",
    )
    .map((station) => `${station.stationId}: ${station.summary}`)
    .join("; ");
}

async function main() {
  if (!["seed", "resume", "complete"].includes(phase)) {
    throw new Error(`Unknown PURPOSE_FOUNDRY_SMOKE_PHASE: ${phase}`);
  }
  await waitForServer();
  const project = phase === "resume" ? await loadHeldProject() : await createProject();
  const current = await waitForTerminal(project);

  if (phase === "seed") {
    const held = current.stations.filter(
      (station) => station.status === "failed" || station.status === "needs_attention",
    );
    if (
      current.status !== "needs_attention" ||
      held.length !== 1 ||
      held[0]?.stationId !== "factory-deck" ||
      held[0]?.status !== "needs_attention"
    ) {
      throw new Error(
        `Purpose Foundry seed did not stop at its Factory platform hold: ${terminalDetails(current) || current.status}`,
      );
    }
    console.log(`[purpose-foundry] HELD FOR PLATFORM PROOF project=${project.id}`);
    return;
  }

  if (current.status !== "completed") {
    throw new Error(
      `Purpose Foundry ended ${current.status}: ${terminalDetails(current) || "no terminal detail"}`,
    );
  }

  const readiness = await request(`/api/foundry/projects/${project.id}/readiness`);
  if (readiness.status !== "ready" || readiness.receipt?.ready !== true) {
    throw new Error(
      `Purpose Foundry completed without a ready receipt: ${JSON.stringify(readiness)}`,
    );
  }

  console.log(
    `[purpose-foundry] PRODUCTION READY project=${project.id} digest=${readiness.receipt.evidenceDigest}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
