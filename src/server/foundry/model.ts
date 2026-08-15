import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

export const StationIdSchema = z.enum([
  "factory-deck",
  "scout",
  "repo-rewards",
  "promo-pilot",
  "flexfactor",
  "crucible",
  "app-store-publisher",
  "watchtower",
]);
export type StationId = z.infer<typeof StationIdSchema>;

export type StationDefinition = {
  id: StationId;
  name: string;
  department: string;
  purpose: string;
  standalone: boolean;
  order: number;
  color: string;
};

export const STATIONS: StationDefinition[] = [
  { id: "factory-deck", name: "Factory Deck", department: "Control Tower", purpose: "Resolve purpose, plan the work, and coordinate every handoff.", standalone: true, order: 10, color: "cyan" },
  { id: "scout", name: "Scout a Program", department: "Discovery Wing", purpose: "Find programs, patterns, and capabilities that could improve the project.", standalone: true, order: 20, color: "blue" },
  { id: "repo-rewards", name: "Repo Rewards", department: "Discovery Wing", purpose: "Find and evaluate reusable open-source repositories and components.", standalone: true, order: 30, color: "violet" },
  { id: "promo-pilot", name: "PromoPilot", department: "Market Laboratory", purpose: "Supply market, campaign, attribution, and advertisement evidence.", standalone: true, order: 40, color: "amber" },
  { id: "flexfactor", name: "FlexFactor", department: "Engineering Floor", purpose: "Inspect, improve, test, repair, and align implementation with purpose.", standalone: true, order: 50, color: "emerald" },
  { id: "crucible", name: "The Crucible", department: "Adversarial Chamber", purpose: "Assume the work is wrong and independently try to disprove readiness.", standalone: false, order: 60, color: "rose" },
  { id: "app-store-publisher", name: "App Store Publisher", department: "Shipping Department", purpose: "Package, verify, submit, and record release artifacts.", standalone: true, order: 70, color: "indigo" },
  { id: "watchtower", name: "Watchtower", department: "Operations", purpose: "Observe deployed behavior and return failures and outcomes to the factory.", standalone: false, order: 80, color: "sky" },
];

const StringListSchema = z.array(z.string().trim().min(1)).max(50).default([]);
export const FoundryIntakeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  purpose: z.string().trim().min(1).max(20_000),
  targetUsers: StringListSchema,
  successCriteria: StringListSchema,
  constraints: StringListSchema,
  nonGoals: StringListSchema,
  targets: StringListSchema,
  source: z.enum(["manual", "obsidian", "api"]).default("manual"),
  sourcePath: z.string().trim().max(2_000).nullable().default(null),
  sourceMarkdown: z.string().max(1_000_000).nullable().default(null),
  selectedStations: z.array(StationIdSchema).min(1).default(STATIONS.map((station) => station.id)),
});
export type FoundryIntake = z.infer<typeof FoundryIntakeSchema>;

export const StationRunStatusSchema = z.enum([
  "not_selected",
  "queued",
  "active",
  "needs_attention",
  "completed",
  "failed",
]);
export type StationRunStatus = z.infer<typeof StationRunStatusSchema>;

export const StationRunSchema = z.object({
  stationId: StationIdSchema,
  status: StationRunStatusSchema,
  attempt: z.number().int().nonnegative(),
  summary: z.string(),
  artifacts: z.array(z.string()),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
});
export type StationRun = z.infer<typeof StationRunSchema>;

