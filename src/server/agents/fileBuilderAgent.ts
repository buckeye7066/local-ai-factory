import {
  FileBuildSchema,
  type FileBuild,
  type ProductSpec,
  type Architecture,
  type TaskPlan,
} from "../../shared/schemas.js";
import { SYSTEM_PREAMBLE, type AgentDeps } from "./types.js";
import type { ResearchFindings } from "./researchAgent.js";

/**
 * Bounded context about a pre-existing repo, injected only in extend mode.
 * `undefined` (greenfield) keeps this agent's behavior byte-for-byte identical
 * to the original "new app" path.
 */
export interface ExistingRepoContext {
  fileTreeExcerpt: string;
  manifestExcerpt: string;
  readmeExcerpt: string;
}

/**
 * A SECONDARY source repo referenced alongside the primary target — e.g.
 * "take the auth system from A and put it into B": B is `existing` (the
 * target being written to), A is one of these. Read-only by construction —
 * the orchestrator never writes into a secondary source's ingested copy.
 */
export interface AdditionalSourceContext {
  /** How the owner referred to it / its detected app name — for prompt readability. */
  label: string;
  fileTreeExcerpt: string;
  manifestExcerpt: string;
  readmeExcerpt: string;
}

/**
 * Generates the actual app files. Each file has a path, a purpose, and full
 * contents. The orchestrator writes these into the workspace (jailed) — an
 * existing on-disk file with the same path is overwritten (read-modify-write);
 * a new path is created. That existed-vs-new distinction is already handled by
 * `writeWorkspaceFile` purely from what's on disk, so this agent only needs to
 * know WHAT to touch, which `existing`/`additionalSources` steer via the prompt.
 */
export async function fileBuilderAgent(
  deps: AgentDeps,
  spec: ProductSpec,
  arch: Architecture,
  plan: TaskPlan,
  existing?: ExistingRepoContext,
  research?: ResearchFindings,
  additionalSources?: AdditionalSourceContext[],
): Promise<FileBuild> {
  // Byte-for-byte the original greenfield prompt when there's no extra
  // context at all — no behavior change for the "new app" path.
  if (!existing && !research?.recommendations.length && !additionalSources?.length) {
    return deps.provider.generateJson<FileBuild>({
      system: `${SYSTEM_PREAMBLE}\nYou are the FILE BUILDER agent. Output a complete, runnable Vite + React + TypeScript app by default. Use relative paths only (no leading slash, no "..").`,
      prompt: `Build the files for this app. Include package.json, index.html, src/main.tsx, src/App.tsx, styles, and a README.md. If the app needs an API, add a tiny local backend.\n\nSPEC:\n${JSON.stringify(
        spec,
      )}\n\nARCHITECTURE:\n${JSON.stringify(arch)}\n\nPLAN:\n${JSON.stringify(
        plan,
      )}\n\nReturn { files: [{ path, purpose, contents }] }.`,
      schema: FileBuildSchema,
      schemaName: "FileBuild",
      temperature: 0.2,
      maxTokens: 16000,
    });
  }

  const promptParts: string[] = [];
  const systemParts: string[] = [SYSTEM_PREAMBLE];

  if (existing) {
    systemParts.push(
      `You are the FILE BUILDER agent, operating in EXTEND-EXISTING-CODEBASE mode. This repo already exists ` +
        `and already runs. Do NOT regenerate the whole app and do NOT recreate config/entry files (package.json, ` +
        `index.html, build config, etc.) unless a goal explicitly requires changing them. Only output files ` +
        `that are genuinely NEW or that must be MODIFIED to implement the goals. Match the existing file ` +
        `layout, naming, and stack shown below. The goals demand WORKING BEHAVIOR wired into the real product ` +
        `code: a delivery consisting only of documentation, standalone tests, or schema files is a FAILED build ` +
        `and will be refused release. Three moves are forbidden outright: (1) introducing a new ORM or schema ` +
        `layer (e.g. a prisma/ directory) into a repo that does not already use it; (2) writing tests that ` +
        `reimplement product logic inside the test file instead of importing and exercising the repo's real ` +
        `modules; (3) writing docs or "audit" files that assert verification you did not perform.`,
    );
    promptParts.push(
      `Implement the goals in this spec against the EXISTING (TARGET) repo below.\n\nSPEC (the change to make):\n${JSON.stringify(
        spec,
      )}\n\nARCHITECTURE:\n${JSON.stringify(arch)}\n\nPLAN:\n${JSON.stringify(plan)}`,
      `TARGET REPO FILE TREE (partial):\n${existing.fileTreeExcerpt}\n\nTARGET REPO MANIFEST(S):\n${
        existing.manifestExcerpt || "(none found)"
      }\n\nTARGET REPO README:\n${existing.readmeExcerpt || "(none found)"}`,
    );
  } else {
    systemParts.push(
      `You are the FILE BUILDER agent. Output a complete, runnable app.`,
    );
    promptParts.push(
      `Build the files for this app.\n\nSPEC:\n${JSON.stringify(spec)}\n\nARCHITECTURE:\n${JSON.stringify(
        arch,
      )}\n\nPLAN:\n${JSON.stringify(plan)}`,
    );
  }

  if (additionalSources?.length) {
    systemParts.push(
      `This build COMBINES the target above with ${additionalSources.length} additional SOURCE repo(s) — the ` +
        `owner wants specific functionality carried over from them into the target. Read-only: never propose ` +
        `writing INTO a source repo, only INTO the target. Port over the relevant real logic/patterns you can ` +
        `see below, adapted to the target's stack and conventions — don't just describe it, actually write it.`,
    );
    promptParts.push(
      additionalSources
        .map(
          (s, i) =>
            `SOURCE REPO ${i + 1} — "${s.label}" (read-only, port relevant parts INTO the target, do not write into this one):\nFile tree (partial):\n${s.fileTreeExcerpt}\nManifest(s):\n${s.manifestExcerpt || "(none found)"}\nREADME:\n${s.readmeExcerpt || "(none found)"}`,
        )
        .join("\n\n"),
    );
  }

  if (research?.recommendations.length) {
    systemParts.push(
      `Real research already identified external tools/libraries/APIs and competing implementations worth ` +
        `using for this build (found through live search and source inspection, not invented). Integrate only ` +
        `according to each recommendation's reuse mode. Never copy source marked conditional-review or ` +
        `reference-only; implement those ideas clean-room from documented behavior and evidence.`,
    );
    promptParts.push(
      `RESEARCH FINDINGS:\n${research.summary}\n${research.recommendations
        .map(
          (r) =>
            `- ${r.name}: ${r.why} (source: ${r.sourceUrl})\n` +
            `  License: ${r.licenseSpdx}; policy: ${r.licensePolicy}; reuse: ${r.reuseMode}; score: ${r.score}\n` +
            `  Evidence: ${r.evidenceUrls.join(", ") || r.sourceUrl}\n` +
            `  How to integrate: ${r.howToIntegrate}`,
        )
        .join("\n")}`,
    );
  }

  promptParts.push(
    `Use relative paths only (no leading slash, no ".."). Return { files: [{ path, purpose, contents }] } with full contents for each new/changed file.`,
  );

  return deps.provider.generateJson<FileBuild>({
    system: systemParts.join("\n"),
    prompt: promptParts.join("\n\n"),
    schema: FileBuildSchema,
    schemaName: "FileBuild",
    temperature: 0.2,
    maxTokens: 16000,
  });
}
