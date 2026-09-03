import { join, resolve } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPortfolioSession,
  getPortfolioSession,
  steerPortfolioSession,
  type PortfolioSession,
} from "./portfolioSession.js";

const created: PortfolioSession[] = [];

function persistedSessionPath(id: string): string {
  return join(
    resolve(process.cwd(), process.env.FACTORY_DATA_DIR || ".factory"),
    "sessions",
    `${id}.json`,
  );
}

afterEach(async () => {
  await Promise.all(
    created
      .splice(0)
      .map((session) => unlink(persistedSessionPath(session.id)).catch(() => {})),
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

  it("persists and serves only redacted portfolio inputs", async () => {
    const rawToken = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const rawUrl = "https://owner:supersecret@example.com/acme/private.git";
    const session = await createPortfolioSession(
      `Alpha: set OPENAI_API_KEY=${rawToken} and preserve authentication.`,
      [{ name: "Alpha", repoSource: { type: "git", location: rawUrl } }],
    );
    created.push(session);

    expect(session.prompt).not.toContain(rawToken);
    expect(session.targets[0]?.prompt).not.toContain(rawToken);
    expect(session.targets[0]?.repoSource.location).not.toContain("supersecret");

    const persisted = await readFile(persistedSessionPath(session.id), "utf8");
    expect(persisted).not.toContain(rawToken);
    expect(persisted).not.toContain("supersecret");
    expect(persisted).toContain("[REDACTED]");

    const served = JSON.stringify(await getPortfolioSession(session.id));
    expect(served).not.toContain(rawToken);
    expect(served).not.toContain("supersecret");
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
