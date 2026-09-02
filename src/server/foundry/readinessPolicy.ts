import type { RoutingMode } from "../../shared/schemas.js";
import type { ProductionReadinessReceipt } from "../orchestrator/productionReadinessPolicy.js";
import type { StationId } from "./model.js";

export const REQUIRED_PRODUCTION_STATIONS = Object.freeze([
  "factory-deck",
  "crucible",
  "watchtower",
] as const satisfies readonly StationId[]);

export type RequiredProductionStation = (typeof REQUIRED_PRODUCTION_STATIONS)[number];

/**
 * One internal evidence line applies to every project, including records that
 * still carry a legacy free/paid value: Factory Deck, Crucible, and Watchtower.
 * FlexFactor remains an optional specialist because its child orchestrator owns
 * its own single model ladder and call ledger.
 */
export function requiredProductionStations(
  _routingMode?: RoutingMode,
): RequiredProductionStation[] {
  return [...REQUIRED_PRODUCTION_STATIONS];
}

export function normalizeFoundryStations(
  selected: StationId[],
  routingMode?: RoutingMode,
): StationId[] {
  const out: StationId[] = [];
  const seen = new Set<StationId>();
  for (const station of [...requiredProductionStations(routingMode), ...selected]) {
    if (!seen.has(station)) {
      seen.add(station);
      out.push(station);
    }
  }
  return out;
}

export type FoundryStationReadinessEvidence = {
  stationId: RequiredProductionStation;
  status: "queued" | "active" | "needs_attention" | "completed" | "failed";
  evidenceDigest: string | null;
  revision: string | null;
};

export type FoundryCompletionDecision = {
  completed: boolean;
  status: "running" | "needs_attention" | "completed" | "failed";
  blockers: string[];
};

/**
 * Station completion is evidence, not the product verdict. The project is
 * complete only when Factory Deck has a ready receipt and the later verifier,
 * adversary, and operations stations agree on the same digest and revision.
 */
export function evaluateFoundryCompletion(input: {
  factoryReceipt: ProductionReadinessReceipt | null;
  stations: FoundryStationReadinessEvidence[];
  routingMode?: RoutingMode;
}): FoundryCompletionDecision {
  const blockers: string[] = [];
  const receipt = input.factoryReceipt;
  if (!receipt?.ready) {
    blockers.push("Factory Deck has no ready production-readiness receipt.");
  }
  const required = new Map(
    input.stations.map((evidence) => [evidence.stationId, evidence]),
  );
  const requiredStations = requiredProductionStations(input.routingMode);
  for (const stationId of requiredStations) {
    const evidence = required.get(stationId);
    if (!evidence) {
      blockers.push(`${stationId} has no completion evidence.`);
      continue;
    }
    if (evidence.status === "failed") {
      blockers.push(`${stationId} failed.`);
      continue;
    }
    if (evidence.status === "needs_attention") {
      blockers.push(`${stationId} needs attention.`);
      continue;
    }
    if (evidence.status !== "completed") {
      blockers.push(`${stationId} has not completed.`);
    }
    if (receipt && evidence.evidenceDigest !== receipt.evidenceDigest) {
      blockers.push(`${stationId} evidence does not match the Factory Deck digest.`);
    }
  }

  const revisions = new Set(
    input.stations
      .filter((station) => requiredStations.includes(station.stationId))
      .map((station) => station.revision)
      .filter((revision): revision is string => Boolean(revision)),
  );
  if (revisions.size !== 1) {
    blockers.push(
      "Required production stations do not agree on one exact delivered revision.",
    );
  }

  const failed = input.stations.some((station) => station.status === "failed");
  return {
    completed: blockers.length === 0,
    status: blockers.length === 0 ? "completed" : failed ? "failed" : "needs_attention",
    blockers,
  };
}
