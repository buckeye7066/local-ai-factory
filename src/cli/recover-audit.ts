import { recoverAuditChain, verifyAuditChain } from "../server/storage/auditLog.js";

try {
  const recovery = await recoverAuditChain();
  const verification = await verifyAuditChain();
  console.log(JSON.stringify({ ...recovery, verification }, null, 2));
  if (!verification.ok) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
