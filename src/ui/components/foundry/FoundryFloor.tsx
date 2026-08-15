import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Boxes,
  Factory,
  FileInput,
  Hammer,
  Megaphone,
  PackageCheck,
  PlugZap,
  Play,
  Radar,
  RadioTower,
  RefreshCw,
  Search,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import type { ComponentType } from "react";
import { toast } from "sonner";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { cn } from "../../lib/cn.js";

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
  status: "not_selected" | "queued" | "active" | "needs_attention" | "completed" | "failed";
  attempt: number;
  summary: string;
  artifacts: string[];
};

type FoundryProject = {
  id: string;
  name: string;
  status: "draft" | "queued" | "running" | "needs_attention" | "completed" | "failed";
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

const STATUS_STYLE: Record<StationRun["status"], string> = {
  not_selected: "border-white/[0.04] bg-white/[0.015] opacity-45",
  queued: "border-white/10 bg-white/[0.035]",
  active: "border-cyan-300/50 bg-cyan-400/[0.08] shadow-glow",
  needs_attention: "border-amber-400/50 bg-amber-400/[0.08]",
  completed: "border-emerald-400/40 bg-emerald-400/[0.07]",
  failed: "border-rose-400/50 bg-rose-400/[0.08]",
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
  return value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

export function FoundryFloor() {
  const [stations, setStations] = useState<Station[]>([]);
  const [adapters, setAdapters] = useState<Adapter[]>([]);
  const [projects, setProjects] = useState<FoundryProject[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [targets, setTargets] = useState("");
  const [success, setSuccess] = useState("");
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
      toast.success("Project entered Purpose Foundry");
    } catch (error) {
      toast.error("Could not create project", {
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
        body: JSON.stringify({ markdown: obsidianNote, sourcePath: "Obsidian/Purpose Foundry.md" }),
      });
      setObsidianNote("");
      setActiveId(created.id);
      await refresh();
      toast.success("Obsidian note imported", { description: created.name });
    } catch (error) {
      toast.error("Obsidian import failed", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const scanInbox = async () => {
    setBusy(true);
    try {
      const result = await request<{ imported: number; unchanged: number; errors: string[] }>(
        "/api/foundry/obsidian/scan",
        { method: "POST" },
      );
      await refresh();
      toast.success(`Imported ${result.imported} Obsidian note(s)`, {
        description: `${result.unchanged} unchanged · ${result.errors.length} error(s)`,
      });
    } catch (error) {
      toast.error("Could not scan Obsidian inbox", {
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
      toast.success("Assembly line started", { description: active.name });
    } catch (error) {
      toast.error("Could not start assembly line", {
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
      toast.success("Station adapter started");
    } catch (error) {
      toast.error("Could not run station adapter", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-3xl border border-cyan-300/15 bg-gradient-to-br from-cyan-400/[0.08] via-blue-500/[0.04] to-violet-500/[0.07] p-6 md:p-8">
        <div className="absolute right-8 top-1/2 hidden -translate-y-1/2 opacity-10 md:block">
          <Hammer className="h-40 w-40" />
        </div>
        <div className="relative max-w-3xl">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-300">
            <Boxes className="h-4 w-4" /> Purpose-driven product foundry
          </div>
          <h1 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">
            Purpose Foundry
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
            Ideas enter once. Independent specialist programs coordinate through evidence-backed handoffs, adversarial review, release, and production learning.
          </p>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-white">Receiving Dock</h2>
                <p className="text-xs text-slate-400">Enter an idea, project, or combination.</p>
              </div>
              <FileInput className="h-5 w-5 text-cyan-300" />
            </div>
            <div className="space-y-3">
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-slate-600" />
              <textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="What is this project ultimately meant to accomplish?" rows={4} className="w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-slate-600" />
              <input value={targets} onChange={(event) => setTargets(event.target.value)} placeholder="Repos or programs, separated by commas" className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-slate-600" />
              <textarea value={success} onChange={(event) => setSuccess(event.target.value)} placeholder="Success criteria, one per line" rows={3} className="w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-slate-600" />
              <Button className="w-full" loading={busy} disabled={!name.trim() || !purpose.trim()} onClick={createProject} icon={<Hammer className="h-4 w-4" />}>Send to Foundry</Button>
            </div>
          </Card>

          <Card>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-white">Obsidian Intake</h2>
                <p className="text-xs text-slate-400">Paste a note or scan the configured inbox.</p>
              </div>
              <FileInput className="h-5 w-5 text-violet-300" />
            </div>
            <textarea value={obsidianNote} onChange={(event) => setObsidianNote(event.target.value)} placeholder={'---\nproject: My Project\npurpose: ...\n---'} rows={5} className="w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 font-mono text-xs text-white placeholder:text-slate-600" />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button variant="ghost" size="sm" loading={busy} disabled={!obsidianNote.trim()} onClick={importObsidian}>Import note</Button>
              <Button variant="ghost" size="sm" loading={busy} onClick={scanInbox} icon={<RefreshCw className="h-3.5 w-3.5" />}>Scan inbox</Button>
            </div>
          </Card>

          <Card className="p-3">
            <div className="mb-2 flex items-center justify-between px-2 pt-1">
              <span className="text-xs font-semibold text-slate-300">Projects</span>
              <Badge tone="neutral">{projects.length}</Badge>
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {projects.map((project) => (
                <button key={project.id} onClick={() => setActiveId(project.id)} className={cn("w-full rounded-xl px-3 py-2 text-left transition", activeId === project.id ? "bg-cyan-400/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-white")}>
                  <span className="block truncate text-sm font-medium">{project.name}</span>
                  <span className="mt-0.5 block text-[10px] uppercase tracking-wider text-slate-600">{project.status.replace("_", " ")}</span>
                </button>
              ))}
              {!projects.length && <p className="px-3 py-6 text-center text-xs text-slate-600">The receiving dock is empty.</p>}
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold text-white">{active?.name ?? "Factory Floor"}</h2>
                  {active && <Badge tone={active.status === "completed" ? "emerald" : active.status === "failed" ? "rose" : "cyan"}>{active.status.replace("_", " ")}</Badge>}
                </div>
                <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-400">{active?.constitution.purpose ?? "Select a project to see every station and handoff."}</p>
              </div>
              {active && (active.status === "draft" || active.status === "queued") && (
                <Button size="sm" loading={busy} onClick={startProject} icon={<Play className="h-3.5 w-3.5" />}>
                  Start line
                </Button>
              )}
            </div>

            <div className="relative grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
              <div className="pointer-events-none absolute left-6 right-6 top-1/2 hidden h-px bg-gradient-to-r from-cyan-400/0 via-cyan-400/30 to-violet-400/0 2xl:block" />
              {stations.map((station, index) => {
                const Icon = ICONS[station.id];
                const run = active?.stations.find((item) => item.stationId === station.id);
                const adapter = adapters.find((item) => item.stationId === station.id);
                const status = run?.status ?? "queued";
                return (
                  <motion.div key={station.id} className={cn("relative z-10 rounded-2xl border p-4", STATUS_STYLE[status])} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.035 }}>
                    {status === "active" && <motion.span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-cyan-300" animate={{ scale: [1, 1.6, 1], opacity: [1, 0.35, 1] }} transition={{ duration: 1.4, repeat: Infinity }} />}
                    <div className="flex items-start justify-between gap-2">
                      <div className="grid h-9 w-9 place-items-center rounded-xl bg-black/25 text-cyan-200"><Icon className="h-4.5 w-4.5" /></div>
                      <span className="rounded-full bg-black/20 px-2 py-1 text-[9px] uppercase tracking-wider text-slate-500">{status.replace("_", " ")}</span>
                    </div>
                    <p className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{station.department}</p>
                    <h3 className="mt-1 text-sm font-semibold text-white">{station.name}</h3>
                    <p className="mt-1.5 min-h-12 text-[11px] leading-4 text-slate-400">{run?.summary || station.purpose}</p>
                    <div className="mt-3 flex items-center justify-between text-[10px] text-slate-600">
                      <span>{station.standalone ? "Standalone + Foundry" : "Foundry service"}</span>
                      {run?.attempt ? <span>Attempt {run.attempt}</span> : null}
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/[0.05] pt-2 text-[10px]">
                      <span className={cn("flex min-w-0 items-center gap-1", adapter?.configured ? "text-emerald-400" : "text-amber-400")} title={adapter?.destination}>
                        <PlugZap className="h-3 w-3 shrink-0" />
                        <span className="truncate">{adapter?.configured ? `${adapter.mode} configured` : "setup needed"}</span>
                      </span>
                      {run && (run.status === "needs_attention" || run.status === "failed") && (
                        <button disabled={busy} onClick={() => void runStation(station.id)} className="shrink-0 rounded-md bg-white/5 px-2 py-1 text-slate-300 hover:bg-white/10 disabled:opacity-40">
                          Retry
                        </button>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </Card>

          {active && (
            <div className="grid gap-4 md:grid-cols-3">
              <Card className="md:col-span-2">
                <h3 className="text-sm font-semibold text-white">Project Constitution</h3>
                <div className="mt-3 grid gap-4 text-xs text-slate-400 md:grid-cols-2">
                  <div><p className="mb-1 font-semibold text-slate-300">Success criteria</p>{active.constitution.successCriteria.length ? active.constitution.successCriteria.map((item) => <p key={item}>• {item}</p>) : <p>To be resolved by Factory Deck.</p>}</div>
                  <div><p className="mb-1 font-semibold text-slate-300">Targets</p>{active.constitution.targets.length ? active.constitution.targets.map((item) => <p key={item}>• {item}</p>) : <p>New project; no repository attached.</p>}</div>
                </div>
              </Card>
              <Card>
                <h3 className="text-sm font-semibold text-white">Evidence Discipline</h3>
                <p className="mt-2 text-xs leading-5 text-slate-400">Every station event is written to a hash-chained ledger. Implementers cannot silently replace the Crucible's findings or certify their own release.</p>
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
