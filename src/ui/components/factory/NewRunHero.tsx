import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Rocket,
  Wand2,
  TriangleAlert,
  ArrowRight,
  MessageCircleQuestion,
  Sparkles,
  GitBranch,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "../ui/Button.js";
import { Textarea } from "../ui/Textarea.js";
import { Input } from "../ui/Input.js";
import { Badge } from "../ui/Badge.js";
import { Tabs } from "../ui/Tabs.js";
import { slideUp, staggerContainer, staggerItem } from "../../lib/motion.js";
import { ProviderRoutingCards, type PaidRouting } from "./ProviderRoutingCards.js";
import { SafetySettingsPreview } from "./SafetySettingsPreview.js";
import { ExtendExistingPanel } from "./ExtendExistingPanel.js";
import { api } from "../../lib/api.js";
import { repoNameProblem } from "../../../shared/schemas.js";
import type { Health, RunOptions } from "../../../shared/schemas.js";

const EXAMPLES = [
  "Build me a family chore tracker with rewards",
  "Build a Bible reading habit tracker",
  "Build a local inventory app for my home office",
];

/**
 * NewRunHero — the landing / new-run screen. Owns the idea text and the
 * live/demo provider choice, and surfaces helpful warnings (missing keys)
 * before the user starts a run.
 */
