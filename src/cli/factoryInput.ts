const DEFAULT_FACTORY_IDEA = "Build a Bible reading habit tracker";

export function factoryIdeaFromInputs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const environmentIdea = env.FACTORY_IDEA?.trim();
  if (environmentIdea) return environmentIdea;
  const positionalIdea = argv
    .slice(2)
    .filter((argument) => !argument.startsWith("--"))
    .join(" ")
    .trim();
  return positionalIdea || DEFAULT_FACTORY_IDEA;
}

export class FactoryCliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactoryCliArgumentError";
  }
}

const REMOVED_FACTORY_FLAGS = new Set(["--dry-run", "--simulate", "--report-only"]);
const DEMO_FACTORY_FLAGS = new Set(["--demo", "--demo=true"]);

export function parseFactoryCliInputs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { idea: string; demo: boolean } {
  const options = argv.slice(2).filter((argument) => argument.startsWith("-"));
  const removed = options.filter((argument) => REMOVED_FACTORY_FLAGS.has(argument));
  if (removed.length > 0) {
    throw new FactoryCliArgumentError(
      `${removed.join(", ")} ${removed.length > 1 ? "were" : "was"} removed. Use --demo for an explicit zero-credit offline preview.`,
    );
  }
  const unknown = options.filter((argument) => !DEMO_FACTORY_FLAGS.has(argument));
  if (unknown.length > 0) {
    throw new FactoryCliArgumentError(
      `Unknown Factory Deck option${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
        "No option is ignored because doing so could silently start a paid live run.",
    );
  }
  return {
    idea: factoryIdeaFromInputs(argv, env),
    demo: options.some((argument) => DEMO_FACTORY_FLAGS.has(argument)),
  };
}
