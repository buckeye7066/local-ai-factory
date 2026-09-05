#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"

catalog_dir="${RUNNER_TEMP}/aitime"
catalog_path="${catalog_dir}/routes.json"
state_path="${catalog_dir}/rotation-state.json"
container_name="aitime-ollama-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
ollama_url="http://127.0.0.1:11434"

mkdir -p "${catalog_dir}"
docker rm --force "${container_name}" >/dev/null 2>&1 || true

# The hosted proof must retain the same terminal rung as an installed Factory
# Deck. Ollama is the guaranteed $0 pool on an otherwise disposable runner.
# Keep a restart policy so one model-process crash does not permanently remove
# every free route for the remainder of a long production research run.
docker pull ollama/ollama:latest
docker run --detach \
  --restart on-failure:3 \
  --name "${container_name}" \
  --publish 127.0.0.1:11434:11434 \
  --env OLLAMA_KEEP_ALIVE=0 \
  ollama/ollama:latest >/dev/null

wait_for_ollama() {
  local ready=0
  for _ in $(seq 1 90); do
    if curl --fail --silent "${ollama_url}/api/tags" >/dev/null; then
      ready=1
      break
    fi
    sleep 1
  done
  [[ "${ready}" == "1" ]]
}

if ! wait_for_ollama; then
  docker logs "${container_name}" || true
  echo "Ollama did not become ready for the AI Time free rung." >&2
  exit 1
fi

# Ordered using AI Time's capability policy: retain every code-capable model
# that fits and can complete a real inference on this runner. The previous
# provisioner stopped after the first success, which made one later transport
# failure terminal even when a smaller verified model was already available.
read -r -a candidates <<< "${AITIME_OLLAMA_CANDIDATES:-qwen2.5-coder:7b qwen2.5-coder:3b}"
verified_models=()
for model in "${candidates[@]}"; do
  echo "Trying AI Time free candidate ${model}..."
  if ! wait_for_ollama; then
    echo "Ollama was unavailable before probing ${model}; attempting container restart."
    docker restart "${container_name}" >/dev/null
    wait_for_ollama || continue
  fi
  if ! docker exec "${container_name}" ollama pull "${model}"; then
    continue
  fi

  request="$(node -e '
    process.stdout.write(JSON.stringify({
      model: process.argv[1],
      stream: false,
      think: false,
      keep_alive: 0,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      options: { num_predict: 8, temperature: 0 }
    }));
  ' "${model}")"

  if response="$(curl --fail --silent --show-error --max-time 600 \
      --header "content-type: application/json" \
      --data "${request}" \
      "${ollama_url}/api/chat")" &&
    node -e '
      const body = JSON.parse(process.argv[1]);
      const text = body?.message?.content;
      if (typeof text !== "string" || text.trim().length === 0) process.exit(1);
    ' "${response}"; then
    verified_models+=("${model}")
    continue
  fi

  echo "Candidate ${model} could not complete inference; excluding it from this run."
done

if [[ "${#verified_models[@]}" -eq 0 ]]; then
  docker logs "${container_name}" || true
  echo "No AI Time free candidate could serve a real inference." >&2
  exit 1
fi

models_json="$(printf '%s\n' "${verified_models[@]}" | node -e '
  const fs = require("node:fs");
  const models = fs.readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
  process.stdout.write(JSON.stringify(models));
')"

node - "${catalog_path}" "${models_json}" <<'NODE'
const fs = require("node:fs");
const [catalogPath, modelsJson] = process.argv.slice(2);
const models = JSON.parse(modelsJson);
const tierFor = (model) => /(^|[^0-9])[0-9](\.[0-9])?[bB]($|[^0-9])/.test(model) ? "light" : "strong";
const catalog = {
  schema: 1,
  generated_at: new Date().toISOString(),
  backends: [
    {
      backend: "ollama",
      label: "Ollama (GitHub-hosted free fallback)",
      ok: true,
      source: "live /api/tags plus per-model inference probes",
    },
  ],
  routes: models.map((model) => ({
    id: `ollama/${model}`,
    backend: "ollama",
    backend_label: "Ollama",
    model,
    wire_model: model,
    api: "ollama",
    base_url: "http://127.0.0.1:11434",
    // Distinct pools let AI Time rotate from a failed larger model to the next
    // independently probed model even though both are served by local Ollama.
    pool: `ollama:hosted-runner:${model}`,
    auth_env: "",
    auth_kind: "none",
    cost_class: "local-unlimited",
    tier: tierFor(model),
    enabled: true,
    disabled_reason: "",
    quota_status: "unlimited",
    resets_at: null,
    note: "Real zero-cost terminal rung provisioned and verified for this run.",
    capabilities: ["code_author", "structured_json", "code_review", "honest"],
    capabilities_source: "declared",
  })),
};
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
NODE

{
  echo "AI_ROTATE=on"
  echo "AI_ROTATE_CATALOG=${catalog_path}"
  echo "AI_ROTATE_STATE=${state_path}"
  # CPU-hosted structured responses can exceed AI Time's interactive default.
  echo "AI_ROTATE_CALL_TIMEOUT_MS=${AITIME_OLLAMA_CALL_TIMEOUT_MS:-600000}"
  echo "OLLAMA_BASE_URL=${ollama_url}"
  echo "FACTORY_FREE_ENABLED=1"
} >> "${GITHUB_ENV}"

echo "AI Time terminal rungs ready: ${verified_models[*]} (distinct local-unlimited pools)."
