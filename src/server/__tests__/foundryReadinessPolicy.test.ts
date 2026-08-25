import { describe, expect, it } from "vitest";
import {
  evaluateFoundryCompletion,
  normalizeFoundryStations,
  REQUIRED_PRODUCTION_STATIONS,
} from "../foundry/readinessPolicy.js";
import type { ProductionReadinessReceipt } from "../orchestrator/productionReadinessPolicy.js";

const receipt: ProductionReadinessReceipt = {
  schema: "factory.production-readiness.v1",
  mandatory: true,
  ready: true,
  appName: "Foundry App",
  evidenceDigest: "sha256:exact",
  brainFloor: {
    sol: true,
    fableOrOpus: true,
    independentFamilies: true,
    sameEvidence: true,
  },
  blockers: [],
  ownerExternalMatters: "owner-managed-outside-cyberland",
};

const stationEvidence = REQUIRED_PRODUCTION_STATIONS.map((stationId) => ({
  stationId,
  status: "completed" as const,
  evidenceDigest: "sha256:exact",
  revision: "abc123",
}));

describe("Purpose Foundry mandatory production path", () => {
  it("cannot omit Factory Deck, FlexFactor, Crucible, or Watchtower", () => {
    expect(normalizeFoundryStations(["promo-pilot"], "free")).toEqual([
      "factory-deck",
      "flexfactor",
      "crucible",
      "watchtower",
      "promo-pilot",
    ]);
  });

  it("keeps Paid mode inside the metered internal station line", () => {
    const selected = normalizeFoundryStations(
      ["factory-deck", "scout", "flexfactor"],
      "paid",
    );
    expect(selected).not.toContain("scout");
    expect(selected).not.toContain("flexfactor");
    expect(selected).toEqual(
      expect.arrayContaining(["factory-deck", "crucible", "watchtower"]),
    );
  });

  it("does not confuse all station badges with a production-ready project", () => {
    const decision = evaluateFoundryCompletion({
      factoryReceipt: null,
      stations: stationEvidence,
    });
    expect(decision.completed).toBe(false);
    expect(decision.blockers.join(" ")).toMatch(
      /no ready production-readiness receipt/i,
    );
  });

  it("requires every mandatory station to agree with the receipt digest", () => {
    const stations = stationEvidence.map((station) =>
      station.stationId === "crucible"
        ? { ...station, evidenceDigest: "sha256:stale" }
        : station,
    );
    const decision = evaluateFoundryCompletion({
      factoryReceipt: receipt,
      stations,
    });
    expect(decision.completed).toBe(false);
    expect(decision.blockers.join(" ")).toMatch(/crucible evidence does not match/i);
  });

  it("requires one exact delivered revision across the mandatory stations", () => {
    const stations = stationEvidence.map((station) =>
      station.stationId === "watchtower"
        ? { ...station, revision: "different" }
        : station,
    );
    const decision = evaluateFoundryCompletion({
      factoryReceipt: receipt,
      stations,
    });
    expect(decision.completed).toBe(false);
    expect(decision.blockers.join(" ")).toMatch(/one exact delivered revision/i);
  });

  it("completes only when receipt, digest, revision, and station outcomes converge", () => {
    const decision = evaluateFoundryCompletion({
      factoryReceipt: receipt,
      stations: stationEvidence,
    });
    expect(decision).toEqual({
      completed: true,
      status: "completed",
      blockers: [],
    });
  });
});
