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
