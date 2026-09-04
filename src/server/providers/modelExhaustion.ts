const QUOTA_SIGNS = [
  /no credits remaining/i,
  /insufficient_quota/i,
  /credit balance is too low/i,
  /exceeded your current quota/i,
  /billing.*(hard limit|not active)/i,
  /quota exceeded/i,
];

const MODEL_EXHAUSTION_SIGNS = [
  ...QUOTA_SIGNS,
  /rate.?limit/i,
  /too many requests/i,
  /overloaded/i,
  /capacity/i,
  /temporarily unavailable/i,
  /model (?:is )?(?:unavailable|disabled|exhausted)/i,
  /model_not_found/i,
  /model not found/i,
  /does not exist or you do not have access/i,
  /not supported.*model/i,
  /not available.*(?:zero data retention|zdr)/i,
  /30-day data retention/i,
];

export function modelFailureText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error ?? "");
  } catch {
    return String(error);
  }
}

export function isQuotaRefusal(error: unknown): boolean {
  const text = modelFailureText(error);
  return QUOTA_SIGNS.some((pattern) => pattern.test(text));
}

/**
 * True only for a route-scoped exhaustion condition where another model can
 * reasonably serve the same request. Authentication failures, malformed
 * requests, cancellation, and arbitrary provider bugs remain loud.
 */
export function isModelExhaustion(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name;
  if (name === "ProviderAbortError") return false;
  if (name === "PaidBudgetExhaustedError") return true;
  if (name === "ProviderModelUnavailableError") return true;
  const status = (error as { status?: unknown })?.status;
  if (status === 402 || status === 429 || status === 529) return true;
  const text = modelFailureText(error);
  return MODEL_EXHAUSTION_SIGNS.some((pattern) => pattern.test(text));
}
