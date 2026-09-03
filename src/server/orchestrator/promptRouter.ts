export interface PromptTarget {
  id: string;
  name: string;
  source: string;
}

export interface PromptRoute {
  targetId: string;
  prompt: string;
  evidence: "named" | "shared" | "single";
}

const SHARED = /\b(all|both|each|every)\s+(programs?|apps?|repos(?:itories)?)\b/i;
const CONTINUATION = /^(also|and|then|it|that|this|additionally|afterward)\b/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliases(target: PromptTarget): string[] {
  const source = target.source.replace(/[\\/]+$/, "");
  const base =
    source
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.git$/i, "") ?? "";
  const ownerRepo = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/i.exec(source);
  return [
    ...new Set(
      [target.name, base, ownerRepo?.[2], ownerRepo?.slice(1).join("/")]
        .filter((value): value is string => Boolean(value?.trim()))
        .map((value) => value.trim().toLowerCase()),
    ),
  ].sort((a, b) => b.length - a.length);
}

function mentions(segment: string, targetAliases: string[]): boolean {
  const addressed = segment.trim().replace(/^(?:[-*+]|\d+[.)])\s*/, "");
  const colon = addressed.indexOf(":");
  const header = colon > 0 && colon <= 120 ? addressed.slice(0, colon) : "";
  const normalized = (header || addressed)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(header ? /^$/ : /^(?:for|in|on|to)\s+(?:the\s+)?/, "");
  const compact = normalized.replace(/\s+/g, "");
  return targetAliases.some((alias) => {
    const words = alias.replace(/[^a-z0-9]+/g, " ").trim();
    const aliasCompact = words.replace(/\s+/g, "");
    if (header) {
      return (
        new RegExp(`(^|\\s)${escapeRegex(words)}(\\s|$)`, "i").test(normalized) ||
        compact === aliasCompact
      );
    }
    return (
      normalized === words ||
      normalized.startsWith(`${words} `) ||
      compact === aliasCompact
    );
  });
}

function promptSegments(prompt: string, aliasSets: string[][]): string[] {
  const segments: string[] = [];
  for (const rawLine of prompt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const clauses: string[] = [];
    for (const part of line.split(/;\s+/)) {
      if (
        clauses.length === 0 ||
        SHARED.test(part) ||
        aliasSets.some((targetAliases) => mentions(part, targetAliases))
      ) {
        clauses.push(part);
      } else {
        clauses[clauses.length - 1] += `; ${part}`;
      }
    }
    for (const clause of clauses) {
      segments.push(
        ...clause
          .split(/(?<=[.!?])\s+(?=(?:[-*]\s*)?[\[A-Za-z0-9])/)
          .map((part) => part.trim())
          .filter(Boolean),
      );
    }
  }
  return segments.length ? segments : [prompt];
}

/**
 * Deterministically split one owner prompt among selected programs.
 * Explicit program/repo names win; shared and genuinely unscoped requirements
 * go to every target so no instruction silently disappears.
 */
export function routePrompt(prompt: string, targets: PromptTarget[]): PromptRoute[] {
  const clean = prompt.trim();
  if (!clean) throw new Error("Session prompt is required.");
  if (clean.length > 20_000) throw new Error("Session prompt is too long.");
  if (targets.length < 1 || targets.length > 30) {
    throw new Error("Choose from 1 through 30 programs.");
  }
  if (targets.length === 1) {
    return [{ targetId: targets[0]!.id, prompt: clean, evidence: "single" }];
  }

  const rawAliasSets = targets.map(aliases);
  const aliasCounts = new Map<string, number>();
  for (const targetAliases of rawAliasSets) {
    for (const alias of targetAliases) {
      aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1);
    }
  }
  const aliasSets = rawAliasSets.map((targetAliases) =>
    targetAliases.filter((alias) => aliasCounts.get(alias) === 1),
  );
  const segments = promptSegments(clean, aliasSets);
  const routed = new Map(targets.map((target) => [target.id, [] as string[]]));
  const evidence = new Map<string, PromptRoute["evidence"]>(
    targets.map((target) => [target.id, "shared"]),
  );
  let lastNamed: PromptTarget[] = [];

  for (const segment of segments) {
    const named = targets.filter((_, index) => mentions(segment, aliasSets[index]!));
    const shared = SHARED.test(segment);
    const contextual =
      CONTINUATION.test(segment) || /^(?:[-*+]|\d+[.)])\s+/.test(segment);
    const chosen = named.length
      ? named
      : shared
        ? targets
        : contextual && lastNamed.length
          ? lastNamed
          : targets;
    if (named.length) lastNamed = named;
    else if (shared) lastNamed = [];
    else if (!(contextual && lastNamed.length)) lastNamed = [];
    for (const target of chosen) {
      routed.get(target.id)!.push(segment);
      if (named.includes(target)) evidence.set(target.id, "named");
    }
  }

  return targets.map((target) => ({
    targetId: target.id,
    prompt: routed.get(target.id)!.join(" ").trim(),
    evidence: evidence.get(target.id)!,
  }));
}
