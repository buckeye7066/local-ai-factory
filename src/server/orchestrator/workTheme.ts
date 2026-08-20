import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMProvider } from "../../shared/types.js";
import type {
  GenerateJsonInput,
  GenerateTextInput,
  GenerateTextResult,
} from "../../shared/types.js";

/**
 * workTheme.ts — directed multi-model orchestration.
 *
 * Owner order (observed 2026-08-20 FlexFactor + Factory Deck runs): when many
 * free routes rotate under one job, each call must still attack the SAME
 * theme and the SAME open issue. Without a shared focus, pool-first rotation
 * looks like "randomness" — prompt-guards, vision models, and TTS models
 * wander off while the real blocker sits red.
 *
 * This module:
 *   1. Holds one WorkTheme per async run context (AsyncLocalStorage).
 *   2. Stamps that theme onto every system prompt via ThemedProvider so
 *      concurrentDispatchers / rotating providers cannot drift.
 *   3. Lets a stage update the open issue mid-run (e.g. "publication suite
 *      red: hamiltonPacketBilingual.test.js timed out") without changing the
 *      run's overall theme.
 */

export interface WorkTheme {
  /** Stable program / run focus — purpose of the work, not a file list. */
  theme: string;
  /** The single open issue every backend must attack right now. */
  issue: string;
  /** Optional hard constraints (paths to prefer, paths to never touch). */
  constraints: string[];
}

const store = new AsyncLocalStorage<WorkTheme>();

export function currentWorkTheme(): WorkTheme | undefined {
  return store.getStore();
}

/** Run `fn` with `theme` bound for the whole async subtree. */
export function withWorkTheme<T>(theme: WorkTheme, fn: () => T): T {
  return store.run(normalizeTheme(theme), fn);
}

export function updateWorkIssue(issue: string): void {
  const cur = store.getStore();
  if (!cur) return;
  cur.issue = String(issue || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function createWorkTheme(input: {
  idea: string;
  appName?: string | null;
  stage?: string;
  issue?: string;
  constraints?: string[];
}): WorkTheme {
  const idea = String(input.idea || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  const app = String(input.appName || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const stage = String(input.stage || "run")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const theme = app
    ? `${app}: ${idea || "deliver working, purpose-aligned product behavior"}`
    : idea || "deliver working, purpose-aligned product behavior";
  const issue =
    String(input.issue || `stage=${stage}; stay on this program's open blocker`)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
  return normalizeTheme({
    theme,
    issue,
    constraints: input.constraints ?? [],
  });
}

function normalizeTheme(theme: WorkTheme): WorkTheme {
  return {
    theme: String(theme.theme || "directed factory work")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500),
    issue: String(theme.issue || "resolve the current verified failure")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500),
    constraints: (theme.constraints ?? [])
      .map((c) => String(c).replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 12),
  };
}

/**
 * Stamp the shared theme into a system prompt. Idempotent: if the prompt
 * already carries the marker, it is left alone so nested wrappers do not
 * duplicate the block.
 */
export function stampWorkTheme(system: string, theme?: WorkTheme | null): string {
  const active = theme ?? currentWorkTheme();
  if (!active) return system;
  const marker = "DIRECTED WORK THEME (shared across every model on this run)";
  if (system.includes(marker)) return system;
  const constraints =
    active.constraints.length > 0
      ? `\nConstraints:\n${active.constraints.map((c) => `- ${c}`).join("\n")}`
      : "";
  const block =
    `${marker}:\n` +
    `Theme: ${active.theme}\n` +
    `Open issue (attack this — do not wander): ${active.issue}` +
    constraints +
    `\nEvery answer must advance THAT issue. Ignore unrelated polish.`;
  return `${system.trim()}\n\n${block}`;
}

/**
 * Provider decorator: every generateText/generateJson call inherits the
 * current WorkTheme (or a fixed one passed at construction). Concurrent
 * workers and rotating routes all see the same directive.
 */
export class ThemedProvider implements LLMProvider {
  readonly name: LLMProvider["name"];

  constructor(
    private readonly inner: LLMProvider,
    private readonly fixed?: WorkTheme,
  ) {
    this.name = inner.name;
  }

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }

  private themeForCall(): WorkTheme | undefined {
    return this.fixed ?? currentWorkTheme();
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return this.inner.generateText({
      ...input,
      system: stampWorkTheme(input.system, this.themeForCall()),
    });
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    return this.inner.generateJson({
      ...input,
      system: stampWorkTheme(input.system, this.themeForCall()),
    });
  }
}

/** Wrap every provider in a pool so concurrent dispatch stays on-theme. */
export function themeProviders(
  providers: LLMProvider[],
  theme?: WorkTheme,
): LLMProvider[] {
  return providers.map((p) =>
    p instanceof ThemedProvider ? p : new ThemedProvider(p, theme),
  );
}
