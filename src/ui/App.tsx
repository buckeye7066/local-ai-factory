import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Toaster, toast } from "sonner";
import { ErrorBoundary } from "./components/ui/ErrorBoundary.js";
import {
  Workflow,
  ScrollText,
  FolderGit2,
  FolderOpen,
  Copy,
  Boxes,
  Send,
} from "lucide-react";
import { AppShell } from "./components/layout/AppShell.js";
import type { NavKey } from "./components/layout/Sidebar.js";
import { NewRunHero } from "./components/factory/NewRunHero.js";
import { AgentAssemblyLine } from "./components/factory/AgentAssemblyLine.js";
import { StageTimeline } from "./components/factory/StageTimeline.js";
import { RunControlBar } from "./components/factory/RunControlBar.js";
import { LogsPanel } from "./components/logs/LogsPanel.js";
import { FilesPanel } from "./components/files/FilesPanel.js";
import { FinalReport } from "./components/reports/FinalReport.js";
import { RunHistory } from "./components/history/RunHistory.js";
import { SettingsPage } from "./components/settings/SettingsPage.js";
import { FoundryFloor } from "./components/foundry/FoundryFloor.js";
import { Card, CardHeader } from "./components/ui/Card.js";
import { Tabs } from "./components/ui/Tabs.js";
import { Badge } from "./components/ui/Badge.js";
import { EmptyState } from "./components/ui/EmptyState.js";
import { Button } from "./components/ui/Button.js";
import { Textarea } from "./components/ui/Textarea.js";
import { routeTransition } from "./lib/motion.js";
import { useClipboard } from "./lib/useClipboard.js";
import { api, useHealth, useRunPolling } from "./lib/api.js";
import type { EpicSummary } from "./lib/api.js";
import { useTheme } from "./lib/useTheme.js";
import { runIsReady } from "./lib/runOutcome.js";
import type { RunOptions, RunSummary, FileContent } from "../shared/schemas.js";

type View = NavKey | "run";

/** Human-readable name for the current view, used in the crash fallback. */
function viewLabel(view: string): string {
  switch (view) {
    case "new":
      return "the New Run screen";
    case "history":
      return "the Runs list";
    case "workspaces":
      return "the Workspaces list";
    case "settings":
      return "Settings";
    case "run":
      return "the run view";
    case "foundry":
      return "the Foundry floor";
    default:
      return "this panel";
  }
}

