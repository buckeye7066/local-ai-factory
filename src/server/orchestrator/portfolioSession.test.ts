import { join, resolve } from "node:path";
import { unlink } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPortfolioSession,
  getPortfolioSession,
  steerPortfolioSession,
  type PortfolioSession,
} from "./portfolioSession.js";

const created: PortfolioSession[] = [];

afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((session) =>
        unlink(
          join(
            resolve(process.cwd(), process.env.FACTORY_DATA_DIR || ".factory"),
            "sessions",
            `${session.id}.json`,
          ),
        ).catch(() => {}),
      ),
  );
});

describe("portfolio sessions", () => {
  it("queues only repositories that received a routed requirement", async () => {
    const session = await createPortfolioSession("Alpha: repair billing.", [
      { name: "Alpha", repoSource: { type: "path", location: "/tmp/alpha" } },
      { name: "Beta", repoSource: { type: "path", location: "/tmp/beta" } },
    ]);
    created.push(session);

    expect(session.targets.map((target) => target.name)).toEqual(["Alpha"]);
  });

  it("rejects oversized steering before changing any queued target", async () => {
    const session = await createPortfolioSession("Both programs: keep login.", [
      { name: "Alpha", repoSource: { type: "path", location: "/tmp/alpha" } },
      { name: "Beta", repoSource: { type: "path", location: "/tmp/beta" } },
    ]);
    created.push(session);
    const before = session.targets.map((target) => target.prompt);

    const receipt = await steerPortfolioSession(session.id, "x".repeat(4_001));

    expect(receipt.ok).toBe(false);
    const stored = await getPortfolioSession(session.id);
    expect(stored?.targets.map((target) => target.prompt)).toEqual(before);
  });
});
