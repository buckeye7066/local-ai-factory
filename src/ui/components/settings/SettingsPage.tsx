import { motion } from "framer-motion";
import {
  KeyRound,
  Cpu,
  Workflow,
  ShieldCheck,
  FolderOpen,
  Lock,
  CheckCircle2,
  AlertTriangle,
  Copy,
  Check,
} from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Card, CardHeader } from "../ui/Card.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { useClipboard } from "../../lib/useClipboard.js";
import { staggerContainer, staggerItem } from "../../lib/motion.js";
import type { Health } from "../../../shared/schemas.js";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Provider key as it appears in health → human-friendly label. */
type ProviderName = Health["defaultCodeProvider"];

const PROVIDER_LABEL: Record<ProviderName, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  stub: "Stub",
};

/** Placeholder shown when the backend is unreachable (health is null). */
const DASH = "—";

/** Visual-only masked value — literally just dots, NEVER a real key. */
const MASKED = "••••••••••••";

/* ------------------------------------------------------------------ */
/* Small presentational pieces                                         */
/* ------------------------------------------------------------------ */

/** A single API-key row: name + Configured/Missing status (no key, ever). */
function ApiKeyRow({
  name,
  configured,
}: {
  name: string;
  /** null = backend unreachable, so we can't know the real status. */
  configured: boolean | null;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate font-mono text-xs text-slate-200">{name}</p>
        {/* Masked dots appear ONLY as a "this is set" affordance — not a secret. */}
        {configured ? (
          <p className="mt-0.5 select-none font-mono text-[11px] tracking-widest text-slate-500">
            {MASKED}
          </p>
        ) : (
          <p className="mt-0.5 font-mono text-[11px] text-slate-500">{DASH}</p>
        )}
      </div>
      {configured === null ? (
        <Badge tone="neutral">{DASH}</Badge>
      ) : configured ? (
        <Badge tone="emerald" icon={<CheckCircle2 className="h-3 w-3" />}>
          Configured
        </Badge>
      ) : (
        <Badge tone="amber" icon={<AlertTriangle className="h-3 w-3" />}>
          Missing
        </Badge>
      )}
    </div>
  );
}

/** A labeled provider chip (e.g. "Planning / Code → Claude"). */
function ProviderChip({
  label,
  provider,
}: {
  label: string;
  provider: ProviderName | null;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
      <span className="text-xs text-slate-400">{label}</span>
      <span className="rounded-lg bg-aurora-violet/10 px-2.5 py-1 text-xs font-medium text-aurora-violet">
        {provider ? PROVIDER_LABEL[provider] : DASH}
      </span>
    </div>
  );
}

