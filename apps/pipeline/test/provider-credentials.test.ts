import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MissingCredentialError,
  requireApiKey,
} from "../src/providers/credentials.js";
import { createSynthesisClient } from "../src/providers/exa.js";
import { OpenRouterProvider } from "../src/providers/openrouter.js";
import { PerplexityProvider } from "../src/providers/perplexity.js";
import { isCredentialError, summarizeRun } from "../src/run-summary.js";

/**
 * Perplexity and OpenRouter are reached through the OpenAI SDK with a custom
 * `baseURL`, and the SDK's constructor destructures
 * `apiKey = readEnv("OPENAI_API_KEY")`. Passing `process.env.PERPLEXITY_API_KEY`
 * when that variable is unset therefore passed `undefined`, the default fired,
 * and a client aimed at `https://api.perplexity.ai` authenticated with the
 * OpenAI key — sending one provider's secret to another provider's request log.
 *
 * These tests need no real credential. Everything here is a sentinel, and the
 * assertions are identity comparisons and request captures; no key value is ever
 * printed, including on failure.
 */

const OPENAI_SENTINEL = "sentinel-openai-key-not-real";
const PERPLEXITY_SENTINEL = "sentinel-perplexity-key-not-real";
const OPENROUTER_SENTINEL = "sentinel-openrouter-key-not-real";

const MANAGED = [
  "OPENAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

// `bun test` loads the repo-root `.env`, which on a developer machine has every
// key set and would mask the whole bug. Take these three variables over for the
// duration and put the originals back afterwards.
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(MANAGED.map((k) => [k, process.env[k]]));
  for (const k of MANAGED) delete process.env[k];
});

afterEach(() => {
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  restoreFetch();
});

/** Every request the process attempted, as (url, Authorization header). */
interface CapturedRequest {
  url: string;
  authorization: string;
}

const realFetch = globalThis.fetch;

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/**
 * Replace `fetch` so a request that should never happen is recorded instead of
 * sent. `body` is the JSON a chat-completions call gets back when we do want the
 * request to go through.
 */
function captureFetch(body: unknown = {}): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    captured.push({ url, authorization: headers.get("authorization") ?? "" });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return captured;
}

const INPUT = {
  prompt: "What is Taskwell and who is it for?",
  model: "perplexity/sonar",
  runId: "test-run",
};

describe("requireApiKey", () => {
  test("returns the variable's value when it is set", () => {
    process.env.PERPLEXITY_API_KEY = PERPLEXITY_SENTINEL;
    expect(requireApiKey("PERPLEXITY_API_KEY", "Perplexity")).toBe(
      PERPLEXITY_SENTINEL,
    );
  });

  test("throws by name when the variable is absent, even with OPENAI_API_KEY set", () => {
    process.env.OPENAI_API_KEY = OPENAI_SENTINEL;
    expect(() => requireApiKey("PERPLEXITY_API_KEY", "Perplexity")).toThrow(
      MissingCredentialError,
    );
    try {
      requireApiKey("PERPLEXITY_API_KEY", "Perplexity");
      throw new Error("expected requireApiKey to throw");
    } catch (err) {
      const e = err as MissingCredentialError;
      expect(e.variable).toBe("PERPLEXITY_API_KEY");
      expect(e.code).toBe("missing_credentials");
      expect(e.message).toContain("PERPLEXITY_API_KEY");
      // The old behaviour reported an invalid key for a key that was never set.
      expect(e.message).not.toMatch(/invalid/i);
    }
  });

  test("an empty or whitespace variable is absent, not a credential", () => {
    process.env.PERPLEXITY_API_KEY = "";
    expect(() => requireApiKey("PERPLEXITY_API_KEY", "Perplexity")).toThrow(
      MissingCredentialError,
    );
    process.env.PERPLEXITY_API_KEY = "   ";
    expect(() => requireApiKey("PERPLEXITY_API_KEY", "Perplexity")).toThrow(
      MissingCredentialError,
    );
  });
});