export function NewRunHero({
  health,
  starting,
  onStart,
}: {
  health: Health | null;
  starting: boolean;
  onStart: (idea: string, options: RunOptions) => void;
}) {
  const hasAnyKey =
    (health?.anthropicConfigured ?? false) || (health?.openaiConfigured ?? false);
  const [idea, setIdea] = useState("");
  // Demo/simulate mode is not an owner surface — a run without a provider
  // fails loudly with the real missing-credential error instead of silently
  // producing a mock app. The option no longer exists at all: the server
  // rejects options.demo outright.
  const [runMode, setRunMode] = useState<"new" | "extend">("new");
  // Which provider is PRIMARY for runs started from this screen. "auto" is
  // the free-first default; pinning Claude/OpenAI sends an explicit
  // codeProvider/reviewProvider, which is the ONLY thing that makes the
  // server prefer a paid provider (configured keys alone never do — the
  // owner read the checkmarks as "paid" on 2026-08-14 and got a free run).
  const [routing, setRouting] = useState<PaidRouting>("auto");
  // The owner names a brand-new app/repo up front. Factory Deck never invents
  // one and never buries the build in an anonymous workspace folder.
  const [repoName, setRepoName] = useState("");
  // Owner order 2026-08-15: "some things I work on are just for me." Checked
  // (default), a finished app is listed in the owner's app store and picked
  // up by PromoPilot; unchecked, it is still built, saved to GitHub, and
  // hosted - just never listed or promoted.
  const [publish, setPublish] = useState(true);
  const nameCheck = useRepoNameCheck(repoName);

  // EVERY submission path (new app, extend direct, extend clarify) flows
  // through this wrapper so a pinned paid primary is never silently dropped
  // by a panel that forgot to include it.
  const startWithRouting = (ideaText: string, options: RunOptions) =>
    onStart(
      ideaText,
      routing !== "auto"
        ? {
            ...options,
            codeProvider: routing,
            reviewProvider: routing,
            allowPaidProviderCalls: true,
          }
        : { ...options, allowPaidProviderCalls: false },
    );

  const start = () => {
    const trimmed = idea.trim();
    if (!trimmed) return;
    startWithRouting(trimmed, {
      publish,
      mode: "new",
      newRepo: { name: repoName.trim(), private: true },
    });
  };

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="mx-auto max-w-4xl"
    >
      {/* Hero header */}
      <motion.div variants={staggerItem} className="text-center">
        <Badge
          tone="cyan"
          className="mx-auto mb-4"
          icon={<Wand2 className="h-3 w-3" />}
        >
          Local AI Software Factory
        </Badge>
        <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          Build apps through an <span className="text-aurora">AI assembly line</span>
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-pretty text-sm leading-relaxed text-slate-400 sm:text-base">
          Planner, architect, builder, tester, critic, and repair agents work together
          locally while calling your configured Claude and OpenAI APIs.
        </p>
      </motion.div>

      <motion.div variants={slideUp} className="mt-6 flex justify-center">
        <Tabs
          items={[
            {
              id: "new",
              label: "Build a New App",
              icon: <Sparkles className="h-3.5 w-3.5" />,
            },
            {
              id: "extend",
              label: "Extend an Existing Program",
              icon: <MessageCircleQuestion className="h-3.5 w-3.5" />,
            },
          ]}
          active={runMode}
          onChange={(id) => setRunMode(id as "new" | "extend")}
        />
      </motion.div>

      {/* Provider routing governs BOTH modes — it used to live inside the
          new-app panel only, so extend-mode runs (the common case for real
          repos) had no provider control at all. */}
      <motion.div variants={slideUp} className="mx-auto mt-6 max-w-3xl">
        <p className="mb-2 text-xs font-medium text-slate-400">Provider routing</p>
        <ProviderRoutingCards
          health={health}
          routing={routing}
          onRoutingChange={setRouting}
        />
      </motion.div>

      {runMode === "new" && (
        <motion.div variants={slideUp} className="mx-auto mt-4 max-w-3xl">
          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-white/5 bg-white/[0.03] p-3 text-sm text-slate-300 transition-colors hover:bg-white/[0.05]">
            <input
              type="checkbox"
              checked={publish}
              onChange={(e) => setPublish(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-aurora-violet"
            />
            <span>
              <span className="font-medium text-white">Publish this app</span>
              <span className="block text-xs text-slate-400">
                List the finished app in your Axiom BioLabs app store and let PromoPilot
                promote it. Uncheck for something that is just for you - it still gets
                built, saved to GitHub, and hosted, but never listed or promoted.
              </span>
            </span>
          </label>
        </motion.div>
      )}

      {runMode === "extend" ? (
        <ExtendExistingPanel
          starting={starting}
          onStart={startWithRouting}
          routing={routing}
        />
      ) : (
        <NewAppPanel
          idea={idea}
          setIdea={setIdea}
          repoName={repoName}
          setRepoName={setRepoName}
          nameCheck={nameCheck}
          hasAnyKey={hasAnyKey}
          health={health}
          starting={starting}
          start={start}
        />
      )}
    </motion.div>
  );
}

interface NameCheck {
  /** Client-side format problem, or null when the name is well formed. */
  problem: string | null;
  availability: "exists" | "free" | "unknown" | "idle";
  /** owner/name once the backend has resolved the GitHub owner. */
  fullName: string | null;
  reason: string | null;
  checking: boolean;
}

/**
 * Validate the repo name as it is typed, then ask the backend whether GitHub
 * already has it. Debounced so typing does not fire a `gh` call per keystroke.
 *
 * "unknown" is surfaced as unknown — never rendered as "available". A name we
 * could not check may still collide, and saying otherwise would be a claim the
 * UI did not verify.
 */
function useRepoNameCheck(name: string): NameCheck {
  const trimmed = name.trim();
  const problem = trimmed ? repoNameProblem(trimmed) : null;
  const [state, setState] = useState<Omit<NameCheck, "problem">>({
    availability: "idle",
    fullName: null,
    reason: null,
    checking: false,
  });

  useEffect(() => {
    if (!trimmed || problem) {
      setState({
        availability: "idle",
        fullName: null,
        reason: null,
        checking: false,
      });
      return;
    }
    let active = true;
    setState((s) => ({ ...s, checking: true }));
    const timer = setTimeout(() => {
      api
        .checkRepoName(trimmed)
        .then((res) => {
          if (!active) return;
          setState({
            availability: res.valid ? res.availability : "unknown",
            fullName: res.fullName ?? null,
            reason: res.reason,
            checking: false,
          });
        })
        .catch(() => {
          if (!active) return;
          setState({
            availability: "unknown",
            fullName: null,
            reason: "Could not reach the backend to check this name.",
            checking: false,
          });
        });
    }, 450);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [trimmed, problem]);

  return { problem, ...state };
}

function NewAppPanel({
  idea,
  setIdea,
  repoName,
  setRepoName,
  nameCheck,
  hasAnyKey,
  health,
  starting,
  start,
}: {
  idea: string;
  setIdea: (v: string) => void;
  repoName: string;
  setRepoName: (v: string) => void;
  nameCheck: NameCheck;
  hasAnyKey: boolean;
  health: Health | null;
  starting: boolean;
  start: () => void;
}) {
  const nameReady =
    repoName.trim().length > 0 &&
    !nameCheck.problem &&
    nameCheck.availability !== "exists";

  return (
    <>
      {/* Prompt panel */}
      <motion.div variants={slideUp} className="glass mt-8 p-5 sm:p-6">
        {/* Name FIRST: the owner names the app/repo before describing it, and
            that name becomes the workspace folder AND the created repo. */}
        <label
          htmlFor="repo-name"
          className="mb-2 block text-xs font-medium text-slate-400"
        >
          Name your app / repo (a private GitHub repo is created with this name)
        </label>
        <Input
          id="repo-name"
          value={repoName}
          onChange={(e) => setRepoName(e.target.value)}
          placeholder="e.g. bible-habit-tracker"
          aria-label="App and repository name"
        />
        <div className="mt-2 min-h-[1.25rem] text-[11px]">
          {nameCheck.problem ? (
            <span className="text-red-300">{nameCheck.problem}</span>
          ) : nameCheck.checking ? (
            <span className="text-slate-500">Checking GitHub…</span>
          ) : nameCheck.availability === "exists" ? (
            <span className="text-red-300">
              {nameCheck.fullName} already exists — pick a different name.
            </span>
          ) : nameCheck.availability === "free" ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-300">
              <GitBranch className="h-3 w-3" />
              Will create {nameCheck.fullName} (private) and push the finished work
              there.
            </span>
          ) : nameCheck.availability === "unknown" && nameCheck.reason ? (
            <span className="text-amber-300">{nameCheck.reason}</span>
          ) : null}
        </div>

        <label
          htmlFor="idea"
          className="mb-2 mt-5 block text-xs font-medium text-slate-400"
        >
          Describe the app you want
        </label>
        <Textarea
          id="idea"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") start();
          }}
          rows={3}
          placeholder={`e.g. ${EXAMPLES[1]}`}
          aria-label="Describe the app you want to build"
        />

        {/* Example chips */}
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="self-center text-[11px] text-slate-500">Try:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setIdea(ex)}
              className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[11px] text-slate-300 transition-colors hover:border-aurora-cyan/40 hover:text-white"
            >
              {ex}
            </button>
          ))}
        </div>

        {/* Warnings / helpers (provider routing renders above, shared with
            extend mode) */}
        <div className="mt-5 space-y-2">
          {!hasAnyKey && (
            <Helper tone="amber" icon={<TriangleAlert className="h-3.5 w-3.5" />}>
              No API keys detected — add keys in <code>.env</code> to build. Every run
              does real work; there is no demo or test mode.
            </Helper>
          )}
        </div>

        {/* Action row */}
        <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SafetySettingsPreview health={health} />
          <Button
            size="lg"
            onClick={start}
            loading={starting}
            disabled={!idea.trim() || !nameReady}
            icon={<Rocket className="h-4.5 w-4.5" />}
            className="group"
          >
            Start Factory Run
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Button>
        </div>
      </motion.div>

      <motion.p
        variants={staggerItem}
        className="mt-3 text-center text-[11px] text-slate-500"
      >
        Tip: press <kbd className="rounded bg-white/10 px-1">⌘/Ctrl</kbd> +{" "}
        <kbd className="rounded bg-white/10 px-1">Enter</kbd> to launch.
      </motion.p>
    </>
  );
}

function Helper({
  tone,
  icon,
  children,
}: {
  tone: "amber" | "violet" | "cyan";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-relaxed",
        tone === "amber" && "border-amber-400/25 bg-amber-400/[0.06] text-amber-200",
        tone === "violet" &&
          "border-aurora-violet/25 bg-aurora-violet/[0.06] text-violet-200",
        tone === "cyan" && "border-aurora-cyan/25 bg-aurora-cyan/[0.06] text-cyan-100",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="[&_code]:rounded [&_code]:bg-black/30 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[11px]">
        {children}
      </span>
    </div>
  );
}
