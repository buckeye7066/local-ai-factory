import type { z } from "zod";
import type {
  LLMProvider,
  GenerateTextInput,
  GenerateTextResult,
  GenerateJsonInput,
} from "../../shared/types.js";

/**
 * stubProvider.ts — deterministic, offline provider for demo mode.
 *
 * It never calls the network and needs no API key. Instead it returns
 * believable, schema-valid data keyed by `schemaName`, validated through the
 * caller's Zod schema so the contract is identical to the real providers.
 *
 * It is intentionally STATEFUL per run: the QA Critic returns one fixable
 * issue on its first call and passes on the second, so the orchestrator's
 * repair loop runs exactly once — giving the UI a real assembly-line story.
 */
/**
 * Offline deterministic provider used for zero-credit journeys.
 * `stub` remains for back-compat; prefer `mock` (see MockProvider) for new runs.
 */
export class StubProvider implements LLMProvider {
  readonly name: "stub" | "mock";
  private qaCalls = 0;

  constructor(name: "stub" | "mock" = "stub") {
    this.name = name;
  }

  isConfigured(): boolean {
    return true;
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    return {
      text: `// ${this.name} response for: ${input.prompt.slice(0, 60)}`,
      provider: this.name,
    };
  }

  async generateJson<T>(input: GenerateJsonInput<T>): Promise<T> {
    const raw = this.dataFor(input.schemaName, input.prompt);
    // Validate through the real schema — guarantees stub output is always valid.
    return input.schema.parse(raw) as z.infer<z.ZodType<T>>;
  }

  private appName(prompt: string): string {
    if (/bible|prayer|scripture|devotion/i.test(prompt)) return "VerseKeeper";
    if (/chore/i.test(prompt)) return "ChoreQuest";
    if (/inventory/i.test(prompt)) return "ShelfSense";
    return "DeckApp";
  }

  private dataFor(schemaName: string, prompt: string): unknown {
    const app = this.appName(prompt);
    switch (schemaName) {
      case "ProductSpec":
        return {
          appName: app,
          tagline: "Build a gentle daily habit, one verse at a time.",
          targetUser:
            "Individuals who want a calm, distraction-free way to track a daily reading habit.",
          coreFeatures: [
            "Mark today's reading as complete",
            "See a running streak counter",
            "Browse a simple history of completed days",
            "Reset or edit progress locally",
          ],
          dataModel: [
            { entity: "Day", fields: ["date", "completed", "note"] },
            { entity: "Streak", fields: ["current", "longest"] },
          ],
          userFlows: [
            "Open app → see today's status → tap Complete → streak increments",
            "Open history → review past completions",
          ],
          acceptanceCriteria: [
            "Tapping Complete marks today done and increments the streak",
            "Refreshing the page preserves progress via localStorage",
            "A unit test verifies streak calculation",
          ],
        };
      case "Architecture":
        return {
          overview:
            "A single-page Vite + React + TypeScript app with no backend; state persists in localStorage.",
          frontend:
            "App.tsx renders today's card, a streak badge, and a history list. A small useHabit hook owns state.",
          backend: "None required — fully local-first in the browser.",
          dataModel:
            "An array of Day records keyed by ISO date, plus a derived streak computed from the array.",
          risks: [
            "localStorage is per-browser; clearing it loses history",
            "No multi-device sync in v1",
          ],
        };
      case "TaskPlan":
        return {
          tasks: [
            {
              order: 1,
              category: "frontend",
              title: "Scaffold Vite React TS app",
              detail: "",
            },
            {
              order: 2,
              category: "frontend",
              title: "Implement useHabit hook + streak logic",
              detail: "",
            },
            {
              order: 3,
              category: "frontend",
              title: "Build today card + history list UI",
              detail: "",
            },
            {
              order: 4,
              category: "tests",
              title: "Unit test streak calculation",
              detail: "",
            },
            {
              order: 5,
              category: "docs",
              title: "Write README with run instructions",
              detail: "",
            },
          ],
        };
      case "FileBuild":
        return { files: stubAppFiles(app) };
      case "TestPlan":
        return {
          testPlan:
            "One Vitest unit test covering streak calculation across consecutive and broken days.",
          files: [
            {
              path: "src/streak.test.ts",
              purpose: "Unit test for streak calculation",
              contents: STREAK_TEST,
            },
          ],
        };
      case "QaReport":
        this.qaCalls += 1;
        if (this.qaCalls === 1) {
          return {
            summary:
              "Streak calculation does not reset when a day is skipped — off-by-one in the loop.",
            passed: false,
            issues: [
              {
                severity: "high",
                title: "Streak does not reset after a missed day",
                detail:
                  "computeStreak keeps counting across non-consecutive dates, so the streak is overstated.",
                file: "src/streak.ts",
                repairInstruction:
                  "Break the streak when the gap between sorted completed days exceeds one calendar day.",
              },
            ],
          };
        }
        return {
          summary:
            "Repair verified — streak now resets correctly on missed days. All checks pass.",
          passed: true,
          issues: [],
        };
      case "RepairResult":
        return {
          notes: "Fixed streak gap handling so a missed day resets the current streak.",
          files: [
            {
              path: "src/streak.ts",
              purpose: "Corrected streak calculation",
              contents: "",
              edits: [
                {
                  find:
                    "  // BUG: counts every completed day regardless of gaps.\n" +
                    "  return done.length;",
                  replace:
                    "  if (!done.length) return 0;\n" +
                    "  let streak = 1;\n" +
                    "  for (let i = done.length - 1; " +
                    "i > 0 && Date.parse(done[i]) - Date.parse(done[i - 1]) <= 129600000; " +
                    "i--) streak++;\n" +
                    "  return streak;",
                },
              ],
            },
          ],
        };
      case "FinalReport":
        return {
          appName: app,
          summary: `${app} is a local-first daily reading habit tracker built end-to-end by the factory.`,
          whatWasBuilt: [
            "Vite + React + TypeScript single-page app",
            "Streak tracking with localStorage persistence",
            "History view of completed days",
            "Unit test for streak calculation",
          ],
          howToRun: "cd into the workspace, run `pnpm install`, then `pnpm dev`.",
          testStatus: "passing",
          repairLoops: 1,
          caveats: [
            "Data is stored per-browser in localStorage (no cloud sync).",
            "Generated in demo mode with the offline mock provider (zero paid credits).",
          ],
          nextImprovements: [
            "Add reading-plan presets (e.g., one-year Bible plan)",
            "Optional reminders/notifications",
            "Export/import progress as JSON",
          ],
          workspacePath: "(set by orchestrator)",
          providerUsage: {
            anthropic: { calls: 0 },
            openai: { calls: 0 },
            stub: { calls: 0 },
            totalCalls: 0,
          },
        };
      default:
        // Unknown schema — return an empty object and let Zod fill defaults/throw.
        return {};
    }
  }
}

