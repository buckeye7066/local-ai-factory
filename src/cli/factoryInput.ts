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
  // No default idea: an empty invocation must never start a real run on an
  // idea the owner did not give.
  return positionalIdea;
}

export class FactoryCliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactoryCliArgumentError";
  }
}

const REMOVED_FACTORY_FLAGS = new Set(["--dry-run", "--simulate", "--report-only"]);

function isRemovedFlag(argument: string): boolean {
  return REMOVED_FACTORY_FLAGS.has(argument) || /^--demo(=.*)?$/.test(argument);
}

export const FACTORY_CLI_USAGE =
  'Usage: FACTORY_PROJECT_ID=<stable-project-id> pnpm factory "<describe the app to build>"';

export function parseFactoryCliInputs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { idea: string } {
  const options = argv.slice(2).filter((argument) => argument.startsWith("-"));
  const removed = options.filter(isRemovedFlag);
  if (removed.length > 0) {
    throw new FactoryCliArgumentError(
      `${removed.join(", ")} ${removed.length > 1 ? "were" : "was"} removed. Factory Deck has no demo, dry-run, simulate, or report-only mode; every run does real work.`,
    );
  }
  const unknown = options;
  if (unknown.length > 0) {
    throw new FactoryCliArgumentError(
      `Unknown Factory Deck option${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
        "No option is ignored because doing so could silently start a paid live run.",
    );
  }
  const idea = factoryIdeaFromInputs(argv, env);
  if (!idea) {
    throw new FactoryCliArgumentError(
      `No idea given, so no run was started. ${FACTORY_CLI_USAGE}`,
    );
  }
  return { idea };
}
