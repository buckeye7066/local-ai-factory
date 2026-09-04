import { AsyncLocalStorage } from "node:async_hooks";
import type { CallIntent, LLMProvider } from "../../shared/types.js";
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

const PURPOSE_VISION_HINTS = [
  "screenshot",
  "screen shot",
  "user interface",
  " ui ",
  "visual",
  "image",
  "photo",
  "render",
  "pixel",
  "layout",
  "ocr",
  "diagram",
  "video frame",
  "camera",
];

/** Does the program's purpose involve looking at pictures? Narrow on purpose. */
export function purposeNeedsVision(text: string): boolean {
  const low = ` ${String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")} `;
  return PURPOSE_VISION_HINTS.some((h) => low.includes(h));
}

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

/**
 * The theme input for RESUMING a run: the run's ORIGINAL purpose, not the
 * resume event. Live 2026-08-23 (IPlay run 751546a5, resumed twice after the
 * shared deck was relaunched): every rotation selection after the resume read
 * "as author (declared) for resume 751546a5-..." — the purpose slug the
 * rotator keys its fit, yield and cooldowns on had become the run id, so the
 * quality learned before the interruption no longer applied and nothing
 * learned afterwards would reach the next run with the same purpose. The
 * stored record carries the idea; a record that cannot be found keeps the
 * old label so the resume is still attributable.
 */
export function resumeWorkTheme(
  run: { idea?: string | null; appName?: string | null } | null | undefined,
  runId: string,
  stage: string = "resume",
): { idea: string; appName?: string | null; stage: string } {
  const idea = String(run?.idea || "").trim();
  if (!idea) return { idea: `resume ${runId}`, stage };
  return { idea, appName: run?.appName ?? null, stage };
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
  const issue = String(
    input.issue || `stage=${stage}; stay on this program's open blocker`,
  )
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

  prepareCall(): Promise<void> {
    return this.inner.prepareCall?.() ?? Promise.resolve();
  }

  currentProvider(): LLMProvider["name"] {
    return this.inner.currentProvider?.() ?? this.inner.name;
  }

  currentModel(): string {
    return this.inner.currentModel?.() ?? this.currentProvider();
  }

  private themeForCall(): WorkTheme | undefined {
    return this.fixed ?? currentWorkTheme();
  }

  /**
   * Purpose sight for the rotator. The theme already says what the program
   * is FOR; put that on the call's intent so selection can fit the route to
   * it and the journal can say which goal each model served. A visual
   * purpose (screenshots, UI, images) adds a hard `vision` need. Never
   * overrides an intent the agent set explicitly.
   */
  private intentForCall(intent: CallIntent | undefined): CallIntent | undefined {
    const theme = this.themeForCall();
    if (!theme) return intent;
    const out: CallIntent = { ...(intent ?? {}) };
    if (!out.purpose) out.purpose = theme.theme.slice(0, 80);
    // Purpose-derived needs attach to the VISION role only (twin of
    // flexfactor_rotation._complete_intent). A program that PRODUCES video
    // must not narrow every code author to image-capable models.
    if (out.role === "vision" && purposeNeedsVision(`${theme.theme} ${theme.issue}`)) {
      out.needs = [...new Set([...(out.needs ?? []), "vision" as const])];
    }
    return out;
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return this.inner.generateText({
      ...input,
      system: stampWorkTheme(input.system, this.themeForCall()),
      intent: this.intentForCall(input.intent),
    });
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    return this.inner.generateJson({
      ...input,
      system: stampWorkTheme(input.system, this.themeForCall()),
      intent: this.intentForCall(input.intent),
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