export function App() {
  const { theme, toggle } = useTheme();
  const { health } = useHealth();

  const [view, setView] = useState<View>(() =>
    new URLSearchParams(window.location.search).get("mode") === "foundry"
      ? "foundry"
      : "new",
  );
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [epics, setEpics] = useState<EpicSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [files, setFiles] = useState<FileContent[]>([]);

  const { run, refresh: refreshRun } = useRunPolling(
    view === "run" ? activeRunId : null,
  );
  const lastStatus = useRef<string | null>(null);

  const refreshRuns = useCallback(async (): Promise<boolean> => {
    try {
      const { runs: list } = await api.listRuns();
      setRuns(list);
      setRunsLoading(false);
      // Epics are fetched on the SAME tick, and a failure here must not make
      // the runs list look offline: a large evolution lives in /api/epics and
      // only becomes a /api/runs record once a slice actually starts, so an
      // epic that is planning, paused, or holding pending slices has no run
      // to represent it. Losing epics is a missing panel; losing runs is a
      // dead UI, so they get different failure handling.
      try {
        const { epics: list2 } = await api.listEpics();
        setEpics(list2);
      } catch {
        /* leave the last known epics on screen */
      }
      return true;
    } catch {
      /* backend offline — keep what we have and let the poll retry */
      return false;
    }
  }, []);

  // Keep the run/workspace lists ALIVE, not one-shot. A single fetch on mount
  // silently raced backend startup (launcher opens the browser while the
  // server boots): the catch swallowed the failure and Runs/Workspaces stayed
  // empty forever. Retry fast until the backend answers once, then poll slowly
  // so the lists can never go permanently stale while a run is in flight.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const ok = await refreshRuns();
      if (!active) return;
      timer = setTimeout(poll, ok ? 5000 : 1500);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [refreshRuns]);

  // Start a run. Every run is real work — there is no demo/simulate path.
  const startRun = useCallback(
    async (idea: string, options: RunOptions) => {
      setStarting(true);
      try {
        if (options.epic) {
          const { epic: _epic, ...rest } = options;
          await api.createEpic(idea, rest);
          // Planning happens in the BACKGROUND after this 202, so the slice
          // count does not exist yet. Report only what actually happened —
          // the request was accepted — instead of asserting a plan that may
          // still fail. (This previously read "Planned into undefined slices".)
          toast.success("Evolution accepted", {
            description:
              "Planning it into slices now — this can take a few minutes. Each slice builds, verifies, and merges on its own; they appear in the runs list as they are planned.",
          });
          refreshRuns();
          return;
        }
        const { runId } = await api.createRun(idea, options);
        setActiveRunId(runId);
        setFiles([]);
        setView("run");
        lastStatus.current = "queued";
        toast.success("Factory run started", {
          description: idea,
        });
        refreshRuns();
      } catch (e) {
        toast.error("Could not start run", {
          description:
            e instanceof Error
              ? e.message
              : "Is the backend running? (pnpm dev)",
        });
      } finally {
        setStarting(false);
      }
    },
    [refreshRuns],
  );

  // Toast + refresh on terminal transitions; fetch file contents as they grow.
  useEffect(() => {
    if (!run) return;
    if (run.status !== lastStatus.current) {
      if (run.status === "completed") {
        if (runIsReady(run)) {
          toast.success(`${run.appName ?? "App"} is verified and ready`, {
            description: `Completed in ${run.stages.length} stages · ${run.repairLoops} repair loop(s).`,
          });
        } else {
          toast.warning("Run finished without a verified ready outcome", {
            description: run.demo
              ? "This was a simulation; mock output is never delivered."
              : "Open the run for its delivery and verification status.",
          });
        }
        refreshRuns();
      } else if (run.status === "failed") {
        toast.error("Run failed", { description: run.error ?? undefined });
        refreshRuns();
      } else if (run.status === "cancelled") {
        toast.warning("Run cancelled", {
          description: "The factory stopped cleanly at the next checkpoint.",
        });
        refreshRuns();
      }
      lastStatus.current = run.status;
    }
  }, [run, refreshRuns]);

  // Pull full file contents whenever the file count changes.
  useEffect(() => {
    if (!activeRunId || !run || run.files.length === 0) return;
    let active = true;
    api
      .getFiles(activeRunId)
      .then(({ files: f }) => active && setFiles(f))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [activeRunId, run?.files.length, run]);

  const openRun = useCallback((id: string) => {
    setActiveRunId(id);
    setFiles([]);
    setView("run");
    lastStatus.current = null;
  }, []);

  // Continue a stopped run straight from the Runs list: resume it, then jump
  // into the detail view so the live progress is immediately visible.
  const continueRun = useCallback(
    async (id: string) => {
      try {
        await api.resumeRun(id);
        toast.success("Run resumed", {
          description: "Continuing from the last durable stage checkpoint.",
        });
        openRun(id);
        void refreshRuns();
      } catch (e) {
        toast.error("Could not resume", {
          description: e instanceof Error ? e.message : undefined,
        });
        // The flag may be stale (e.g. another tab already resumed) — resync.
        void refreshRuns();
      }
    },
    [openRun, refreshRuns],
  );

  // Delete a stopped run: its history record AND its workspace directory. One
  // click does the work — no confirmation step (the server is the only thing
  // that refuses, and only for a run that is still executing).
  const deleteRunById = useCallback(
    async (id: string) => {
      try {
        const res = await api.deleteRun(id);
        if (activeRunId === id) {
          setActiveRunId(null);
          setFiles([]);
          setView("history");
        }
        toast.success("Run deleted", { description: res.workspaceNote });
      } catch (e) {
        toast.error("Could not delete run", {
          description: e instanceof Error ? e.message : undefined,
        });
      } finally {
        void refreshRuns();
      }
    },
    [activeRunId, refreshRuns],
  );

  const deleteFinishedRuns = useCallback(async () => {
    try {
      const res = await api.deleteFinishedRuns();
      // Report the real numbers, including a zero-work outcome and anything
      // deliberately skipped — never a bare "done".
      const skipped = res.skippedRunning.length
        ? ` ${res.skippedRunning.length} still running and were kept.`
        : "";
      if (res.deleted === 0) {
        toast.message("Nothing to delete", {
          description: `No finished runs.${skipped}`,
        });
      } else {
        toast.success(
          `Deleted ${res.deleted} of ${res.candidates} finished run(s)`,
          {
            description: `${res.workspacesRemoved} workspace folder(s) removed.${skipped}`,
          },
        );
      }
      setActiveRunId(null);
    } catch (e) {
      toast.error("Could not delete finished runs", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      void refreshRuns();
    }
  }, [refreshRuns]);

  return (
    <AppShell
      active={view}
      onNavigate={(k) => setView(k)}
      health={health}
      theme={theme}
      onToggleTheme={toggle}
      variant={view === "foundry" ? "foundry" : "deck"}
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={view + (view === "run" ? activeRunId : "")}
          variants={routeTransition}
          initial="hidden"
          animate="show"
          exit="exit"
        >
          {/* One panel's render-time throw must not unmount the whole deck.
              The boundary sits INSIDE the shell so the sidebar, top bar and
              every other tab stay usable, and it is keyed by view so simply
              navigating away clears a crashed panel. */}
          <ErrorBoundary label={viewLabel(view)} resetKey={view}>
            {view === "foundry" && <FoundryFloor />}

            {view === "new" && (
              <NewRunHero
                health={health}
                starting={starting}
                onStart={startRun}
              />
            )}

            {view === "history" && (
              <EvolutionsPanel epics={epics} onOpen={openRun} />
            )}

            {view === "history" && (
              <RunHistory
                runs={runs}
                loading={runsLoading}
                onOpen={openRun}
                onContinue={continueRun}
                onDelete={deleteRunById}
                onDeleteFinished={deleteFinishedRuns}
              />
            )}

            {view === "workspaces" && (
              <WorkspacesView
                runs={runs}
                loading={runsLoading}
                onOpen={openRun}
              />
            )}

            {view === "settings" && <SettingsPage health={health} />}

            {view === "run" && run && (
              <RunDetail
                run={run}
                files={files}
                onNewRun={() => setView("new")}
                refreshRun={refreshRun}
              />
            )}

            {view === "run" && !run && (
              <div className="py-20 text-center text-sm text-slate-400">
                Loading run…
              </div>
            )}
          </ErrorBoundary>
        </motion.div>
      </AnimatePresence>

      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: {
            background: "rgba(17,26,46,0.92)",
            border: "1px solid rgba(255,255,255,0.08)",
            color: "#e6edf6",
            backdropFilter: "blur(12px)",
          },
        }}
      />
    </AppShell>
  );
}

