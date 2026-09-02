const PREFIX = "[FACTORY_GOAL_DIRECTIVES_V1] ";
const MAX_ITEMS_PER_KIND = 50;

export interface StructuredGoalDirectives {
  targetUsers: string[];
  activeGoals: string[];
  constraints: string[];
  nonGoals: string[];
}

function normalizedList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS_PER_KIND) {
    throw new Error(`Invalid structured goal directive list: ${name}.`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`Invalid structured goal directive item: ${name}.`);
    }
    return item.trim();
  });
}

/** Compact four bounded Foundry lists into one RunOptions goal without data loss. */
export function encodeStructuredGoalDirectives(
  directives: StructuredGoalDirectives,
): string {
  return `${PREFIX}${JSON.stringify({
    targetUsers: normalizedList(directives.targetUsers, "targetUsers"),
    activeGoals: normalizedList(directives.activeGoals, "activeGoals"),
    constraints: normalizedList(directives.constraints, "constraints"),
    nonGoals: normalizedList(directives.nonGoals, "nonGoals"),
  })}`;
}

/** Decode only the versioned, code-owned envelope; ordinary owner goals return null. */
export function decodeStructuredGoalDirectives(
  value: string,
): StructuredGoalDirectives | null {
  if (!value.startsWith(PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(PREFIX.length));
  } catch {
    throw new Error("Invalid structured goal directive JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid structured goal directive envelope.");
  }
  const record = parsed as Record<string, unknown>;
  return {
    targetUsers: normalizedList(record.targetUsers, "targetUsers"),
    activeGoals: normalizedList(record.activeGoals, "activeGoals"),
    constraints: normalizedList(record.constraints, "constraints"),
    nonGoals: normalizedList(record.nonGoals, "nonGoals"),
  };
}
