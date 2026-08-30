import { beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CreditGuardCircuitOpenError,
  CreditGuardRejectedOutputError,
  creditGuardDisputeDirectory,
  creditGuardLedgerPath,
  creditGuardStatus,
  evaluatePaidText,
  runCreditGuardedPaidAttempt,
} from "../providers/creditGuard.js";
import { paidBudgetStatus, resetPaidBudget } from "../providers/paidBudget.js";

const DATA_DIR = ".vitest-factory-data-credit-guard";
process.env.FACTORY_DATA_DIR = DATA_DIR;
process.env.FACTORY_CREDIT_GUARD_ENABLED = "1";
process.env.FACTORY_CREDIT_GUARD_DUPLICATE_BLOCK_MS = "86400000";
process.env.FACTORY_CREDIT_GUARD_CIRCUIT_THRESHOLD = "50";
delete process.env.FACTORY_PAID_RESCUES_PER_HOUR;
delete process.env.FACTORY_PAID_RESCUES_PER_DAY;
delete process.env.FACTORY_PAID_MAX_USD_PER_DAY;

async function resetState(): Promise<void> {
  await rm(resolve(process.cwd(), DATA_DIR), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  resetPaidBudget();
}

describe("Credit Guard", () => {
  beforeEach(resetState);

  it("accepts one valid paid response, records usage, and never stores prompt or response text", async () => {
    const result = await runCreditGuardedPaidAttempt({
      provider: "openai",
      model: "gpt-test",
      operation: "generateText",
      system: "system SECRET_SYSTEM_VALUE",
      prompt: "prompt SECRET_PROMPT_VALUE",
      maxTokens: 128,
      managed: true,
      call: async () => ({
        raw: "Useful result SECRET_RESPONSE_VALUE",
        responseText: "Useful result SECRET_RESPONSE_VALUE",
        providerRequestId: "req_accepted",
        usage: { inTokens: 12, outTokens: 7 },
      }),
      evaluate: (text) => evaluatePaidText(text),
    });

    expect(result).toBe("Useful result SECRET_RESPONSE_VALUE");
    expect(creditGuardStatus().last24h.accepted).toBe(1);
    expect(paidBudgetStatus().lastDay).toBe(1);

    const ledger = await readFile(creditGuardLedgerPath(), "utf8");
    expect(ledger).toContain("req_accepted");
    expect(ledger).not.toContain("SECRET_SYSTEM_VALUE");
    expect(ledger).not.toContain("SECRET_PROMPT_VALUE");
    expect(ledger).not.toContain("SECRET_RESPONSE_VALUE");
  });

  it("disputes an error-shaped response and blocks an identical paid request before a second provider call", async () => {
    let providerCalls = 0;
    const attempt = () =>
      runCreditGuardedPaidAttempt({
        provider: "anthropic" as const,
        model: "claude-test",
        operation: "generateText" as const,
        system: "build the requested program",
        prompt: "same exact request",
        maxTokens: 256,
        managed: true,
        call: async () => {
          providerCalls += 1;
          return {
            raw: "Internal Server Error",
            responseText: "Internal Server Error",
            providerRequestId: "msg_rejected",
            usage: { inTokens: 20, outTokens: 3 },
          };
        },
        evaluate: (text: string) => evaluatePaidText(text),
      });

    await expect(attempt()).rejects.toBeInstanceOf(CreditGuardRejectedOutputError);
    await expect(attempt()).rejects.toBeInstanceOf(CreditGuardCircuitOpenError);

    expect(providerCalls).toBe(1);
    const status = creditGuardStatus();
    expect(status.last24h.disputed).toBe(1);
    expect(status.last24h.blocked).toBe(1);
    expect(status.openDisputes).toBe(1);

    const packets = await readdir(creditGuardDisputeDirectory());
    expect(packets).toHaveLength(1);
    const packet = await readFile(
      resolve(creditGuardDisputeDirectory(), packets[0]!),
      "utf8",
    );
    expect(packet).toContain("msg_rejected");
    expect(packet).toContain("Provider returned an error message");
  });

  it("marks schema-invalid JSON as disputed while returning it to the one-attempt schema reporter", async () => {
    const raw = { wrong: true };
    const result = await runCreditGuardedPaidAttempt({
      provider: "openai",
      model: "gpt-test",
      operation: "generateJson",
      system: "return json",
      prompt: "return the Result object",
      maxTokens: 128,
      managed: true,
      call: async () => ({
        raw,
        responseText: JSON.stringify(raw),
        providerRequestId: "req_schema_bad",
        usage: { inTokens: 10, outTokens: 4 },
      }),
      evaluate: (value) => ({
        ok: false,
        value,
        reason: "Result schema rejection: required field ok is missing",
      }),
      returnRejectedValue: true,
    });

    expect(result).toEqual(raw);
    expect(creditGuardStatus().last24h.disputed).toBe(1);
  });

  it("records a provider exception as an uncertain billed attempt and blocks an identical repeat", async () => {
    let providerCalls = 0;
    const attempt = () =>
      runCreditGuardedPaidAttempt({
        provider: "openai" as const,
        model: "gpt-test",
        operation: "generateText" as const,
        system: "system",
        prompt: "provider exception fingerprint",
        maxTokens: 128,
        managed: true,
        call: async () => {
          providerCalls += 1;
          throw new Error("upstream socket closed after request submission");
        },
        evaluate: (text: string) => evaluatePaidText(text),
      });

    await expect(attempt()).rejects.toThrow(/upstream socket closed/i);
    await expect(attempt()).rejects.toBeInstanceOf(CreditGuardCircuitOpenError);
    expect(providerCalls).toBe(1);
    expect(creditGuardStatus().last24h.providerErrors).toBe(1);
    expect(paidBudgetStatus().lastDay).toBe(1);
  });

  it("opens the provider circuit after repeated distinct paid failures", async () => {
    process.env.FACTORY_CREDIT_GUARD_CIRCUIT_THRESHOLD = "2";
    let providerCalls = 0;
    try {
      for (const prompt of ["first bad request", "second bad request"]) {
        await expect(
          runCreditGuardedPaidAttempt({
            provider: "anthropic",
            model: "claude-test",
            operation: "generateText",
            system: "system",
            prompt,
            maxTokens: 128,
            managed: true,
            call: async () => {
              providerCalls += 1;
              return {
                raw: "Service unavailable",
                responseText: "Service unavailable",
                usage: { inTokens: 2, outTokens: 2 },
              };
            },
            evaluate: (text) => evaluatePaidText(text),
          }),
        ).rejects.toBeInstanceOf(CreditGuardRejectedOutputError);
      }

      await expect(
        runCreditGuardedPaidAttempt({
          provider: "anthropic",
          model: "claude-test",
          operation: "generateText",
          system: "system",
          prompt: "third distinct request",
          maxTokens: 128,
          managed: true,
          call: async () => {
            providerCalls += 1;
            return {
              raw: "would spend",
              responseText: "would spend",
              usage: { inTokens: 2, outTokens: 2 },
            };
          },
          evaluate: (text) => evaluatePaidText(text),
        }),
      ).rejects.toBeInstanceOf(CreditGuardCircuitOpenError);

      expect(providerCalls).toBe(2);
      expect(creditGuardStatus().last24h.blocked).toBe(1);
    } finally {
      process.env.FACTORY_CREDIT_GUARD_CIRCUIT_THRESHOLD = "50";
    }
  });
});