/* ------------------------------------------------------------------ */
/* Canned demo app source                                              */
/* ------------------------------------------------------------------ */

const STREAK_BUGGY = `// Computes the current streak of consecutive completed days.
export interface Day {
  date: string; // ISO yyyy-mm-dd
  completed: boolean;
}

export function computeStreak(days: Day[]): number {
  const done = days
    .filter((d) => d.completed)
    .map((d) => d.date)
    .sort();
  // BUG: counts every completed day regardless of gaps.
  return done.length;
}
`;

const STREAK_TEST = `import { describe, it, expect } from "vitest";
import { computeStreak, type Day } from "./streak";

const d = (date: string, completed = true): Day => ({ date, completed });

describe("computeStreak", () => {
  it("counts consecutive days", () => {
    expect(computeStreak([d("2026-01-01"), d("2026-01-02"), d("2026-01-03")])).toBe(3);
  });

  it("resets after a missed day", () => {
    expect(computeStreak([d("2026-01-01"), d("2026-01-02"), d("2026-01-05")])).toBe(1);
  });

  it("returns 0 with no completed days", () => {
    expect(computeStreak([d("2026-01-01", false)])).toBe(0);
  });
});
`;

function stubAppFiles(app: string) {
  return [
    {
      path: "package.json",
      purpose: "Project manifest",
      contents: JSON.stringify(
        {
          name: app.toLowerCase(),
          private: true,
          version: "0.1.0",
          type: "module",
          scripts: {
            dev: "vite",
            build: "tsc && vite build",
            test: "vitest run",
          },
          dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
          devDependencies: {
            "@vitejs/plugin-react": "^4.3.4",
            typescript: "^5.7.3",
            vite: "^5.4.14",
            vitest: "^3.0.5",
          },
        },
        null,
        2,
      ),
    },
    {
      path: "index.html",
      purpose: "HTML entry point",
      contents: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${app}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    },
    {
      path: "src/main.tsx",
      purpose: "React bootstrap",
      contents: `import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
    },
    {
      path: "src/streak.ts",
      purpose: "Streak calculation (intentionally buggy for the QA demo)",
      contents: STREAK_BUGGY,
    },
    {
      path: "src/App.tsx",
      purpose: "Main UI",
      contents: `import { useEffect, useState } from "react";
import { computeStreak, type Day } from "./streak";

const todayIso = () => new Date().toISOString().slice(0, 10);

export function App() {
  const [days, setDays] = useState<Day[]>(() => {
    const raw = localStorage.getItem("days");
    return raw ? (JSON.parse(raw) as Day[]) : [];
  });

  useEffect(() => {
    localStorage.setItem("days", JSON.stringify(days));
  }, [days]);

  const today = todayIso();
  const doneToday = days.some((d) => d.date === today && d.completed);
  const streak = computeStreak(days);

  const complete = () => {
    if (doneToday) return;
    setDays((prev) => [...prev, { date: today, completed: true }]);
  };

  return (
    <main className="app">
      <h1>${app}</h1>
      <p className="streak">🔥 {streak}-day streak</p>
      <button onClick={complete} disabled={doneToday}>
        {doneToday ? "Completed today ✓" : "Mark today complete"}
      </button>
      <h2>History</h2>
      <ul>
        {[...days].reverse().map((d) => (
          <li key={d.date}>{d.date}</li>
        ))}
      </ul>
    </main>
  );
}
`,
    },
    {
      path: "src/App.css",
      purpose: "Styles",
      contents: `:root { color-scheme: dark; }
body { margin: 0; font-family: system-ui, sans-serif; background: #0b1020; color: #e6edf6; }
.app { max-width: 28rem; margin: 4rem auto; padding: 1.5rem; }
h1 { margin: 0 0 0.25rem; }
.streak { font-size: 1.25rem; color: #fbbf24; }
button { padding: 0.6rem 1rem; border-radius: 0.6rem; border: 1px solid #3b82f6; background: #1d4ed8; color: white; cursor: pointer; }
button:disabled { opacity: 0.6; cursor: default; }
ul { padding-left: 1.2rem; }
`,
    },
    {
      path: "README.md",
      purpose: "Run instructions",
      contents: `# ${app}

A local-first daily reading habit tracker generated by Factory Deck.

## Run

\`\`\`bash
pnpm install
pnpm dev
\`\`\`

## Test

\`\`\`bash
pnpm test
\`\`\`
`,
    },
  ];
}
