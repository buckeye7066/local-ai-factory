import { motion } from "framer-motion";
import { History } from "lucide-react";
import { Badge } from "../ui/Badge.js";
import { Card } from "../ui/Card.js";
import { EmptyState } from "../ui/EmptyState.js";
import { Skeleton } from "../ui/Skeleton.js";
import { staggerContainer } from "../../lib/motion.js";
import type { RunSummary } from "../../../shared/schemas.js";
import { RunCard } from "./RunCard.js";

/** A single shimmering placeholder shaped like a RunCard. */
function RunCardSkeleton() {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-2/3" />
      <div className="flex items-center gap-2 pt-1">
        <Skeleton className="h-5 w-28 rounded-full" />
        <Skeleton className="ml-auto h-3 w-14" />
      </div>
    </Card>
  );
}

/**
 * RunHistory — the history list screen.
 *
 * Renders a header with a live count, loading skeletons, an empty state, or a
 * responsive staggered grid of `RunCard`s.
 */
export function RunHistory({
  runs,
  onOpen,
  onContinue,
  loading,
}: {
  runs: RunSummary[];
  onOpen: (id: string) => void;
  /** Resume a stopped-but-resumable run straight from its card. */
  onContinue?: (id: string) => Promise<void> | void;
  loading?: boolean;
}) {
  return (
    <section className="space-y-5">
      {/* Header: title + a count badge. */}
      <header className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-white">Run History</h2>
        {!loading && <Badge tone="cyan">{runs.length}</Badge>}
      </header>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <RunCardSkeleton key={i} />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          icon={<History className="h-6 w-6" />}
          title="No runs yet"
          description="Kick off your first build to see it appear here. Every run you start gets tracked with its providers, status, and workspace."
        />
      ) : (
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate="show"
          className="grid grid-cols-1 gap-4 lg:grid-cols-2"
        >
          {runs.map((run) => (
            <RunCard key={run.id} run={run} onOpen={onOpen} onContinue={onContinue} />
          ))}
        </motion.div>
      )}
    </section>
  );
}
