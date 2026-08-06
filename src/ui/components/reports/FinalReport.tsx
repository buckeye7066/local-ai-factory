import { useMemo } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Cpu,
  FlaskConical,
  FolderOpen,
  ListChecks,
  PlusCircle,
  Sparkles,
  Terminal,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { useClipboard } from "../../lib/useClipboard.js";
import {
  fadeIn,
  scaleIn,
  staggerContainer,
  staggerItem,
  usePrefersReducedMotion,
} from "../../lib/motion.js";
import { Button } from "../ui/Button.js";
import { Badge } from "../ui/Badge.js";
import { Card, CardHeader } from "../ui/Card.js";
import { Tooltip } from "../ui/Tooltip.js";
import type { FinalReport as FinalReportType } from "../../../shared/schemas.js";
import { CompletionCelebration } from "./CompletionCelebration.js";

/* ------------------------------------------------------------------ */
/* Status presentation                                                 */
/* ------------------------------------------------------------------ */

type TestStatus = FinalReportType["testStatus"];
type BadgeTone = "emerald" | "rose" | "amber" | "neutral";

interface StatusMeta {
  label: string;
  tone: BadgeTone;
  icon: ReactNode;
}

/** Map a test status to its pill presentation. */
function statusMeta(status: TestStatus): StatusMeta {
  switch (status) {
    case "passing":
      return {
        label: "Tests passing",
        tone: "emerald",
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
      };
    case "failing":
      return {
        label: "Tests failing",
        tone: "rose",
        icon: <XCircle className="h-3.5 w-3.5" />,
      };
    case "skipped":
      return {
        label: "Tests skipped",
        tone: "amber",
        icon: <FlaskConical className="h-3.5 w-3.5" />,
      };
    default:
      return {
        label: "Tests unknown",
        tone: "neutral",
        icon: <FlaskConical className="h-3.5 w-3.5" />,
      };
  }
}

/* ------------------------------------------------------------------ */
/* Small presentational helpers                                        */
/* ------------------------------------------------------------------ */

/** A bulleted list that degrades gracefully to an empty-state line. */
function BulletList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) {
    return <p className="text-sm text-slate-500">{empty}</p>;
  }
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-sm text-slate-300">
          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-aurora-cyan/70" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** A monospace block with an attached copy button + "Copied!" feedback. */
function CodeBlock({ value, label }: { value: string; label: string }) {
  const { copied, copy } = useClipboard();
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-xl border border-white/10 bg-black/30 p-3 pr-12 font-mono text-xs leading-relaxed text-aurora-cyan/90">
        {value}
      </pre>
      <Tooltip content={copied ? "Copied!" : `Copy ${label}`}>
        <button
          type="button"
          onClick={() => void copy(value)}
          aria-label={`Copy ${label}`}
          className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-lg border border-white/10 bg-white/5 text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
        >
          {copied ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-aurora-emerald" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </Tooltip>
    </div>
  );
}

/** One stat row inside the provider-usage card. */
function UsageRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
      <span className="text-sm text-slate-300">{label}</span>
      <span className="font-mono text-sm font-semibold text-white">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Plaintext summary builder                                           */
/* ------------------------------------------------------------------ */

