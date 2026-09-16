import { describe, expect, test } from "bun:test";
import { withRetry } from "../src/util/retry.js";

// Keep delays tiny so the retry path doesn't slow the suite.
const FAST = { baseDelayMs: 1, maxDelayMs: 2 };

describe("withRetry", () => {
  test("returns the result with zero retries on first success", async () => {
    const { result, retriesAttempted } = await withRetry(async () => 42, FAST);
    expect(result).toBe(42);
    expect(retriesAttempted).toBe(0);
  });

  test("retries on a retryable error then succeeds", async () => {
    let calls = 0;
    const { result, retriesAttempted } = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error("rate limit exceeded (429)");
      return "ok";
    }, FAST);
    expect(result).toBe("ok");
    expect(retriesAttempted).toBe(2);
    expect(calls).toBe(3);
  });

  test("does not retry a non-retryable error", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error("400 bad request");
      }, FAST),
    ).rejects.toThrow(/bad request/);
    expect(calls).toBe(1);
  });

  test("gives up after exhausting maxRetries on persistent retryable errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("503 service unavailable");
        },
        { ...FAST, maxRetries: 2 },
      ),
    ).rejects.toThrow(/service unavailable/);
    expect(calls).toBe(3); // initial + 2 retries
  });

  test("retries a transport-level connection error", async () => {
    let calls = 0;
    const { result } = await withRetry(async () => {
      calls++;
      if (calls < 3) {
        throw new Error(
          "Connection error.: Unable to connect. Is the computer able to access the url?",
        );
      }
      return "recovered";
    }, FAST);
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  test("retries an APIConnectionError recognized by name alone", async () => {
    let calls = 0;
    const { result } = await withRetry(async () => {
      calls++;
      if (calls < 2) {
        const err = new Error("something opaque");
        err.name = "APIConnectionError";
        throw err;
      }
      return "recovered";
    }, FAST);
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  test("treats an object error with status>=500 as retryable", async () => {
    let calls = 0;
    const { result } = await withRetry(async () => {
      calls++;
      if (calls < 2) throw { status: 500 };
      return "recovered";
    }, FAST);
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });
});
