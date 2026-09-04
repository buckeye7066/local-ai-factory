import { useState } from "react";
import { motion } from "framer-motion";
import {
  Rocket,
  ArrowRight,
  CheckCircle2,
  XCircle,
  FolderGit2,
  GitBranch,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "../ui/Button.js";
import { Textarea } from "../ui/Textarea.js";
import { Input } from "../ui/Input.js";
import { Badge } from "../ui/Badge.js";
import { Tabs } from "../ui/Tabs.js";
import { slideUp } from "../../lib/motion.js";
import { api } from "../../lib/api.js";
import type { RunOptions } from "../../../shared/schemas.js";

/**
 * ExtendExistingPanel — the "enter a program, give it goals" entry point.
 *
 * Two interaction modes, owner picks per session:
 *  - Direct prompt: free text (may embed a repo URL or a project name — the
 *    backend's repo-resolver figures out WHICH repo from the text itself)
 *    goes straight to the pipeline.
 *  - Yes/No clarification: the owner states what they want, Factory Deck asks
 *    ONE yes/no question at a time until confident, then the same pipeline
 *    runs on the refined goal list.
 * An optional explicit repo source (local path or git URL) skips resolution
 * entirely when the owner already knows exactly which program they mean.
 */
export function ExtendExistingPanel({
  starting,
  routingMode,
  onStart,
}: {
  starting: boolean;
  routingMode: NonNullable<RunOptions["routingMode"]>;
  onStart: (idea: string, options: RunOptions) => void;
}) {
  const [sourceType, setSourceType] = useState<"path" | "git">("path");
  const [location, setLocation] = useState("");
  const [interactionMode, setInteractionMode] = useState<"direct" | "clarify">(
    "direct",
  );
  const [prompt, setPrompt] = useState("");

  const repoSource = location.trim()
    ? { type: sourceType, location: location.trim() }
    : undefined;

  return (
    <motion.div variants={slideUp} className="glass mt-8 p-5 sm:p-6">
      <p className="mb-2 text-xs font-medium text-slate-400">
        Existing program (optional — leave blank and just describe it in your prompt
        below; Factory Deck will resolve a repo URL or project name from the text
        itself)
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Tabs
          items={[
            { id: "path", label: "Local path" },
            { id: "git", label: "Git URL" },
          ]}
          active={sourceType}
          onChange={(id) => setSourceType(id as "path" | "git")}
        />
        <Input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder={
            sourceType === "path"
              ? "D:\\Projects\\MyApp"
              : "https://github.com/you/my-app"
          }
          aria-label="Existing program path or URL"
          className="flex-1"
        />
      </div>

      {/* WHERE THE WORK LANDS — stated before the run starts, not after.
          The repo attached above IS the destination. The run commits onto its
          own factory-deck/* branch (the audit trail), pushes it, and then
          fast-forwards the repo's default branch onto it, so the finished work
          is on main and therefore in production. Owner order 2026-08-19. */}
      <div
        className={cn(
          "mt-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-[11px] leading-relaxed",
          repoSource
            ? "border-aurora-cyan/25 bg-aurora-cyan/[0.06] text-cyan-100"
            : "border-white/10 bg-white/[0.03] text-slate-400",
        )}
      >
        <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {repoSource ? (
          <span>
            The finished work is saved in{" "}
            <strong className="font-mono">{repoSource.location}</strong> — committed on
            this run's own <code>factory-deck/&lt;run-id&gt;</code> branch, pushed back
            there, then <strong>merged into main</strong>, so it is in production. The
            branch stays as the audit trail. Never a force-push: main only ever
            fast-forwards, and a rejected fast-forward is reported rather than
            overridden.
          </span>
        ) : (
          <span>
            No repo attached yet. Factory Deck will resolve one from your prompt below,
            and the work will be saved back into whichever repo it resolves.
          </span>
        )}
      </div>

      <div className="mt-6">
        <Tabs
          items={[
            { id: "direct", label: "Direct Prompt" },
            { id: "clarify", label: "Ask Me Yes/No Questions" },
          ]}
          active={interactionMode}
          onChange={(id) => setInteractionMode(id as "direct" | "clarify")}
        />
      </div>

      <div className="mt-4">
        {interactionMode === "direct" ? (
          <DirectPromptMode
            starting={starting}
            prompt={prompt}
            setPrompt={setPrompt}
            repoSource={repoSource}
            onStart={onStart}
          />
        ) : (
          <ClarifyMode
            starting={starting}
            routingMode={routingMode}
            repoSource={repoSource}
            onStart={onStart}
          />
        )}
      </div>
    </motion.div>
  );
}

function DirectPromptMode({
  starting,
  prompt,
  setPrompt,
  repoSource,
  onStart,
}: {
  starting: boolean;
  prompt: string;
  setPrompt: (v: string) => void;
  repoSource: { type: "path" | "git"; location: string } | undefined;
  onStart: (idea: string, options: RunOptions) => void;
}) {
  const [epic, setEpic] = useState(false);
  const start = () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onStart(trimmed, { mode: "extend", repoSource, epic });
  };
  return (
    <>
      <label
        htmlFor="extend-prompt"
        className="mb-2 block text-xs font-medium text-slate-400"
      >
        What do you want done? (goals go straight to implementation — no clarification
        loop)
      </label>
      <Textarea
        id="extend-prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        placeholder="e.g. here's a repo: https://github.com/you/futureu — add a parent-visible progress dashboard"
        aria-label="Describe what to change in the existing program"
      />
      <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-xl border border-white/5 bg-white/[0.03] p-3 text-sm text-slate-300 transition-colors hover:bg-white/[0.05]">
        <input
          type="checkbox"
          checked={epic}
          onChange={(e) => setEpic(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-aurora-violet"
        />
        <span>
          <span className="font-medium text-white">This is a big change</span>
          <span className="block text-xs text-slate-400">
            Break it into small steps automatically. Each step is built, tested, and
            merged on its own before the next one starts - so a large evolution lands as
            a series of real, working improvements instead of one giant attempt.
          </span>
        </span>
      </label>
      <div className="mt-4 flex justify-end">
        <Button
          size="lg"
          onClick={start}
          loading={starting}
          disabled={!prompt.trim()}
          icon={<Rocket className="h-4.5 w-4.5" />}
        >
          Implement It
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </>
  );
}

function ClarifyMode({
  starting,
  routingMode,
  repoSource,
  onStart,
}: {
  starting: boolean;
  routingMode: NonNullable<RunOptions["routingMode"]>;
  repoSource: { type: "path" | "git"; location: string } | undefined;
  onStart: (idea: string, options: RunOptions) => void;
}) {
  const [initialRequest, setInitialRequest] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [confident, setConfident] = useState(false);
  const [refinedGoals, setRefinedGoals] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const beginClarifying = async () => {
    const trimmed = initialRequest.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.startClarify(trimmed, routingMode);
      setSessionId(res.sessionId);
      setQuestion(res.question);
      setConfident(res.confident);
      setRefinedGoals(res.refinedGoals);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start clarification.");
    } finally {
      setBusy(false);
    }
  };

  const answer = async (value: "yes" | "no") => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.answerClarify(sessionId, value);
      setQuestion(res.question);
      setConfident(res.confident);
      setRefinedGoals(res.refinedGoals);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not submit answer.");
    } finally {
      setBusy(false);
    }
  };

  const build = () => {
    onStart(initialRequest.trim(), { mode: "extend", repoSource, goals: refinedGoals });
  };

  if (!sessionId) {
    return (
      <>
        <label
          htmlFor="clarify-request"
          className="mb-2 block text-xs font-medium text-slate-400"
        >
          Tell me what you want — I'll ask yes/no questions until I'm confident
        </label>
        <Textarea
          id="clarify-request"
          value={initialRequest}
          onChange={(e) => setInitialRequest(e.target.value)}
          rows={3}
          placeholder="e.g. improve the parent dashboard in FutureU"
          aria-label="Describe what you want at a high level"
        />
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end">
          <Button
            onClick={beginClarifying}
            loading={busy}
            disabled={!initialRequest.trim()}
          >
            Start Clarifying
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </>
    );
  }

  if (!confident) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <p className="text-sm text-white">{question}</p>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <div className="mt-4 flex gap-2">
          <Button
            variant="secondary"
            onClick={() => answer("yes")}
            loading={busy}
            icon={<CheckCircle2 className="h-4 w-4" />}
          >
            Yes
          </Button>
          <Button
            variant="secondary"
            onClick={() => answer("no")}
            loading={busy}
            icon={<XCircle className="h-4 w-4" />}
          >
            No
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="mb-2 flex items-center gap-2">
        <Badge tone="cyan" icon={<FolderGit2 className="h-3 w-3" />}>
          Confident
        </Badge>
        <span className="text-xs text-slate-400">Goals ready to build:</span>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-sm text-slate-200">
        {refinedGoals.map((g, i) => (
          <li key={i}>{g}</li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end">
        <Button
          size="lg"
          onClick={build}
          loading={starting}
          icon={<Rocket className="h-4.5 w-4.5" />}
        >
          Build This
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