/** Build a clean, copy-pasteable plaintext run summary. */
function buildSummaryText(report: FinalReportType): string {
  const { label } = statusMeta(report.testStatus);
  const caveats =
    report.caveats.length > 0
      ? report.caveats.map((c) => `  - ${c}`).join("\n")
      : "  - None noted";
  return [
    `# ${report.appName}`,
    "",
    report.summary,
    "",
    "## How to run",
    report.howToRun,
    "",
    `## Workspace`,
    report.workspacePath,
    "",
    `## Test status`,
    `${label} (${report.repairLoops} repair loop${report.repairLoops === 1 ? "" : "s"})`,
    "",
    "## Caveats",
    caveats,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

export function FinalReport({
  report,
  onNewRun,
}: {
  report: FinalReportType;
  onNewRun: () => void;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { copied, copy } = useClipboard();

  const meta = useMemo(() => statusMeta(report.testStatus), [report.testStatus]);
  const isPassing = report.testStatus === "passing";

  const usage = report.providerUsage;
  // Demo runs powered entirely by the stub provider made zero real API calls.
  const isDemo = usage.totalCalls === 0 && usage.stub.calls > 0;

  const summaryText = useMemo(() => buildSummaryText(report), [report]);

  // When motion is reduced, render statically (no enter animation) but keep
  // the same markup so layout is identical.
  const motionProps = prefersReducedMotion
    ? {}
    : {
        variants: staggerContainer,
        initial: "hidden" as const,
        animate: "show" as const,
      };

  const sectionProps = prefersReducedMotion ? {} : { variants: staggerItem };

  return (
    <div className="relative mx-auto w-full max-w-5xl px-4 py-8">
      {/* One-shot celebration when the build passed its tests. */}
      {isPassing && <CompletionCelebration show />}

      {/* ----- Hero header ----- */}
      <motion.header
        variants={prefersReducedMotion ? undefined : fadeIn}
        initial={prefersReducedMotion ? undefined : "hidden"}
        animate={prefersReducedMotion ? undefined : "show"}
        className="relative mb-8 text-center"
      >
        {/* Success glow ring — scales in only when passing. */}
        {isPassing && (
          <motion.div
            variants={prefersReducedMotion ? undefined : scaleIn}
            initial={prefersReducedMotion ? undefined : "hidden"}
            animate={prefersReducedMotion ? undefined : "show"}
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-1/2 -z-10 h-48 w-48 -translate-x-1/2 -translate-y-1/2 rounded-full bg-aurora-emerald/20 blur-3xl"
          />
        )}

        <h1 className="text-aurora text-4xl font-bold tracking-tight sm:text-5xl">
          {report.appName}
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm text-slate-300 sm:text-base">
          {report.summary}
        </p>

        <div className="mt-4 flex justify-center">
          <Badge tone={meta.tone} icon={meta.icon} className="px-3 py-1 text-xs">
            {meta.label}
          </Badge>
        </div>
      </motion.header>

      {/* ----- Section grid ----- */}
      <motion.div {...motionProps} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* What was built */}
        <motion.div {...sectionProps}>
          <Card className="h-full">
            <CardHeader
              title="What was built"
              icon={<ListChecks className="h-4 w-4" />}
            />
            <BulletList items={report.whatWasBuilt} empty="Nothing recorded." />
          </Card>
        </motion.div>

        {/* How to run */}
        <motion.div {...sectionProps}>
          <Card className="h-full">
            <CardHeader title="How to run" icon={<Terminal className="h-4 w-4" />} />
            <CodeBlock value={report.howToRun} label="run command" />
          </Card>
        </motion.div>

        {/* Test status */}
        <motion.div {...sectionProps}>
          <Card className="h-full">
            <CardHeader
              title="Test status"
              icon={<FlaskConical className="h-4 w-4" />}
            />
            <div className="flex items-center gap-3">
              <Badge tone={meta.tone} icon={meta.icon}>
                {meta.label}
              </Badge>
              <span className="text-sm text-slate-400">
                {report.repairLoops} repair loop{report.repairLoops === 1 ? "" : "s"}
              </span>
            </div>
          </Card>
        </motion.div>

        {/* Known caveats */}
        <motion.div {...sectionProps}>
          <Card className="h-full">
            <CardHeader
              title="Known caveats"
              icon={<AlertTriangle className="h-4 w-4 text-amber-300" />}
            />
            <BulletList items={report.caveats} empty="None noted." />
          </Card>
        </motion.div>

        {/* Next improvements */}
        <motion.div {...sectionProps}>
          <Card className="h-full">
            <CardHeader
              title="Next improvements"
              icon={<Sparkles className="h-4 w-4" />}
            />
            <BulletList items={report.nextImprovements} empty="None suggested." />
          </Card>
        </motion.div>

        {/* Workspace */}
        <motion.div {...sectionProps}>
          <Card className="h-full">
            <CardHeader title="Workspace" icon={<FolderOpen className="h-4 w-4" />} />
            <CodeBlock value={report.workspacePath} label="workspace path" />
            <p className="mt-2 text-xs text-slate-500">
              Open this folder in your editor to explore the generated app.
            </p>
          </Card>
        </motion.div>

        {/* Provider usage (counts only — never prompts or secrets). */}
        <motion.div {...sectionProps} className="md:col-span-2">
          <Card className="h-full">
            <CardHeader
              title="Provider usage"
              icon={<Cpu className="h-4 w-4" />}
              action={
                isDemo ? (
                  <Badge tone="neutral">Demo (stub) — no API calls</Badge>
                ) : (
                  <Badge tone="cyan">{usage.totalCalls} total calls</Badge>
                )
              }
            />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <UsageRow label="Claude / Anthropic" value={usage.anthropic.calls} />
              <UsageRow label="OpenAI" value={usage.openai.calls} />
              <UsageRow label="Stub" value={usage.stub.calls} />
            </div>
          </Card>
        </motion.div>
      </motion.div>

      {/* ----- Action bar ----- */}
      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Button
          variant="primary"
          icon={
            copied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />
          }
          onClick={() => void copy(summaryText)}
        >
          {copied ? "Copied!" : "Copy run instructions"}
        </Button>
        <Button
          variant="ghost"
          icon={<PlusCircle className="h-4 w-4" />}
          onClick={onNewRun}
        >
          Start new run
        </Button>
      </div>
    </div>
  );
}