export const FoundryProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.enum(["draft", "queued", "running", "needs_attention", "completed", "failed"]),
  constitution: z.object({
    purpose: z.string(),
    targetUsers: z.array(z.string()),
    successCriteria: z.array(z.string()),
    constraints: z.array(z.string()),
    nonGoals: z.array(z.string()),
    targets: z.array(z.string()),
  }),
  source: z.object({
    kind: z.enum(["manual", "obsidian", "api"]),
    path: z.string().nullable(),
    contentHash: z.string().nullable(),
  }),
  stations: z.array(StationRunSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type FoundryProject = z.infer<typeof FoundryProjectSchema>;

export const StationEventSchema = z.object({
  status: z.enum(["active", "needs_attention", "completed", "failed"]),
  summary: z.string().trim().max(20_000).default(""),
  artifacts: z.array(z.string().trim().min(1).max(2_000)).max(100).default([]),
  evidence: z.record(z.unknown()).default({}),
});

type EvidenceEvent = {
  sequence: number;
  timestamp: number;
  projectId: string;
  stationId: StationId;
  type: string;
  payload: unknown;
  previousHash: string | null;
  hash: string;
};

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Parse the deliberately small YAML subset used by Purpose Foundry notes. */
export function intakeFromMarkdown(markdown: string, sourcePath: string): FoundryIntake {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  const metadata: Record<string, string> = {};
  if (match) {
    for (const line of match[1].split("\n")) {
      const separator = line.indexOf(":");
      if (separator < 1) continue;
      metadata[line.slice(0, separator).trim().toLowerCase()] = line
        .slice(separator + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
    }
  }
  const body = normalized.slice(match?.[0].length ?? 0).trim();
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const name = metadata.project || metadata.name || heading || basename(sourcePath, ".md");
  const purpose = metadata.purpose || body;
  return FoundryIntakeSchema.parse({
    name,
    purpose,
    targetUsers: splitList(metadata.target_users || metadata.users),
    successCriteria: splitList(metadata.success_criteria || metadata.success),
    constraints: splitList(metadata.constraints),
    nonGoals: splitList(metadata.non_goals),
    targets: splitList(metadata.targets || metadata.repositories),
    source: "obsidian",
    sourcePath,
    sourceMarkdown: normalized,
  });
}

export class FoundryStore {
  readonly root: string;
  private readonly projectsRoot: string;
  private readonly ledgerPath: string;
  private projectCreates: Promise<unknown> = Promise.resolve();
  private ledgerWrites: Promise<unknown> = Promise.resolve();

  constructor(root = resolve(process.cwd(), ".factory", "foundry")) {
    this.root = root;
    this.projectsRoot = join(root, "projects");
    this.ledgerPath = join(root, "evidence.jsonl");
  }

  private async ready(): Promise<void> {
    await mkdir(this.projectsRoot, { recursive: true });
  }

  private projectPath(id: string): string {
    if (!z.string().uuid().safeParse(id).success) throw new Error("Invalid project id.");
    return join(this.projectsRoot, `${id}.json`);
  }

  async list(): Promise<FoundryProject[]> {
    await this.ready();
    const names = (await readdir(this.projectsRoot)).filter((name) => name.endsWith(".json"));
    const projects: FoundryProject[] = [];
    for (const name of names) {
      try {
        projects.push(FoundryProjectSchema.parse(JSON.parse(await readFile(join(this.projectsRoot, name), "utf8"))));
      } catch {
        // A corrupt record is excluded rather than treated as trustworthy state.
      }
    }
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<FoundryProject | null> {
    try {
      return FoundryProjectSchema.parse(JSON.parse(await readFile(this.projectPath(id), "utf8")));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (error instanceof z.ZodError) throw new Error("Foundry project record is corrupt.");
      throw error;
    }
  }

  async create(input: FoundryIntake): Promise<FoundryProject> {
    const create = this.projectCreates.then(() => this.createUnlocked(input));
    this.projectCreates = create.catch(() => undefined);
    return create;
  }

  private async createUnlocked(input: FoundryIntake): Promise<FoundryProject> {
    await this.ready();
    if (input.sourcePath) {
      const existing = (await this.list()).find((project) => project.source.path === input.sourcePath);
      if (existing && existing.source.contentHash === hashText(input.sourceMarkdown ?? input.purpose)) return existing;
    }
    const now = Date.now();
    const selected = new Set(input.selectedStations);
    const project: FoundryProject = {
      id: randomUUID(),
      name: input.name,
      status: "draft",
      constitution: {
        purpose: input.purpose,
        targetUsers: input.targetUsers,
        successCriteria: input.successCriteria,
        constraints: input.constraints,
        nonGoals: input.nonGoals,
        targets: input.targets,
      },
      source: {
        kind: input.source,
        path: input.sourcePath,
        contentHash: input.sourceMarkdown ? hashText(input.sourceMarkdown) : null,
      },
      stations: STATIONS.map((station) => ({
        stationId: station.id,
        status: selected.has(station.id) ? "queued" : "not_selected",
        attempt: 0,
        summary: "",
        artifacts: [],
        startedAt: null,
        endedAt: null,
      })),
      createdAt: now,
      updatedAt: now,
    };
    await this.save(project);
    await this.appendEvidence(project.id, "factory-deck", "project.created", { source: project.source, constitution: project.constitution });
    return project;
  }

  async save(project: FoundryProject): Promise<void> {
    await this.ready();
    const parsed = FoundryProjectSchema.parse({ ...project, updatedAt: Date.now() });
    const target = this.projectPath(parsed.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  async appendEvidence(projectId: string, stationId: StationId, type: string, payload: unknown): Promise<EvidenceEvent> {
    const write = this.ledgerWrites.then(() =>
      this.appendEvidenceUnlocked(projectId, stationId, type, payload),
    );
    // Preserve serialization after either success or failure; a rejected write
    // must not permanently poison every future ledger append.
    this.ledgerWrites = write.catch(() => undefined);
    return write;
  }

  private async appendEvidenceUnlocked(projectId: string, stationId: StationId, type: string, payload: unknown): Promise<EvidenceEvent> {
    await this.ready();
    let previous: EvidenceEvent | null = null;
    try {
      const lines = (await readFile(this.ledgerPath, "utf8")).trim().split("\n").filter(Boolean);
      if (lines.length) previous = JSON.parse(lines[lines.length - 1]) as EvidenceEvent;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const unsigned = {
      sequence: (previous?.sequence ?? 0) + 1,
      timestamp: Date.now(),
      projectId,
      stationId,
      type,
      payload,
      previousHash: previous?.hash ?? null,
    };
    const event: EvidenceEvent = { ...unsigned, hash: hashText(JSON.stringify(unsigned)) };
    await appendFile(this.ledgerPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return event;
  }

  async importObsidianInbox(inbox: string): Promise<{ imported: number; unchanged: number; errors: string[] }> {
    const root = resolve(inbox);
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("Obsidian inbox is not a directory.");
    let imported = 0;
    let unchanged = 0;
    const errors: string[] = [];
    const existing = await this.list();
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        errors.push(`${entry.name}: symbolic links and non-files are not imported`);
        continue;
      }
      const path = resolve(root, entry.name);
      if (!path.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`)) continue;
      try {
        const markdown = await readFile(path, "utf8");
        const normalized = markdown.replace(/\r\n/g, "\n");
        const contentHash = hashText(normalized);
        if (existing.some((project) => project.source.path === path && project.source.contentHash === contentHash)) {
          unchanged += 1;
          continue;
        }
        await this.create(intakeFromMarkdown(normalized, path));
        imported += 1;
      } catch (error) {
        errors.push(`${entry.name}: ${error instanceof Error ? error.message : "import failed"}`);
      }
    }
    return { imported, unchanged, errors };
  }
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
