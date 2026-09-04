import { appendFile } from "node:fs/promises";
import { acquireProcessFileLock } from "../../storage/processFileLock.js";

const [, , lockPath, tracePath, holdText] = process.argv;
if (!lockPath || !tracePath || !holdText) {
  throw new Error("process-lock worker requires lock, trace, and hold arguments");
}
const holdMs = Number(holdText);
if (!Number.isFinite(holdMs) || holdMs < 1) {
  throw new Error("process-lock worker hold must be a positive number");
}

const lease = await acquireProcessFileLock(lockPath, {
  timeoutMs: 15_000,
  pollMs: 2,
  staleGraceMs: 2_000,
});
if (!lease) throw new Error("worker could not acquire process lock");
try {
  await appendFile(tracePath, `start ${lease.token}\n`, "utf8");
  await new Promise((resolveWait) => setTimeout(resolveWait, holdMs));
  await appendFile(tracePath, `end ${lease.token}\n`, "utf8");
} finally {
  await lease.release();
}
