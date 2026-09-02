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
    lead: true,
    challenger: true,
    independentReviews: true,
    paidModels: true,
    sameEvidence: true,
    sol: false,
    fableOrOpus: false,
    independentFamilies: false,
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
  it("cannot omit the automatic route's internal evidence line", () => {
    expect(normalizeFoundryStations(["promo-pilot"], "auto")).toEqual([
      "factory-deck",
      "crucible",
      "watchtower",
      "promo-pilot",
    ]);
  });

  it("allows configured child orchestrators as optional automatic stations", () => {
    expect(normalizeFoundryStations(["scout", "flexfactor"], "auto")).toEqual([
      "factory-deck",
      "crucible",
      "watchtower",
      "scout",
      "flexfactor",
    ]);
  });

  it.each(["free", "paid"] as const)(
    "normalizes legacy %s records to the same station policy",
    (legacyMode) => {
      expect(normalizeFoundryStations([], legacyMode)).toEqual([
        "factory-deck",
        "crucible",
        "watchtower",
      ]);
      expect(normalizeFoundryStations(["flexfactor"], legacyMode)).toEqual([
        "factory-deck",
        "crucible",
        "watchtower",
        "flexfactor",
      ]);
    },
  );

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
