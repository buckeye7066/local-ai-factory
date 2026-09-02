import { useMemo } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Cpu,
  FileSearch,
  FlaskConical,
  FolderOpen,
  Globe2,
  ListChecks,
  PlusCircle,
  ShieldCheck,
  Sparkles,
  Target,
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
  const goal = report.goalContract
    ? [
        "",
        "## Durable goal contract",
        report.goalContract.purpose,
        `Source: ${report.goalContract.purposeSource}; digest: ${report.goalContract.digest}`,
        ...report.goalContract.activeGoals.map((item) => `  - Goal: ${item}`),
        ...report.goalContract.constraints.map((item) => `  - Constraint: ${item}`),
        ...report.goalContract.nonGoals.map((item) => `  - Non-goal: ${item}`),
        `Continuity: ${report.goalContract.continuity.previousRunIds.length} prior run(s), ${report.goalContract.continuity.carriedForwardDecisions.length} carried decision(s), ${report.goalContract.continuity.priorResearch.length} prior research item(s)`,
      ]
    : [];
  const purpose = report.purposeProfile
    ? [
        "",
        "## Purpose constitution",
        report.purposeProfile.purpose.text,
        `Evidence: ${report.purposeProfile.evidence.length} cited observation(s); ` +
          `${report.purposeProfile.grounding.evidenceCoverage * 100}% used`,
      ]
    : [];
  const competitive = report.competitiveResearch
    ? [
        "",
        "## Competitive evidence",
        `${report.competitiveResearch.coverageMet ? "Coverage complete" : "Coverage incomplete"}: ` +
          `${report.competitiveResearch.productVerifiedCount}/${report.competitiveResearch.productTarget} products verified, ` +
          `${report.competitiveResearch.productComparedCount} compared, ` +
          `${report.competitiveResearch.productSelectedCount} selected`,
        ...report.competitiveResearch.competitors.map(
          (candidate) => `  - ${candidate.name}: ${candidate.url}`,
        ),
      ]
    : [];
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
    ...goal,
    ...purpose,
    ...competitive,
    "",
    "## Caveats",
    caveats,
    "",
    "## Errors",
    (report.errors ?? []).length > 0
      ? (report.errors ?? []).map((e) => `  - ${e}`).join("\n")
      : "  - None recorded",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