/** A label → monospace value pair (used for models, limits, etc.). */
function ValueRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
      <span className="text-xs text-slate-400">{label}</span>
      <span className="font-mono text-xs text-slate-200">{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

/**
 * SettingsPage — read-only view of the local backend configuration.
 *
 * Security model: this screen NEVER shows or accepts API keys. It only
 * reflects "Configured / Missing" booleans surfaced by the backend's health
 * payload. Keys are edited by hand in the project's `.env` file; the browser
 * has no way to read or persist them.
 */
export function SettingsPage({ health }: { health: Health | null }) {
  const { copied, copy } = useClipboard();

  // When the backend is unreachable we still render the full layout, just with
  // placeholder dashes and a single amber notice up top.
  const offline = health === null;

  return (
    <motion.div
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="mx-auto w-full max-w-5xl"
    >
      {/* Heading ------------------------------------------------------- */}
      <motion.div variants={staggerItem} className="mb-6">
        <h1 className="text-2xl font-semibold text-white">Settings</h1>
        <p className="mt-1 text-sm text-slate-400">
          Local configuration — secrets stay in your{" "}
          <code className="font-mono text-slate-300">.env</code>, never in the browser.
        </p>
        {offline && (
          <p className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            Backend not reachable — showing placeholders.
          </p>
        )}
      </motion.div>

      {/* Responsive grid: 1 col on mobile, 2 cols on large screens. ---- */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* API Keys --------------------------------------------------- */}
        <motion.div variants={staggerItem}>
          <Card>
            <CardHeader
              title="API Keys"
              subtitle="Status only — keys are never sent to the browser."
              icon={<KeyRound className="h-5 w-5" />}
            />
            <div className="space-y-2.5">
              <ApiKeyRow
                name="ANTHROPIC_API_KEY"
                configured={health ? health.anthropicConfigured : null}
              />
              <ApiKeyRow
                name="OPENAI_API_KEY"
                configured={health ? health.openaiConfigured : null}
              />
            </div>
            <p className="mt-3 text-xs text-slate-500">
              To add or change keys, edit the{" "}
              <code className="font-mono text-slate-400">.env</code> file in the project
              root, then restart the server.
            </p>
          </Card>
        </motion.div>

        {/* Models ----------------------------------------------------- */}
        <motion.div variants={staggerItem}>
          <Card>
            <CardHeader
              title="Models"
              subtitle="Which model each provider uses."
              icon={<Cpu className="h-5 w-5" />}
            />
            <div className="space-y-2.5">
              <ValueRow
                label="Anthropic"
                value={health ? health.anthropicModel : DASH}
              />
              <ValueRow label="OpenAI" value={health ? health.openaiModel : DASH} />
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Change these in <code className="font-mono text-slate-400">.env</code> (
              <code className="font-mono text-slate-400">ANTHROPIC_MODEL</code> /{" "}
              <code className="font-mono text-slate-400">OPENAI_MODEL</code>).
            </p>
          </Card>
        </motion.div>

        {/* Provider Routing ------------------------------------------- */}
        <motion.div variants={staggerItem}>
          <Card>
            <CardHeader
              title="Provider Routing"
              subtitle="Which provider handles each phase of a run."
              icon={<Workflow className="h-5 w-5" />}
            />
            <div className="space-y-2.5">
              <ProviderChip
                label="Planning / Code"
                provider={health ? health.defaultCodeProvider : null}
              />
              <ProviderChip
                label="Review / Testing"
                provider={health ? health.defaultReviewProvider : null}
              />
            </div>
          </Card>
        </motion.div>

        {/* Safety Limits ---------------------------------------------- */}
        <motion.div variants={staggerItem}>
          <Card>
            <CardHeader
              title="Safety Limits"
              subtitle="Guardrails applied to every run."
              icon={<ShieldCheck className="h-5 w-5" />}
            />
            <div className="space-y-2.5">
              <ValueRow
                label="Max repair loops"
                value={health ? String(health.maxRepairLoops) : DASH}
              />
              <ValueRow
                label="Max model calls / run"
                value={health ? String(health.maxModelCallsPerRun) : DASH}
              />

              {/* DRY-RUN row — the single most safety-critical signal. */}
              <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
                <span className="text-xs text-slate-400">Command execution</span>
                {!health ? (
                  <Badge tone="neutral">{DASH}</Badge>
                ) : health.dryRunCommands ? (
                  <Badge
                    tone="emerald"
                    icon={<ShieldCheck className="h-3 w-3" />}
                    className="text-right"
                  >
                    DRY RUN — commands are previewed, not executed (safe default)
                  </Badge>
                ) : (
                  <Badge
                    tone="rose"
                    icon={<AlertTriangle className="h-3 w-3" />}
                    className="text-right"
                  >
                    LIVE — allowlisted commands will execute in workspaces
                  </Badge>
                )}
              </div>
            </div>
          </Card>
        </motion.div>

        {/* Workspace -------------------------------------------------- */}
        <motion.div variants={staggerItem}>
          <Card>
            <CardHeader
              title="Workspace"
              subtitle="Where generated apps are written."
              icon={<FolderOpen className="h-5 w-5" />}
            />
            <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5">
              <span className="min-w-0 truncate font-mono text-xs text-slate-200">
                {health ? health.workspaceRoot : DASH}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={!health}
                icon={
                  copied ? (
                    <Check className="h-3.5 w-3.5 text-aurora-emerald" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )
                }
                onClick={() => {
                  if (health) void copy(health.workspaceRoot);
                }}
              >
                {copied ? "Copied!" : "Copy"}
              </Button>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Generated apps are written only inside this folder.
            </p>
          </Card>
        </motion.div>

        {/* Security reminders ----------------------------------------- */}
        <motion.div variants={staggerItem}>
          <Card>
            <CardHeader
              title="Security reminders"
              subtitle="How this app keeps your machine safe."
              icon={<Lock className="h-5 w-5" />}
            />
            <ul className="space-y-2 text-xs text-slate-400">
              {[
                "API keys live only on the local backend and are never sent to the browser.",
                "Model calls happen server-side only.",
                "Generated files are written only inside the workspace folder.",
                "Shell commands are limited to an allowlist (install/build/test/typecheck) and respect DRY_RUN_COMMANDS.",
                ".env is git-ignored; never commit it.",
              ].map((line) => (
                <li key={line} className="flex items-start gap-2">
                  <span
                    className={cn(
                      "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-aurora-emerald",
                    )}
                  />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </Card>
        </motion.div>
      </div>
    </motion.div>
  );
}