describe("a provider whose key is absent sends nothing", () => {
  test("perplexity: no request leaves the process, and none carries the OpenAI key", async () => {
    process.env.OPENAI_API_KEY = OPENAI_SENTINEL;
    const requests = captureFetch();

    const result = await new PerplexityProvider().run(INPUT);

    // The demonstration: not "the request was rejected" — the request was never
    // made. Nothing reached api.perplexity.ai, so the OpenAI key never left.
    expect(requests).toEqual([]);
    expect(
      requests.some((r) => r.authorization.includes(OPENAI_SENTINEL)),
    ).toBe(false);

    expect(result.error?.code).toBe("missing_credentials");
    expect(result.error?.message).toContain("PERPLEXITY_API_KEY");
    expect(result.error?.message).not.toMatch(/invalid/i);
    expect(result.responseText).toBe("");
  });

  test("openrouter: no request leaves the process, and none carries the OpenAI key", async () => {
    process.env.OPENAI_API_KEY = OPENAI_SENTINEL;
    const requests = captureFetch();

    const result = await new OpenRouterProvider().run({
      ...INPUT,
      model: "openai/gpt-5.6-terra:online",
    });

    expect(requests).toEqual([]);
    expect(
      requests.some((r) => r.authorization.includes(OPENAI_SENTINEL)),
    ).toBe(false);

    expect(result.error?.code).toBe("missing_credentials");
    expect(result.error?.message).toContain("OPENROUTER_API_KEY");
    expect(result.error?.message).not.toMatch(/invalid/i);
  });

  test("exa's synthesis client refuses before a client exists", () => {
    process.env.OPENAI_API_KEY = OPENAI_SENTINEL;

    expect(() => createSynthesisClient("perplexity")).toThrow(
      MissingCredentialError,
    );
    expect(() => createSynthesisClient("openrouter")).toThrow(
      MissingCredentialError,
    );
    // The openai branch talks to api.openai.com, where the SDK's own default is
    // the right key for the right host, so it is left alone.
    expect(createSynthesisClient("openai").apiKey).toBe(OPENAI_SENTINEL);
  });
});

describe("a provider whose key is present uses its own key", () => {
  test("perplexity authenticates api.perplexity.ai with PERPLEXITY_API_KEY", async () => {
    process.env.OPENAI_API_KEY = OPENAI_SENTINEL;
    process.env.PERPLEXITY_API_KEY = PERPLEXITY_SENTINEL;
    // A minimally valid Agent API response. It has to be valid, not just any
    // JSON: the provider rejects a response that did not search, so a stub
    // left over from the chat-completions era would retry three times and this
    // test would fail for a reason unrelated to credentials.
    const requests = captureFetch({
      id: "x",
      status: "completed",
      output: [
        {
          type: "search_results",
          queries: ["q"],
          results: [{ url: "https://e.example" }],
        },
        { type: "message", content: [{ type: "output_text", text: "hi" }] },
      ],
    });

    const result = await new PerplexityProvider().run(INPUT);
    expect(result.error).toBeNull();

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.perplexity.ai/v1/agent");
    expect(requests[0].authorization).toContain(PERPLEXITY_SENTINEL);
    expect(requests[0].authorization).not.toContain(OPENAI_SENTINEL);
  });

  test("openrouter authenticates openrouter.ai with OPENROUTER_API_KEY", async () => {
    process.env.OPENAI_API_KEY = OPENAI_SENTINEL;
    process.env.OPENROUTER_API_KEY = OPENROUTER_SENTINEL;
    const requests = captureFetch({
      id: "x",
      choices: [{ message: { role: "assistant", content: "hi" } }],
    });

    await new OpenRouterProvider().run({
      ...INPUT,
      model: "openai/gpt-5.6-terra:online",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toStartWith("https://openrouter.ai/api/v1");
    expect(requests[0].authorization).toContain(OPENROUTER_SENTINEL);
    expect(requests[0].authorization).not.toContain(OPENAI_SENTINEL);
  });
});

describe("the run summary tells the truth about an unset key", () => {
  test("an absent key is missing-credentials, names the variable, and does not fail the run", async () => {
    process.env.OPENAI_API_KEY = OPENAI_SENTINEL;
    captureFetch();

    const result = await new PerplexityProvider().run(INPUT);
    expect(result.error).not.toBeNull();
    if (!result.error) throw new Error("expected an error");

    expect(isCredentialError(result.error)).toBe(true);

    const summary = summarizeRun(
      [
        { provider: "openai", model: "gpt-5.6-terra" },
        { provider: "perplexity", model: "perplexity/sonar" },
      ],
      [
        { provider: "openai", model: "gpt-5.6-terra", error: null },
        {
          provider: "perplexity",
          model: "perplexity/sonar",
          error: result.error,
        },
      ],
    );

    expect(summary.missingCredentialTargets).toEqual([
      "perplexity/perplexity/sonar",
    ]);
    expect(summary.failedTargets).toEqual([]);
    // The README promises an unconfigured provider leaves the rest of the run
    // intact. Before the fix this was an HTTP_401 — still credential-shaped, but
    // reported as a key that was wrong rather than one that was never set.
    expect(summary.ok).toBe(true);
    expect(summary.targets[1].sampleError).toContain("PERPLEXITY_API_KEY");
  });
});