export function FinalReport({
  report,
  ready,
  onNewRun,
}: {
  report: FinalReportType;
  /** Receipt/delivery-backed outcome from the owning run, not report prose. */
  ready: boolean;
  onNewRun: () => void;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { copied, copy } = useClipboard();

  const meta = useMemo(() => statusMeta(report.testStatus), [report.testStatus]);
  const isPassing = ready && report.testStatus === "passing";

  const usage = report.providerUsage;
  // Demo runs powered by mock (or legacy stub) made zero paid API calls.
  const isDemo =
    usage.anthropic.calls === 0 &&
    usage.openai.calls === 0 &&
    (usage.mock.calls > 0 || usage.stub.calls > 0);

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
      {/* Celebration requires the owning run's receipt-bound ready outcome. */}
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

        {/* Orchestrator-owned mission and continuity (every production run). */}
        {report.goalContract && (
          <motion.div {...sectionProps} className="md:col-span-2">
            <Card className="h-full">
              <CardHeader
                title="Durable goal contract"
                icon={<Target className="h-4 w-4" />}
                action={
                  <Badge tone="cyan">
                    {report.goalContract.purposeSource.replace("-", " ")}
                  </Badge>
                }
              />
              <p className="text-sm leading-relaxed text-slate-200">
                {report.goalContract.purpose}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <UsageRow
                  label="Active goals"
                  value={report.goalContract.activeGoals.length}
                />
                <UsageRow
                  label="Prior runs"
                  value={report.goalContract.continuity.previousRunIds.length}
                />
                <UsageRow
                  label="Carried decisions"
                  value={report.goalContract.continuity.carriedForwardDecisions.length}
                />
                <UsageRow
                  label="Prior research"
                  value={report.goalContract.continuity.priorResearch.length}
                />
              </div>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Current obligations
                  </p>
                  <BulletList
                    items={report.goalContract.activeGoals}
                    empty="No active goals recorded."
                  />
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Boundaries
                  </p>
                  <BulletList
                    items={[
                      ...report.goalContract.constraints.map(
                        (item) => `Constraint: ${item}`,
                      ),
                      ...report.goalContract.nonGoals.map(
                        (item) => `Non-goal: ${item}`,
                      ),
                    ]}
                    empty="No additional constraints or non-goals recorded."
                  />
                </div>
              </div>
              <div className="mt-4">
                <CodeBlock
                  value={report.goalContract.digest}
                  label="goal contract digest"
                />
              </div>
            </Card>
          </motion.div>
        )}

        {/* Citation-linked purpose evidence (extend runs). */}
        {report.purposeProfile && (
          <motion.div {...sectionProps} className="md:col-span-2">
            <Card className="h-full">
              <CardHeader
                title="Purpose constitution"
                icon={<FileSearch className="h-4 w-4" />}
                action={
                  <Badge
                    tone={
                      report.purposeProfile.grounding.grounded ? "emerald" : "amber"
                    }
                    icon={<ShieldCheck className="h-3.5 w-3.5" />}
                  >
                    {report.purposeProfile.grounding.grounded
                      ? "Citations validated"
                      : "Unsupported claims removed"}
                  </Badge>
                }
              />
              <p className="text-sm leading-relaxed text-slate-200">
                {report.purposeProfile.purpose.text}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-slate-400">
                Citation IDs and repository snapshots were validated. Claim meaning is
                model-inferred and was not independently verified for semantic
                entailment.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <UsageRow
                  label="Workflows"
                  value={report.purposeProfile.coreWorkflows.length}
                />
                <UsageRow
                  label="Invariants"
                  value={report.purposeProfile.invariants.length}
                />
                <UsageRow
                  label="Current gaps"
                  value={report.purposeProfile.currentGaps.length}
                />
                <UsageRow
                  label="Evidence"
                  value={report.purposeProfile.evidence.length}
                />
              </div>
              {report.purposeProfile.currentGaps.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Citation-linked gaps
                  </p>
                  <BulletList
                    items={report.purposeProfile.currentGaps.map((claim) => claim.text)}
                    empty="No current gap has a validated citation."
                  />
                </div>
              )}
              <details className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
                <summary className="cursor-pointer text-sm font-medium text-slate-300">
                  Inspect cited repository evidence
                </summary>
                <ul className="mt-3 space-y-2">
                  {report.purposeProfile.evidence.map((item) => (
                    <li
                      key={item.id}
                      className="rounded-lg border border-white/5 bg-black/20 p-2 text-xs text-slate-400"
                    >
                      <div>
                        <span className="font-mono text-aurora-cyan">
                          {item.id} · {item.path}:{item.lineStart}-{item.lineEnd}
                        </span>
                        <span className="ml-2">{item.signal}</span>
                        <span className="ml-2 font-mono text-slate-600">
                          {item.sourceDigest.slice(0, 15)}…
                        </span>
                      </div>
                      <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-slate-300">
                        {item.excerpt}
                      </pre>
                    </li>
                  ))}
                </ul>
              </details>
            </Card>
          </motion.div>
        )}

        {/* Durable market evidence, retained after the private checkpoint is removed. */}
        {report.competitiveResearch && (
          <motion.div {...sectionProps} className="md:col-span-2">
            <Card className="h-full">
              <CardHeader
                title="Competitive evidence"
                icon={<Globe2 className="h-4 w-4" />}
                action={
                  <Badge
                    tone={report.competitiveResearch.coverageMet ? "emerald" : "amber"}
                  >
                    {report.competitiveResearch.coverageMet
                      ? "Five-product gate passed"
                      : report.competitiveResearch.required
                        ? "Required coverage incomplete"
                        : "Advisory coverage incomplete"}
                  </Badge>
                }
              />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <UsageRow
                  label="Products verified"
                  value={report.competitiveResearch.productVerifiedCount}
                />
                <UsageRow
                  label="Products compared"
                  value={report.competitiveResearch.productComparedCount}
                />
                <UsageRow
                  label="Advantages selected"
                  value={report.competitiveResearch.productSelectedCount}
                />
                <UsageRow
                  label="Repositories verified"
                  value={report.competitiveResearch.repositoryVerifiedCount}
                />
              </div>
              {report.competitiveResearch.competitors.length > 0 && (
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {report.competitiveResearch.competitors.map((candidate) => (
                    <div
                      key={candidate.candidateId}
                      className="rounded-xl border border-white/10 bg-white/5 p-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <a
                          href={candidate.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm font-semibold text-slate-200 underline decoration-white/20 underline-offset-2 hover:text-white"
                        >
                          {candidate.name}
                        </a>
                        <Badge tone="neutral">{candidate.score}/100</Badge>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        Decision: {candidate.decision}
                      </p>
                      {candidate.strengths.length > 0 && (
                        <p className="mt-2 text-xs text-slate-300">
                          Strengths: {candidate.strengths.join("; ")}
                        </p>
                      )}
                      {candidate.gaps.length > 0 && (
                        <p className="mt-1 text-xs text-slate-400">
                          Gaps: {candidate.gaps.join("; ")}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                        {candidate.evidenceUrls.map((url, index) => (
                          <a
                            key={url}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="break-all text-[11px] text-aurora-cyan hover:underline"
                          >
                            Evidence {index + 1}
                          </a>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {report.competitiveResearch.recommendations.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Selected advantages mapped into acceptance
                  </p>
                  <BulletList
                    items={report.competitiveResearch.recommendations.map(
                      (recommendation) =>
                        `${recommendation.name} — ${recommendation.howToIntegrate}`,
                    )}
                    empty="No competitive advantage was selected."
                  />
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                {report.competitiveResearch.sources.map((source) => (
                  <Badge
                    key={source.name}
                    tone={
                      source.status === "ok"
                        ? "emerald"
                        : source.status === "failed"
                          ? "rose"
                          : "amber"
                    }
                  >
                    {source.name}: {source.status}
                  </Badge>
                ))}
              </div>
            </Card>
          </motion.div>
        )}

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

        {/* Error ledger: every error the run hit, with the code and a fix */}
        <motion.div {...sectionProps}>
          <Card className="h-full">
            <CardHeader
              title="Errors"
              icon={<AlertTriangle className="h-4 w-4 text-rose-300" />}
            />
            <BulletList items={report.errors ?? []} empty="None recorded." />
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
                  <Badge tone="neutral">Demo (mock) — no paid API calls</Badge>
                ) : (
                  <Badge tone="cyan">{usage.totalCalls} total calls</Badge>
                )
              }
            />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <UsageRow label="Claude / Anthropic" value={usage.anthropic.calls} />
              <UsageRow label="OpenAI" value={usage.openai.calls} />
              <UsageRow label="Mock" value={usage.mock.calls} />
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
