export type WindowsProcessPortabilityIssue = {
  path: string;
  line: number;
  reason: string;
};

const JAVASCRIPT_OR_TYPESCRIPT = /\.[cm]?[jt]sx?$/i;
const WINDOWS_SCRIPT = /["'`][^"'`\r\n]*\.(?:cmd|bat)["'`]/i;
const WINDOWS_SCRIPT_VARIABLE =
  /\b(?:const|let|var)\s+([$A-Z_a-z][$\w]*)\s*=\s*[^;\r\n]{0,500}["'`][^"'`\r\n]*\.(?:cmd|bat)["'`]/g;
const DIRECT_CHILD_PROCESS_CALL =
  /\b(execFile|spawn)(?:Sync|Async)?\s*\(\s*([^,\r\n]+)/g;

function callText(source: string, start: number): string {
  const open = source.indexOf("(", start);
  if (open < 0) return source.slice(start, start + 2_000);
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  for (let index = open; index < Math.min(source.length, open + 8_000); index += 1) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start, start + 8_000);
}

/**
 * Node cannot directly execute Windows batch wrappers through execFile/spawn.
 * The same generated test may pass on Linux with `npm` and fail on Windows
 * with `spawn EINVAL` after it selects `npm.cmd`; catch that before the exact
 * candidate is sealed and sent to trusted OS runners.
 */
export function assessWindowsProcessPortability(
  files: Iterable<{ path: string; contents: string }>,
): WindowsProcessPortabilityIssue[] {
  const issues: WindowsProcessPortabilityIssue[] = [];
  for (const file of files) {
    if (!JAVASCRIPT_OR_TYPESCRIPT.test(file.path)) continue;
    const scriptVariables = new Set<string>();
    for (const match of file.contents.matchAll(WINDOWS_SCRIPT_VARIABLE)) {
      if (match[1]) scriptVariables.add(match[1]);
    }
    for (const match of file.contents.matchAll(DIRECT_CHILD_PROCESS_CALL)) {
      const firstArgument = match[2]?.trim() ?? "";
      const selectsWindowsScript =
        WINDOWS_SCRIPT.test(firstArgument) || scriptVariables.has(firstArgument);
      if (!selectsWindowsScript) continue;
      const invocation = callText(file.contents, match.index ?? 0);
      if (/\bshell\s*:\s*true\b/.test(invocation)) continue;
      issues.push({
        path: file.path,
        line: file.contents.slice(0, match.index ?? 0).split(/\r?\n/).length,
        reason:
          `${match[1]} directly launches a Windows .cmd/.bat wrapper without shell: true. ` +
          "Node reports spawn EINVAL for this on Windows. Invoke a real executable such as process.execPath, use a shell-aware command API, or deliberately enable the shell for that invocation.",
      });
    }
  }
  return issues;
}