/* ------------------------------------------------------------------ */
/* Run detail                                                          */
/* ------------------------------------------------------------------ */

function RunDetail({
  run,
  files,
  onNewRun,
  refreshRun,
}: {
  run: import("../shared/schemas.js").RunRecord;
  files: FileContent[];
  onNewRun: () => void;
  refreshRun: () => void;
}) {
  const [tab, setTab] = useState("logs");
  const [cancelling, setCancelling] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [steering, setSteering] = useState("");
  const [steeringBusy, setSteeringBusy] = useState(false);
  const repairActive =
    run.stages.find((s) => s.id === "repair")?.status === "active";
  const running = run.status === "running" || run.status === "queued";

  useEffect(() => {
    if (!running) {
      setResuming(false);
      setCancelling(false);
    }
  }, [running]);

  const cancel = useCallback(async () => {
    setCancelling(true);
    try {
      await api.cancelRun(run.id);
      toast.message("Stopping run…", {
        description: "The factory will halt at the next checkpoint.",
      });
    } catch (e) {
      setCancelling(false);
      toast.error("Could not cancel", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }, [run.id]);

  const resume = useCallback(async () => {
    setResuming(true);
    try {
      await api.resumeRun(run.id);
      refreshRun();
      toast.success("Run resumed", {
        description: "Continuing from the last durable stage checkpoint.",
      });
    } catch (e) {
      setResuming(false);
      toast.error("Could not resume", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  }, [run.id, refreshRun]);

  const steer = useCallback(async () => {
    const instruction = steering.trim();
    if (!instruction) return;
    setSteeringBusy(true);
    try {
      await api.steerRun(run.id, instruction);
      setSteering("");
      refreshRun();
      toast.success("Steering queued", {
        description: "The next model checkpoint will apply it to this program.",
      });
    } catch (error) {
      toast.error("Could not steer run", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSteeringBusy(false);
    }
  }, [run.id, steering, refreshRun]);

  return (
    <div className="space-y-5">
      <RunControlBar
        run={run}
        onNewRun={onNewRun}
        onCancel={cancel}
        onResume={resume}
        cancelling={cancelling}
        resuming={resuming}
      />

      {running && run.acceptingSteering !== false && (
        <Card>
          <CardHeader
            title="Steer this program"
            subtitle="Additional information is applied at the next model checkpoint and carried through the rest of the run."
          />
          <Textarea
            value={steering}
            onChange={(event) => setSteering(event.target.value)}
            rows={3}
            maxLength={4_000}
            placeholder="Add a correction, constraint, or new detail for this program…"
            aria-label="Steering instruction"
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs text-slate-500">
              {
                (run.steering ?? []).filter((item) => item.status === "pending")
                  .length
              }{" "}
              pending ·{" "}
              {
                (run.steering ?? []).filter((item) => item.status === "applied")
                  .length
              }{" "}
              applied
            </span>
            <Button
              onClick={steer}
              disabled={!steering.trim() || steeringBusy}
              loading={steeringBusy}
              icon={<Send className="h-4 w-4" />}
            >
              Send steering
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Agent Assembly Line"
          subtitle="Specialist agents hand work down the line"
          icon={<Workflow className="h-4.5 w-4.5" />}
        />
        <AgentAssemblyLine stages={run.stages} repairActive={!!repairActive} />
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Stage Timeline" subtitle="Live progress" />
          <StageTimeline
            stages={run.stages}
            loading={running && run.logs.length === 0}
          />
        </Card>

        <div className="lg:col-span-2">
          <Card className="p-0">
            <div className="flex items-center justify-between border-b border-white/[0.06] p-4">
              <Tabs
                items={[
                  {
                    id: "logs",
                    label: "Logs",
                    icon: <ScrollText className="h-3.5 w-3.5" />,
                  },
                  {
                    id: "files",
                    label: "Files",
                    icon: <FolderGit2 className="h-3.5 w-3.5" />,
                    badge: run.files.length ? (
                      <Badge tone="cyan" className="ml-1">
                        {run.files.length}
                      </Badge>
                    ) : undefined,
                  },
                ]}
                active={tab}
                onChange={setTab}
              />
            </div>
            <div className="p-4">
              {tab === "logs" ? (
                <LogsPanel logs={run.logs} running={running} />
              ) : (
                <FilesPanel
                  files={run.files}
                  fileContents={files}
                  workspacePath={run.workspacePath}
                  loading={running && run.files.length === 0}
                />
              )}
            </div>
          </Card>
        </div>
      </div>

      {run.finalReport && (
        <FinalReport
          report={run.finalReport}
          ready={runIsReady(run)}
          onNewRun={onNewRun}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Evolutions (epics)                                                  */
/* ------------------------------------------------------------------ */

const SLICE_TONE: Record<string, string> = {
  released: "bg-emerald-500",
  running: "bg-aurora-cyan animate-pulse",
  failed: "bg-rose-500",
  held: "bg-amber-500",
  pending: "bg-white/15",
};

/**
 * Large evolutions, which the deck could start and never show.
 *
 * `createEpic` shipped with no listing counterpart, and the Runs view reads
 * only `/api/runs` - a record per SLICE RUN. An epic that is planning, paused,
 * or holding twelve pending slices produces no run at all, so the work was
 * invisible while the start toast promised its slices would "appear in the
 * runs list". Nothing is hidden here: a paused epic shows WHY, because
 * `statusReason` is the field the runner is careful never to leave silent.
 */
function EvolutionsPanel({
  epics,
  onOpen,
}: {
  epics: EpicSummary[];
  onOpen: (runId: string) => void;
}) {
  if (!epics.length) return null;
  const live = [...epics].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold tracking-tight">Evolutions</h2>
        <Badge tone="neutral">{live.length}</Badge>
      </div>
      <div className="grid grid-cols-1 gap-3">
        {live.map((e) => {
          const done = e.slices.filter((s) => s.status === "released").length;
          const openRunId =
            e.slices.find((s) => s.status === "running")?.runId ??
            e.slices.find((s) => s.runId)?.runId ??
            null;
          return (
            <Card key={e.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">
                    {e.summary || e.idea.slice(0, 120)}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {e.slices.length > 0
                      ? `${done} of ${e.slices.length} slice(s) released`
                      : "Planning — no slices yet"}
                  </p>
                </div>
                <Badge
                  tone={
                    e.status === "failed"
                      ? "rose"
                      : e.status === "completed"
                        ? "emerald"
                        : e.status === "paused"
                          ? "amber"
                          : e.status === "running"
                            ? "cyan"
                            : "neutral"
                  }
                >
                  {e.status}
                </Badge>
              </div>

              {e.slices.length > 0 && (
                <div className="mt-3 flex gap-1" aria-hidden>
                  {e.slices.map((s, i) => (
                    <span
                      key={`${e.id}-${i}`}
                      title={`${s.title} — ${s.status}`}
                      className={`h-1.5 flex-1 rounded-full ${SLICE_TONE[s.status] ?? "bg-white/15"}`}
                    />
                  ))}
                </div>
              )}

              {/* A paused or failed epic must say WHY. */}
              {e.statusReason && (
                <p className="mt-2 text-xs text-amber-300">{e.statusReason}</p>
              )}

              {openRunId && (
                <button
                  type="button"
                  onClick={() => onOpen(openRunId)}
                  className="mt-3 text-xs text-aurora-cyan hover:underline"
                >
                  Open the slice that is running
                </button>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Workspaces view                                                     */
/* ------------------------------------------------------------------ */

function WorkspacesView({
  runs,
  loading,
  onOpen,
}: {
  runs: RunSummary[];
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  const { copy, copied } = useClipboard();
  const withWorkspaces = runs.filter((r) => r.workspacePath);

  return (
    <div>
      <div className="mb-5 flex items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Workspaces</h1>
        <Badge tone="neutral">{withWorkspaces.length}</Badge>
      </div>

      {loading ? (
        <div className="text-sm text-slate-400">Loading…</div>
      ) : withWorkspaces.length === 0 ? (
        <EmptyState
          icon={<Boxes className="h-6 w-6" />}
          title="No workspaces yet"
          description="Each run writes its generated app into an isolated folder under ./workspaces. Start a run to create one."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {withWorkspaces.map((r) => (
            <Card key={r.id} interactive onClick={() => onOpen(r.id)}>
              <div className="flex items-start gap-3">
                <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/5 text-aurora-cyan">
                  <FolderOpen className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">
                    {r.appName ?? "Untitled app"}
                  </p>
                  <p className="truncate text-xs text-slate-400">{r.idea}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="truncate rounded bg-black/30 px-2 py-1 font-mono text-[11px] text-slate-400">
                      {r.workspacePath}
                    </code>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        // `copy` resolves false when the Clipboard API is
                        // blocked. Await it and report the real outcome — a
                        // success toast over a failed copy is a small lie the
                        // owner only discovers on paste.
                        void copy(r.workspacePath ?? "").then((ok) => {
                          if (ok) toast.success("Workspace path copied");
                          else
                            toast.error("Could not copy the workspace path", {
                              description:
                                "The clipboard is unavailable — select the path and copy it manually.",
                            });
                        });
                      }}
                      aria-label="Copy workspace path"
                      className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      {copied && <span className="sr-only">copied</span>}
    </div>
  );
}
