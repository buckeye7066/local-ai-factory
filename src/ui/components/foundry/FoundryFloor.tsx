import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  ClipboardList,
  Factory,
  Megaphone,
  PackageCheck,
  PlugZap,
  Play,
  Radar,
  RadioTower,
  RefreshCw,
  Search,
  ShieldAlert,
  Truck,
  Wrench,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "../../lib/cn.js";
import {
  ANDON,
  AndonStack,
  BayNumber,
  BoardReadout,
  ConveyorRail,
  HazardBar,
  PlantButton,
  Rivets,
  SteelPanel,
  Stencil,
  type AndonStatus,
} from "./plant.js";

type StationId =
  | "factory-deck"
  | "scout"
  | "repo-rewards"
  | "promo-pilot"
  | "flexfactor"
  | "crucible"
  | "app-store-publisher"
  | "watchtower";

type Station = {
  id: StationId;
  name: string;
  department: string;
  purpose: string;
  standalone: boolean;
  order: number;
  color: string;
};

type StationRun = {
  stationId: StationId;
  status: AndonStatus;
  attempt: number;
  summary: string;
  artifacts: string[];
};

type FoundryProject = {
  id: string;
  name: string;
  status: "draft" | "queued" | "running" | "needs_attention" | "completed" | "failed";
  routingMode?: "free" | "paid";
  constitution: {
    purpose: string;
    targetUsers: string[];
    successCriteria: string[];
    constraints: string[];
    nonGoals: string[];
    targets: string[];
  };
  source: { kind: "manual" | "obsidian" | "api"; path: string | null };
  stations: StationRun[];
  updatedAt: number;
};

type Adapter = {
  stationId: StationId;
  mode: "internal" | "http" | "process";
  configured: boolean;
  destination: string;
};

const ICONS: Record<StationId, ComponentType<{ className?: string }>> = {
  "factory-deck": Factory,
  scout: Radar,
  "repo-rewards": Search,
  "promo-pilot": Megaphone,
  flexfactor: Wrench,
  crucible: ShieldAlert,
  "app-store-publisher": PackageCheck,
  watchtower: RadioTower,
};

/** How each bay's steel reads under its lamp. */
const BAY_STYLE: Record<AndonStatus, string> = {
  not_selected: "border-plant-edge/40 opacity-40",
  queued: "border-plant-edge/70",
  active: "border-plant-go/45",
  needs_attention: "border-plant-safety/50",
  completed: "border-plant-go/25",
  failed: "border-plant-stop/55",
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function split(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** A recessed control-panel field. Labels are real labels, not placeholders. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <Stencil className="mb-1.5 block text-[9px] text-plant-paint/60">{label}</Stencil>
      {children}
      {hint && (
        <span className="mt-1 block text-[10px] text-plant-paint/40">{hint}</span>
      )}
    </label>
  );
}

const FIELD_CLASS =
  "w-full rounded-[3px] border border-plant-edge bg-plant-night/80 px-3 py-2 text-sm text-white " +
  "shadow-[inset_0_2px_4px_rgba(0,0,0,0.55)] placeholder:text-plant-paint/30 " +
  "focus:border-plant-safety/70 focus:outline-none focus:ring-1 focus:ring-plant-safety/40";

