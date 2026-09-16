import { logger } from "./logger.js";

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<{ result: T; retriesAttempted: number }> {
  const { maxRetries, baseDelayMs, maxDelayMs } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...opts,
  };

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      return { result, retriesAttempted: attempt };
    } catch (err) {
      lastError = err;

      if (attempt === maxRetries) break;

      if (!isRetryable(err)) {
        throw err;
      }

      const delay = Math.min(
        baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs,
        maxDelayMs,
      );

      logger.warn(
        { attempt: attempt + 1, maxRetries, delayMs: Math.round(delay) },
        "Retrying after error",
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

// Transport-level failures the SDK surfaces as APIConnectionError. These carry
// no HTTP status, so they have to be matched by name/message or a single blip
// mid-run aborts the whole analysis.
const CONNECTION_ERROR_PATTERNS = [
  "connection error",
  "unable to connect",
  "econnreset",
  "econnrefused",
  "enotfound",
  "eai_again",
  "epipe",
  "socket hang up",
  "network error",
  "fetch failed",
];

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("rate limit") || msg.includes("429")) return true;
    if (msg.includes("timeout")) return true;
    if (CONNECTION_ERROR_PATTERNS.some((p) => msg.includes(p))) return true;
    if (msg.includes("500") || msg.includes("502") || msg.includes("503"))
      return true;
    if (
      err.name === "APIConnectionError" ||
      err.name === "APIConnectionTimeoutError"
    )
      return true;
  }
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: number }).status;
    return status === 429 || status >= 500;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
