import { useState } from "react";
import { motion } from "framer-motion";
import {
  Rocket,
  Wand2,
  Info,
  TriangleAlert,
  FlaskConical,
  ArrowRight,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "../ui/Button.js";
import { Textarea } from "../ui/Textarea.js";
import { Badge } from "../ui/Badge.js";
import { slideUp, staggerContainer, staggerItem } from "../../lib/motion.js";
import { ProviderRoutingCards } from "./ProviderRoutingCards.js";
import { SafetySettingsPreview } from "./SafetySettingsPreview.js";
import type { Health, RunOptions } from "../../../shared/schemas.js";

const EXAMPLES = [
  "Build me a family chore tracker with rewards",
  "Build a Bible reading habit tracker",
  "Build a local inventory app for my home office",
];

/**
 * NewRunHero — the landing / new-run screen. Owns the idea text and the
 * live/demo provider choice, and surfaces helpful warnings (missing keys,
 * dry-run mode) before the user starts a run.
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
  const [demo, setDemo] = useState(!hasAnyKey);

  const start = () => {
    const trimmed = idea.trim();
    if (!trimmed) return;
    onStart(trimmed, { demo });
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

      {/* Prompt panel */}
      <motion.div variants={slideUp} className="glass mt-8 p-5 sm:p-6">
        <label htmlFor="idea" className="mb-2 block text-xs font-medium text-slate-400">
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

        {/* Provider routing */}
        <div className="mt-6">
          <p className="mb-2 text-xs font-medium text-slate-400">Provider routing</p>
          <ProviderRoutingCards health={health} demo={demo} onToggleDemo={setDemo} />
        </div>

        {/* Warnings / helpers */}
        <div className="mt-5 space-y-2">
          {!hasAnyKey && (
            <Helper tone="amber" icon={<TriangleAlert className="h-3.5 w-3.5" />}>
              No API keys detected. You can still explore the full assembly line in{" "}
              <strong>demo mode</strong> — add keys in <code>.env</code> for real
              builds.
            </Helper>
          )}
          {hasAnyKey && demo && (
            <Helper tone="violet" icon={<FlaskConical className="h-3.5 w-3.5" />}>
              Demo mode selected — this run uses the offline stub provider (no API
              calls).
            </Helper>
          )}
          {health?.dryRunCommands && !demo && (
            <Helper tone="cyan" icon={<Info className="h-3.5 w-3.5" />}>
              <code>DRY_RUN_COMMANDS=true</code> — install/test commands are previewed,
              not executed. Flip it in <code>.env</code> to run them.
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
            disabled={!idea.trim()}
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
    </motion.div>
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