export function FoundryFloor() {
  const [stations, setStations] = useState<Station[]>([]);
  const [adapters, setAdapters] = useState<Adapter[]>([]);
  const [projects, setProjects] = useState<FoundryProject[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [targets, setTargets] = useState("");
  const [success, setSuccess] = useState("");
  const [routingMode, setRoutingMode] = useState<"free" | "paid">("free");
  const [obsidianNote, setObsidianNote] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [stationResult, adapterResult, projectResult] = await Promise.all([
      request<{ stations: Station[] }>("/api/foundry/stations"),
      request<{ adapters: Adapter[] }>("/api/foundry/adapters"),
      request<{ projects: FoundryProject[] }>("/api/foundry/projects"),
    ]);
    setStations(stationResult.stations.sort((a, b) => a.order - b.order));
    setAdapters(adapterResult.adapters);
    setProjects(projectResult.projects);
    setActiveId((current) => current ?? projectResult.projects[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void refresh().catch((error: unknown) => {
      toast.error("Purpose Foundry is offline", {
        description: error instanceof Error ? error.message : undefined,
      });
    });
    const timer = setInterval(() => void refresh().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const active = useMemo(
    () => projects.find((project) => project.id === activeId) ?? null,
    [activeId, projects],
  );

  /* The plant's own reading of the floor: how many bays are running, how many
     have pulled the andon cord, how many have passed. */
  const board = useMemo(() => {
    const runs = active?.stations ?? [];
    const count = (s: AndonStatus) => runs.filter((r) => r.status === s).length;
    const running = count("active");
    const calls = count("needs_attention");
    const down = count("failed");
    const passed = count("completed");
    const master: AndonStatus = down
      ? "failed"
      : calls
        ? "needs_attention"
        : running
          ? "active"
          : passed
            ? "completed"
            : "queued";
    return { running, calls, down, passed, master };
  }, [active]);

  const createProject = async () => {
    if (!name.trim() || !purpose.trim()) return;
    setBusy(true);
    try {
      const created = await request<FoundryProject>("/api/foundry/projects", {
        method: "POST",
        body: JSON.stringify({
          name,
          purpose,
          targetUsers: [],
          successCriteria: split(success),
          constraints: [],
          nonGoals: [],
          targets: split(targets),
          routingMode,
          source: "manual",
          ...(stations.length
            ? { selectedStations: stations.map((station) => station.id) }
            : {}),
        }),
      });
      setName("");
      setPurpose("");
      setTargets("");
      setSuccess("");
      setActiveId(created.id);
      await refresh();
      toast.success("Job ticket released to the line");
    } catch (error) {
      toast.error("Could not release the job", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const importObsidian = async () => {
    if (!obsidianNote.trim()) return;
    setBusy(true);
    try {
      const created = await request<FoundryProject>("/api/foundry/obsidian/import", {
        method: "POST",
        body: JSON.stringify({
          markdown: obsidianNote,
          sourcePath: "Obsidian/Purpose Foundry.md",
          routingMode,
        }),
      });
      setObsidianNote("");
      setActiveId(created.id);
      await refresh();
      toast.success("Note taken in at the dock", { description: created.name });
    } catch (error) {
      toast.error("Could not take in the note", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const scanInbox = async () => {
    setBusy(true);
    try {
      const result = await request<{
        imported: number;
        unchanged: number;
        errors: string[];
      }>("/api/foundry/obsidian/scan", { method: "POST" });
      await refresh();
      toast.success(`Took in ${result.imported} note(s)`, {
        description: `${result.unchanged} unchanged · ${result.errors.length} error(s)`,
      });
    } catch (error) {
      toast.error("Could not scan the inbox", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const startProject = async () => {
    if (!active) return;
    setBusy(true);
    try {
      await request(`/api/foundry/projects/${active.id}/start`, { method: "POST" });
      await refresh();
      toast.success("Line started", { description: active.name });
    } catch (error) {
      toast.error("Could not start the line", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const runStation = async (stationId: StationId) => {
    if (!active) return;
    setBusy(true);
    try {
      await request(`/api/foundry/projects/${active.id}/stations/${stationId}/run`, {
        method: "POST",
      });
      await refresh();
      toast.success("Bay restarted");
    } catch (error) {
      toast.error("Could not restart the bay", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* ---------------------------------------------------------------- */}
      {/* Plant sign + andon board                                          */}
      {/* ---------------------------------------------------------------- */}
      <SteelPanel className="overflow-hidden">
        <div className="flex flex-col gap-6 p-5 md:flex-row md:items-center md:justify-between md:p-6">
          {/* Porcelain enamel sign over the gate */}
          <div className="relative shrink-0 rounded-[3px] border-2 border-plant-arc/50 bg-gradient-to-b from-plant-arc/35 to-plant-ford px-6 py-5 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.9)]">
            <Rivets inset="0.4rem" />
            <Stencil className="block text-[8px] text-white/55">
              Plant No. 2 · Baumhart Road
            </Stencil>
            <h1 className="mt-2 text-[28px] font-extrabold uppercase leading-none tracking-[0.06em] text-white md:text-[34px]">
              Purpose Foundry
            </h1>
            <Stencil className="mt-2 block text-[8px] text-white/55">
              Lorain Assembly · Est. 1958
            </Stencil>
          </div>

          {/* The board the floor actually reads */}
          <div className="flex min-w-0 flex-1 items-center gap-5 md:justify-end">
            <div className="min-w-0 flex-1 md:max-w-md">
              <Stencil className="mb-3 block text-[9px] text-plant-paint/50">
                Andon board — {active ? active.name : "no job selected"}
              </Stencil>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <BoardReadout value={projects.length} caption="On the floor" />
                <BoardReadout
                  value={board.running}
                  caption="Bays running"
                  tone={board.running ? "go" : "steel"}
                />
                <BoardReadout
                  value={board.calls + board.down}
                  caption="Line calls"
                  tone={board.down ? "stop" : board.calls ? "amber" : "steel"}
                />
                <BoardReadout value={board.passed} caption="Passed" />
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-center gap-2">
              <AndonStack status={board.master} size="lg" />
              <Stencil className="text-[8px] text-plant-paint/50">
                {ANDON[board.master].label}
              </Stencil>
            </div>
          </div>
        </div>
        <HazardBar />
      </SteelPanel>

      <div className="grid gap-5 xl:grid-cols-[350px_minmax(0,1fr)]">
        {/* -------------------------------------------------------------- */}
        {/* Receiving dock                                                  */}
        {/* -------------------------------------------------------------- */}
        <div className="space-y-5">
          <SteelPanel rivets>
            <div className="plant-plate flex items-center justify-between border-b border-plant-edge/70 px-4 py-3">
              <div>
                <Stencil className="block text-[10px] text-white">
                  Receiving dock
                </Stencil>
                <span className="mt-0.5 block text-[10px] text-plant-paint/50">
                  Write a job ticket and release it to the line.
                </span>
              </div>
              <Truck className="h-5 w-5 shrink-0 text-plant-safety/70" />
            </div>
            <HazardBar className="opacity-70" />

            <div className="space-y-3 p-4">
              <Field label="Job name">
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Name this build"
                  className={FIELD_CLASS}
                />
              </Field>
              <Field label="What this job is for">
                <textarea
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                  placeholder="What is this project ultimately meant to accomplish?"
                  rows={4}
                  className={cn(FIELD_CLASS, "resize-none")}
                />
              </Field>
              <Field
                label="Provider routing"
                hint={
                  routingMode === "free"
                    ? "Free is a hard $0 boundary, including Scout and FlexFactor."
                    : "Paid internal calls use single-process call limits and an estimated-USD admission guard. Unmeterable Scout/FlexFactor child stations are omitted."
                }
              >
                <select
                  value={routingMode}
                  onChange={(event) =>
                    setRoutingMode(event.target.value as "free" | "paid")
                  }
                  aria-label="Purpose Foundry provider routing"
                  className={FIELD_CLASS}
                >
                  <option value="free">Free — $0 routes only</option>
                  <option value="paid">Paid — budget-gated routes only</option>
                </select>
              </Field>
              <Field label="Repos or programs" hint="Separate with commas">
                <input
                  value={targets}
                  onChange={(event) => setTargets(event.target.value)}
                  placeholder="Leave empty for a new build"
                  className={FIELD_CLASS}
                />
              </Field>
              <Field label="Acceptance criteria" hint="One per line">
                <textarea
                  value={success}
                  onChange={(event) => setSuccess(event.target.value)}
                  placeholder="How the line knows this passed"
                  rows={3}
                  className={cn(FIELD_CLASS, "resize-none")}
                />
              </Field>
              <PlantButton
                variant="line"
                className="w-full"
                loading={busy}
                disabled={!name.trim() || !purpose.trim()}
                onClick={createProject}
                icon={<Truck className="h-4 w-4" />}
              >
                Release to the line
              </PlantButton>
            </div>
          </SteelPanel>

          {/* Material intake */}
          <SteelPanel rivets>
            <div className="flex items-center justify-between border-b border-plant-edge/70 px-4 py-3">
              <div>
                <Stencil className="block text-[10px] text-white">
                  Material intake
                </Stencil>
                <span className="mt-0.5 block text-[10px] text-plant-paint/50">
                  Paste an Obsidian note, or pull the inbox.
                </span>
              </div>
              <ClipboardList className="h-5 w-5 shrink-0 text-plant-paint/60" />
            </div>
            <div className="p-4">
              <textarea
                value={obsidianNote}
                onChange={(event) => setObsidianNote(event.target.value)}
                placeholder={"---\nproject: My Project\npurpose: ...\n---"}
                rows={5}
                aria-label="Obsidian note"
                className={cn(FIELD_CLASS, "resize-none font-mono text-xs")}
              />
              <div className="mt-3 grid grid-cols-2 gap-2">
                <PlantButton
                  size="sm"
                  loading={busy}
                  disabled={!obsidianNote.trim()}
                  onClick={importObsidian}
                >
                  Take in note
                </PlantButton>
                <PlantButton
                  size="sm"
                  loading={busy}
                  onClick={scanInbox}
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                >
                  Scan inbox
                </PlantButton>
              </div>
            </div>
          </SteelPanel>

          {/* Job tickets waiting on the dock */}
          <SteelPanel>
            <div className="flex items-center justify-between border-b border-plant-edge/70 px-4 py-2.5">
              <Stencil className="text-[10px] text-plant-paint/70">Job tickets</Stencil>
              <span className="font-mono text-[11px] tabular-nums text-plant-safety/80">
                {String(projects.length).padStart(2, "0")}
              </span>
            </div>
            <div className="max-h-64 divide-y divide-plant-edge/40 overflow-y-auto">
              {projects.map((project) => (
                <button
                  key={project.id}
                  onClick={() => setActiveId(project.id)}
                  aria-current={activeId === project.id ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2.5 text-left transition",
                    activeId === project.id
                      ? "border-l-2 border-plant-safety bg-plant-safety/[0.06] text-white"
                      : "border-l-2 border-transparent text-plant-paint hover:bg-white/[0.03] hover:text-white",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {project.name}
                    </span>
                    <Stencil className="mt-0.5 block text-[8px] text-plant-paint/45">
                      {project.status.replace("_", " ")} ·{" "}
                      {project.routingMode ?? "legacy default"}
                    </Stencil>
                  </span>
                </button>
              ))}
              {!projects.length && (
                <p className="px-4 py-8 text-center text-xs leading-5 text-plant-paint/40">
                  Nothing on the dock.
                  <br />
                  Write a job ticket to start the line.
                </p>
              )}
            </div>
          </SteelPanel>
        </div>

        {/* -------------------------------------------------------------- */}
        {/* The line                                                        */}
        {/* -------------------------------------------------------------- */}
        <div className="space-y-5">
          <SteelPanel rivets>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-plant-edge/70 px-5 py-4">
              <div className="min-w-0">
                <Stencil className="block text-[9px] text-plant-paint/50">
                  Final assembly · 8 bays
                </Stencil>
                <h2 className="mt-1 truncate text-lg font-bold uppercase tracking-[0.05em] text-white">
                  {active?.name ?? "The line"}
                </h2>
                <p className="mt-1 max-w-2xl text-xs leading-5 text-plant-paint/60">
                  {active?.constitution.purpose ??
                    "Pick a job ticket to see every bay and handoff."}
                </p>
              </div>
              {active && (active.status === "draft" || active.status === "queued") && (
                <PlantButton
                  variant="line"
                  size="sm"
                  loading={busy}
                  onClick={startProject}
                  icon={<Play className="h-3.5 w-3.5" />}
                >
                  Start the line
                </PlantButton>
              )}
            </div>

            <div className="px-5 pb-5 pt-3">
              {/* Overhead power-and-free conveyor */}
              <ConveyorRail moving={board.running > 0} />

              <div className="mt-2 grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
                {stations.map((station, index) => {
                  const Icon = ICONS[station.id];
                  const run = active?.stations.find(
                    (item) => item.stationId === station.id,
                  );
                  const adapter = adapters.find(
                    (item) => item.stationId === station.id,
                  );
                  const status: AndonStatus = run?.status ?? "queued";
                  const lit = status === "active";
                  return (
                    <motion.div
                      key={station.id}
                      className={cn(
                        "plant-steel relative overflow-hidden rounded-[3px] border p-3.5",
                        BAY_STYLE[status],
                      )}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.035 }}
                    >
                      {/* Work light over the bay being worked */}
                      {lit && (
                        <span
                          aria-hidden
                          className="pointer-events-none absolute -top-10 left-1/2 h-24 w-32 -translate-x-1/2 rounded-full bg-plant-sodium/[0.16] blur-2xl"
                        />
                      )}

                      <div className="relative flex items-start justify-between gap-2">
                        <div className="grid h-9 w-9 place-items-center rounded-[3px] border border-plant-edge bg-plant-night/70 text-plant-paint">
                          <Icon className="h-4 w-4" />
                        </div>
                        <AndonStack status={status} />
                      </div>

                      <div className="relative mt-3 flex items-center justify-between gap-2">
                        <BayNumber n={index + 1} />
                        <Stencil className="truncate text-[8px] text-plant-paint/45">
                          {ANDON[status].label}
                        </Stencil>
                      </div>

                      <h3 className="relative mt-1.5 text-sm font-semibold text-white">
                        {station.name}
                      </h3>
                      <Stencil className="relative mt-1 block text-[8px] text-plant-paint/45">
                        {station.department}
                      </Stencil>
                      {/* Clamped so every bay on the line is the same height —
                          a line with ragged stations does not read as a line. */}
                      <p
                        className="relative mt-2 line-clamp-3 min-h-[3rem] text-[11px] leading-4 text-plant-paint/70"
                        title={run?.summary || station.purpose}
                      >
                        {run?.summary || station.purpose}
                      </p>

                      <div className="relative mt-2 flex items-center justify-between text-[10px] text-plant-paint/40">
                        <span>
                          {station.standalone ? "Runs standalone" : "Foundry only"}
                        </span>
                        {run?.attempt ? (
                          <span className="font-mono tabular-nums">
                            Pass {run.attempt}
                          </span>
                        ) : null}
                      </div>

                      <div className="relative mt-2 flex items-center justify-between gap-2 border-t border-plant-edge/50 pt-2 text-[10px]">
                        <span
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-1",
                            adapter?.configured
                              ? "text-plant-go/80"
                              : "text-plant-safety/80",
                          )}
                          title={adapter?.destination}
                        >
                          <PlugZap className="h-3 w-3 shrink-0" />
                          <span className="truncate">
                            {adapter?.configured
                              ? `${adapter.mode} hookup`
                              : "Not hooked up"}
                          </span>
                        </span>
                        {run &&
                          (run.status === "needs_attention" ||
                            run.status === "failed") && (
                            <button
                              disabled={busy}
                              onClick={() => void runStation(station.id)}
                              className="shrink-0 rounded-[2px] border border-plant-edge bg-plant-steel px-1.5 py-1 text-[9px] font-semibold uppercase tracking-[0.1em] text-plant-paint hover:text-white disabled:opacity-40"
                            >
                              Restart
                            </button>
                          )}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          </SteelPanel>

          {active && (
            <div className="grid gap-4 md:grid-cols-3">
              <SteelPanel className="md:col-span-2">
                <div className="border-b border-plant-edge/70 px-4 py-2.5">
                  <Stencil className="text-[10px] text-white">Build sheet</Stencil>
                </div>
                <div className="grid gap-4 p-4 text-xs text-plant-paint/70 md:grid-cols-2">
                  <div>
                    <Stencil className="mb-2 block text-[9px] text-plant-paint/50">
                      Acceptance criteria
                    </Stencil>
                    {active.constitution.successCriteria.length ? (
                      active.constitution.successCriteria.map((item) => (
                        <p key={item} className="leading-5">
                          — {item}
                        </p>
                      ))
                    ) : (
                      <p>Factory Deck resolves these at bay 04.</p>
                    )}
                  </div>
                  <div>
                    <Stencil className="mb-2 block text-[9px] text-plant-paint/50">
                      Repos or programs
                    </Stencil>
                    {active.constitution.targets.length ? (
                      active.constitution.targets.map((item) => (
                        <p key={item} className="break-all leading-5">
                          — {item}
                        </p>
                      ))
                    ) : (
                      <p>New build. No repository attached.</p>
                    )}
                  </div>
                </div>
              </SteelPanel>

              <SteelPanel>
                <div className="border-b border-plant-edge/70 px-4 py-2.5">
                  <Stencil className="text-[10px] text-white">Quality gate</Stencil>
                </div>
                <p className="p-4 text-[11px] leading-5 text-plant-paint/70">
                  Every bay writes its result to a hash-chained ledger. A bay cannot
                  overwrite the Crucible&apos;s findings, and no bay certifies its own
                  release.
                </p>
              </SteelPanel>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
