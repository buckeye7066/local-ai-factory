import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultExec, resolveNpmCli, type ExecFn } from "./deployRun.js";

/**
 * storePublish.ts — the last mile of Deploy (owner order 2026-08-15): "I have
 * a separate app store on my webpage, www.axiombiolabs.org, that I want the
 * apps posted to as well, when they are production ready." A new app that this
 * factory deployed AND live-verified is appended to the store's registry
 * (apps/registry.json in the axiombiolabs-html-publish site), the store page
 * is regenerated from it (build-store.py), and the site is republished to
 * Vercel. PromoPilot reads the same registry from production
 * (https://www.axiombiolabs.org/apps/registry.json) on boot and every 6 hours,
 * so promotion pickup needs no extra wiring here.
 *
 * Honesty contract: "published" is claimed only when the registry write, the
 * page rebuild, and the Vercel deploy all succeeded; "verified" only when the
 * LIVE registry was observed carrying the new app id. An app already listed is
 * reported as such, never re-written (the registry may carry owner edits).
 * Store-publish failures never fail the run.
 */

export interface StorePublishInput {
  appName: string | null;
  runId: string;
  /** The live, probe-verified URL deployRun observed answering. */
  url: string;
  tagline?: string | null;
  storeDir?: string;
  execImpl?: ExecFn;
  cliPathImpl?: (relEntry: string) => string | null;
  fetchImpl?: typeof fetch;
  registryProbeUrl?: string;
}

export interface StorePublishResult {
  published: boolean;
  /** True only when the LIVE registry was observed carrying the app id. */
  verified: boolean;
  appId: string | null;
  reason: string;
}

const DEFAULT_STORE_DIR = "C:\\Users\\firer\\axiombiolabs-html-publish";
const LIVE_REGISTRY_URL = "https://www.axiombiolabs.org/apps/registry.json";
const VERCEL_ENTRY = join("vercel", "dist", "vc.js");

export function storeDir(): string {
  return (process.env.AXIOM_STORE_DIR || "").trim() || DEFAULT_STORE_DIR;
}

/** Registry app ids are kebab-case (PromoPilot's canonicalAppId contract). */
export function slugifyAppId(name: string | null): string | null {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug.length >= 1 ? slug : null;
}

export async function storePublish(
  input: StorePublishInput,
): Promise<StorePublishResult> {
  const dir = input.storeDir ?? storeDir();
  const exec = input.execImpl ?? defaultExec;
  const cliPath = input.cliPathImpl ?? resolveNpmCli;
  const fetchImpl = input.fetchImpl ?? fetch;
  const probeUrl = input.registryProbeUrl ?? LIVE_REGISTRY_URL;

  const appId = slugifyAppId(input.appName);
  if (!appId) {
    return {
      published: false,
      verified: false,
      appId: null,
      reason: "app name yields no usable store id",
    };
  }
  const registryPath = join(dir, "apps", "registry.json");
  if (!existsSync(registryPath)) {
    return {
      published: false,
      verified: false,
      appId,
      reason: `store registry not found at ${registryPath} (set AXIOM_STORE_DIR)`,
    };
  }

  let registry: { apps?: Array<{ id?: string }> };
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      apps?: Array<{ id?: string }>;
    };
  } catch (err) {
    return {
      published: false,
      verified: false,
      appId,
      reason: `store registry unreadable: ${String(err)}`,
    };
  }
  if (!Array.isArray(registry.apps)) {
    return {
      published: false,
      verified: false,
      appId,
      reason: "store registry has no apps[] array",
    };
  }
  if (registry.apps.some((a) => a?.id === appId)) {
    return {
      published: false,
      verified: false,
      appId,
      reason: `already listed in the store registry (${appId}) — not re-written`,
    };
  }

  registry.apps.push({
    id: appId,
    name: String(input.appName),
    tagline:
      (input.tagline ?? "").trim() ||
      "A new production release from the Axiom software foundry.",
    category: "New release",
    status: "production",
    featured: false,
    accent: "#5FD0C0",
    links: { web: input.url },
    promo: { audience: "", hashtags: "" },
  } as never);
  (registry as Record<string, unknown>).updated = new Date().toISOString().slice(0, 10);
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const build = await exec("python", ["build-store.py"], dir, 120_000);
  if (build.code !== 0) {
    return {
      published: false,
      verified: false,
      appId,
      reason: `registry updated but store rebuild failed (${(build.stderr || build.stdout).trim().slice(0, 200)}) — next successful build/deploy publishes it`,
    };
  }
  const vercelCli = cliPath(VERCEL_ENTRY);
  if (!vercelCli) {
    return {
      published: false,
      verified: false,
      appId,
      reason:
        "registry updated and page rebuilt, but the vercel CLI was not found — run 'vercel --prod' in the store dir to publish",
    };
  }
  const deploy = await exec("node", [vercelCli, "--prod", "--yes"], dir, 300_000);
  if (deploy.code !== 0) {
    return {
      published: false,
      verified: false,
      appId,
      reason: `registry updated but store deploy failed (${(deploy.stderr || deploy.stdout).trim().slice(0, 200)})`,
    };
  }

  // Verify against the LIVE registry — the one PromoPilot actually reads.
  let verified = false;
  try {
    const res = await fetchImpl(probeUrl, {
      redirect: "error",
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      const live = (await res.json()) as { apps?: Array<{ id?: string }> };
      verified = Array.isArray(live.apps) && live.apps.some((a) => a?.id === appId);
    }
  } catch {
    verified = false;
  }
  return {
    published: true,
    verified,
    appId,
    reason: verified
      ? `listed in the live store registry as '${appId}' — PromoPilot picks it up on its next sync (boot or 6-hour interval)`
      : `store deployed but the live registry was not observed carrying '${appId}' yet — re-check ${probeUrl}`,
  };
}
