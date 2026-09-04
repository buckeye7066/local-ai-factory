import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}
function write(path, text) {
  writeFileSync(path, text, "utf8");
}
function one(path, before, after) {
  const text = read(path);
  const count = text.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${path}: expected one portability anchor, found ${count}`);
  }
  write(path, text.replace(before, after));
}

// Runtime defaults must follow the current account rather than one developer machine.
one(
  "src/cli/glimmer.ts",
  `import {\n  StateStore,`,
  `import { homedir } from "node:os";\nimport { join } from "node:path";\nimport {\n  StateStore,`,
);
one(
  "src/cli/glimmer.ts",
  '`-f C:\\\\Users\\\\firer\\\\glimmer\\\\modelfiles\\\\Modelfile.q4kxl`,',
  '`-f ${join(homedir(), "glimmer", "modelfiles", "Modelfile.q4kxl")}`,',
);

one(
  "src/server/orchestrator/storePublish.ts",
  `import { existsSync, readFileSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";`,
  `import { existsSync, readFileSync, writeFileSync } from "node:fs";\nimport { homedir } from "node:os";\nimport { join } from "node:path";`,
);
one(
  "src/server/orchestrator/storePublish.ts",
  `const DEFAULT_STORE_DIR = "C:\\\\Users\\\\firer\\\\axiombiolabs-html-publish";`,
  `const DEFAULT_STORE_DIR = join(homedir(), "axiombiolabs-html-publish");`,
);

one(
  "src/server/foundry/adapters.ts",
  `import { Readable } from "node:stream";\nimport {`,
  `import { homedir } from "node:os";\nimport { Readable } from "node:stream";\nimport {`,
);
one(
  "src/server/foundry/adapters.ts",
  `  return (\n    process.env.PURPOSE_FOUNDRY_FLEXFACTOR_SCRIPT?.trim() ||\n    "C:\\\\Users\\\\firer\\\\flexfactor\\\\flexfactor_run.py"\n  );`,
  `  return (\n    process.env.PURPOSE_FOUNDRY_FLEXFACTOR_SCRIPT?.trim() ||\n    join(homedir(), "flexfactor", "flexfactor_run.py")\n  );`,
);

one(
  "src/server/__tests__/foundry.test.ts",
  `import { tmpdir } from "node:os";`,
  `import { homedir, tmpdir } from "node:os";`,
);
one(
  "src/server/__tests__/foundry.test.ts",
  `    expect(flexfactor?.destination).toBe(\n      "C:\\\\Users\\\\firer\\\\flexfactor\\\\flexfactor_run.py",\n    );`,
  `    expect(flexfactor?.destination).toBe(\n      join(homedir(), "flexfactor", "flexfactor_run.py"),\n    );`,
);

// Make the hygiene rule portable too: reject every hard-coded Windows user home,
// not merely one username or one source-escaping style.
one(
  "src/server/__tests__/repoHygiene.test.ts",
  `      const text = readFileSync(resolve(ROOT, path), "utf8");\n      if (/C:\\\\\\\\Users\\\\\\\\firer(?:\\\\\\\\|\\b)/i.test(text)) offenders.push(path);`,
  `      const text = readFileSync(resolve(ROOT, path), "utf8");\n      const normalized = text.replaceAll("\\\\\\\\", "\\\\");\n      const windowsUsersRoot = ["C:", "Users"].join("\\\\") + "\\\\";\n      if (normalized.toLowerCase().includes(windowsUsersRoot.toLowerCase())) {\n        offenders.push(path);\n      }`,
);
one(
  "src/server/__tests__/repoHygiene.test.ts",
  `  it("contains no developer-specific Windows user path in executable source", () => {`,
  `  it("contains no hard-coded Windows user-home path in executable source", () => {`,
);

// Tests and UI examples must not reintroduce a literal Windows user-home prefix.
one(
  "src/server/__tests__/purposeFoundryLauncher.test.ts",
  `    expect(installer).not.toMatch(/C:\\\\Users\\\\[^$]/i);`,
  `    const windowsUsersRoot = ["C:", "Users"].join("\\\\") + "\\\\";\n    expect(installer.toLowerCase()).not.toContain(windowsUsersRoot.toLowerCase());`,
);
one(
  "src/ui/components/factory/ExtendExistingPanel.tsx",
  `              ? "C:\\\\Users\\\\you\\\\MyApp"`,
  `              ? "D:\\\\Projects\\\\MyApp"`,
);

// Historical proof paths should identify the artifact without exposing or
// depending on the account that happened to run the proof.
{
  const path = "docs/evidence/real-provider-proof.json";
  let text = read(path);
  text = text.replace(
    /"workspacePath"\s*:\s*"C:\\\\Users\\\\firer\\\\local-ai-factory\\\\workspaces\\\\([^"\\]+)"/i,
    '"workspacePath": "<redacted-local-workspace>/$1"',
  );
  write(path, text);
}

// Remove the remaining machine username from tracked text, while retaining
// useful Windows-path examples under a neutral project root.
const files = execFileSync("git", ["grep", "-Il", "-i", "firer", "--", "."], {
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter(Boolean);
for (const path of files) {
  let text = read(path);
  text = text.replaceAll("C:\\\\Users\\\\firer\\\\", "D:\\\\Projects\\\\");
  text = text.replaceAll("C:\\Users\\firer\\", "D:\\Projects\\");
  text = text.replace(/firer/gi, "user");
  write(path, text);
}

console.log(`Removed developer-specific paths from ${files.length} tracked text file(s).`);
