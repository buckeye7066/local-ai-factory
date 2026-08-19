import { redactSecrets } from "./security/redact.js";

type ErrorLike = {
  message?: unknown;
  code?: unknown;
  errno?: unknown;
  status?: unknown;
};

function rawErrorMessage(err: unknown, fallback = "Unknown error."): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  const message = (err as ErrorLike | null | undefined)?.message;
  if (typeof message === "string" && message.trim()) return message;
  return fallback;
}

function errorCode(err: unknown): string {
  const value =
    (err as ErrorLike | null | undefined)?.code ??
    (err as ErrorLike | null | undefined)?.errno;
  return typeof value === "string" ? value.toUpperCase() : "";
}

function errorStatus(err: unknown): number | null {
  const value = (err as ErrorLike | null | undefined)?.status;
  return typeof value === "number" ? value : null;
}

function detail(err: unknown): string {
  return redactSecrets(rawErrorMessage(err)).slice(0, 240);
}

function withDetail(message: string, err: unknown): string {
  const safeDetail = detail(err);
  return safeDetail ? `${message} Detail: ${safeDetail}` : message;
}

export function safeErrorMessage(err: unknown, fallback = "Unknown error."): string {
  return redactSecrets(rawErrorMessage(err, fallback));
}

export function describeUserFacingError(err: unknown): string {
  const code = errorCode(err);
  const status = errorStatus(err);
  const text = rawErrorMessage(err).toLowerCase();

  if (
    code === "ENOSPC" ||
    /no space left on device|disk full|not enough disk space/i.test(text)
  ) {
    return withDetail(
      "Run stopped because the workspace or local disk is full. Free space under WORKSPACE_ROOT (or the system drive) and retry.",
      err,
    );
  }

  if (
    code === "ENOMEM" ||
    /out of memory|heap out of memory|allocation failed|cannot allocate memory|std::bad_alloc/i.test(
      text,
    )
  ) {
    return withDetail(
      "Run stopped because the model call or verification command ran out of memory. Reduce the workload or add memory, then retry.",
      err,
    );
  }

  if (
    (status === 400 || status === 404 || status === 422) &&
    /invalid model|unknown model|unsupported model|model .*not found|bad model|invalid parameter|unknown field/i.test(
      text,
    )
  ) {
    return withDetail(
      "A provider rejected the configured model or request parameters. Check FACTORY_FREE_MODEL / ANTHROPIC_MODEL / OPENAI_MODEL and retry.",
      err,
    );
  }

  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKETTIMEDOUT" ||
    status === 408 ||
    /timed out|timeout|deadline exceeded/i.test(text)
  ) {
    return withDetail(
      "A provider or local model request timed out before the factory received a usable response. Check the endpoint health or timeout settings, then retry.",
      err,
    );
  }

  if (
    [
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENOTFOUND",
      "EAI_AGAIN",
    ].includes(code) ||
    /network unreachable|socket hang up|fetch failed|connection refused|connection reset/i.test(
      text,
    )
  ) {
    return withDetail(
      "The factory could not reach the provider or local model endpoint. Check the free-route/service URL and local network access, then retry.",
      err,
    );
  }

  return detail(err);
}
