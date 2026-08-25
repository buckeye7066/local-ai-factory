import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

/**
 * ErrorBoundary — one component's crash must never blank the whole deck.
 *
 * Measured: `GET /api/runs/:id/files` served FileSummary records (no
 * `contents`) while declaring FileContent[], so the Files tab evaluated
 * `match.contents.length` on undefined and threw during render. With no
 * boundary anywhere in the tree, React unmounted the ENTIRE app and the owner
 * got a white page with no error, no navigation, and no way back except a
 * manual reload — mid-run, with the run still executing on the server.
 *
 * That data bug is fixed, but the blast radius is the real defect: any future
 * render-time throw in any panel would do the same thing. A boundary around
 * each view keeps the crash local — the shell, the sidebar and the other tabs
 * stay usable, and the owner is shown what broke instead of nothing.
 *
 * Developer diagnostics are preserved in full (console + the expandable stack)
 * while the user-facing surface stays calm and actionable, per the usability
 * mandate.
 */

interface Props {
  children: ReactNode;
  /** Shown in the fallback so the owner knows WHICH part failed. */
  label?: string;
  /** Remount key: when this changes, a crashed boundary resets itself. */
  resetKey?: string;
}

interface State {
  error: Error | null;
  /** The resetKey the current error belongs to. */
  erroredFor: string | undefined;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, erroredFor: undefined };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // Navigating away from a broken view clears the error automatically, so a
    // crash in one tab does not strand the owner there.
    if (
      state.error &&
      state.erroredFor !== undefined &&
      state.erroredFor !== props.resetKey
    ) {
      return { error: null, erroredFor: undefined };
    }
    if (state.error && state.erroredFor === undefined) {
      return { erroredFor: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // FULL developer diagnostics — never swallowed.
    console.error(
      `[factory-deck] render error in ${this.props.label ?? "a panel"}:`,
      error,
      info.componentStack,
    );
  }

  private reset = () => {
    this.setState({ error: null, erroredFor: undefined });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const where = this.props.label ? ` in ${this.props.label}` : "";
    return (
      <div
        role="alert"
        className="glass-soft mx-auto mt-8 max-w-2xl overflow-hidden p-6 text-left"
      >
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-500/15 text-amber-400">
            <AlertTriangle className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white">
              Something went wrong{where}.
            </p>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              The rest of Factory Deck is still working — your run is unaffected and
              keeps going on the server. Switch to another tab, or try this panel again.
            </p>
            <button
              type="button"
              onClick={this.reset}
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-white/[0.08]"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Try again
            </button>
            <details className="mt-4 text-xs text-slate-500">
              <summary className="cursor-pointer select-none hover:text-slate-300">
                Technical details
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-3 text-[11px] leading-relaxed text-slate-400">
                {error.message}
                {error.stack ? `\n\n${error.stack}` : ""}
              </pre>
            </details>
          </div>
        </div>
      </div>
    );
  }
}
