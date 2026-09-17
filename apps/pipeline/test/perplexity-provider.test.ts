import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PerplexityProvider } from "../src/providers/perplexity.js";
import { isCredentialError } from "../src/run-summary.js";

/**
 * The failure paths of the migrated Perplexity provider.
 *
 * Every case here produces an HTTP 200. That is the point: this project's
 * characteristic bug is a plausible number rather than an error, and on the
 * Agent API the two ways to get one are a 200 that says `status: "failed"` and
 * a 200 where the model simply never searched. Neither raises anything on its
 * own; `BaseProvider`'s try/catch sees a resolved promise and would record a
 * clean, successful, empty result that the judge then scores as "brand not
 * mentioned" and the dashboard renders as a confident 0%.
 *
 * The `status !== "completed"` shape is **synthesised**, not captured. Six live
 * calls during the #16 investigation all returned `completed`, and a failed
 * response could not be provoked on demand — so the provider's check is written
 * on faith and this is the only way to exercise it. Stated plainly rather than
 * dressed up as a live observation.
 *
 * Nothing here mocks `PerplexityProvider`. Only `fetch` is replaced; the class
 * under test is the real one, entered through its public `run()`.
 */

const KEY_VAR: string = "PERPLEXITY_API_KEY";
const OPENAI_KEY_VAR: string = "OPENAI_API_KEY";
const PERPLEXITY_SENTINEL = "sentinel-perplexity-key-not-real";

const realFetch = globalThis.fetch;
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env[KEY_VAR];
  process.env[KEY_VAR] = PERPLEXITY_SENTINEL;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env[KEY_VAR];
  else process.env[KEY_VAR] = savedKey;
});

interface Sent {
  url: string;
  body: unknown;
}

function serve(body: unknown, status = 200): Sent[] {
  const sent: Sent[] = [];
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
    sent.push({
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return sent;
}

const INPUT = {
  prompt: "What is Taskwell and who is it for?",
  model: "perplexity/sonar",
  runId: "provider-test",
};

/** A well-formed, searched, completed response. */
function goodResponse() {
  return {
    id: "resp_ok",
    status: "completed",
    model: "perplexity/sonar",
    output: [
      {
        type: "search_results",
        queries: ["Taskwell"],
        results: [
          {
            url: "https://taskwell.example/",
            title: "Taskwell",
            snippet: "Taskwell is a to-do app.",
          },
        ],
      },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "Taskwell is a to-do app.",
            annotations: [],
          },
        ],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
    error: null,
  };
}

describe("the request the provider sends", () => {
  test("POSTs /v1/agent with input, the asked-for model, and the web_search tool", async () => {
    const sent = serve(goodResponse());
    const result = await new PerplexityProvider().run(INPUT);

    expect(result.error).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://api.perplexity.ai/v1/agent");
    // The tool is what makes search happen at all. Chat-completions searched
    // unconditionally; the Agent API does not.
    expect(sent[0].body).toEqual({
      model: "perplexity/sonar",
      input: "What is Taskwell and who is it for?",
      tools: [{ type: "web_search" }],
    });
  });

  test("healthCheck probes the model the matrix runs and requires a completed status", async () => {
    const provider = new PerplexityProvider();
    const sent = serve({ id: "h", status: "completed", output: [] });

    expect(await provider.healthCheck()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://api.perplexity.ai/v1/agent");
    expect(sent[0].body).toEqual({
      model: provider.supportedModels[0],
      input: "ping",
      max_output_tokens: 64,
    });
    expect(provider.supportedModels[0]).toBe("perplexity/sonar");
  });

  test("healthCheck is false on a 200 that did not complete — not green off the HTTP code", async () => {
    serve({ id: "h", status: "failed", error: { message: "upstream" } });
    expect(await new PerplexityProvider().healthCheck()).toBe(false);
  });

  test("healthCheck is false on an unrecognised status, including an absent one", async () => {
    serve({ id: "h" });
    expect(await new PerplexityProvider().healthCheck()).toBe(false);
  });

  test("healthCheck is true when the probe merely hit its token budget", async () => {
    // `incomplete` is a fact about `max_output_tokens`, not about the endpoint.
    // Reporting a working provider as broken is the same class of wrong answer
    // as reporting a broken one as working.
    serve({ id: "h", status: "incomplete", output: [] });
    expect(await new PerplexityProvider().healthCheck()).toBe(true);
  });

  test("healthCheck is false on a non-2xx", async () => {
    serve({ error: "nope" }, 503);
    expect(await new PerplexityProvider().healthCheck()).toBe(false);
  });
});

describe("a 200 that is not a completed response", () => {
  // Synthesised — never observed live. See the file header.
  test('status: "failed" is recorded as an error, not as an empty success', async () => {
    serve({
      id: "resp_bad",
      status: "failed",
      output: [],
      error: { message: "upstream model unavailable", type: "server_error" },
    });

    const result = await new PerplexityProvider().run(INPUT);

    expect(result.error).not.toBeNull();
    expect(result.error?.code).toBe("agent_status_not_completed");
    expect(result.error?.message).toContain("failed");
    expect(result.error?.message).toContain("upstream model unavailable");
    // The failure mode being prevented: a clean-looking row.
    expect(result.responseText).toBe("");
    expect(result.citations).toEqual([]);
    // And it must not be mistaken for an unconfigured provider, which the run
    // summary tolerates rather than failing the run on.
    expect(result.error && isCredentialError(result.error)).toBe(false);
  });

  test('status: "incomplete" is also rejected, even with usable text present', async () => {
    // The dangerous variant: there IS text, so nothing looks wrong.
    const truncated = goodResponse();
    truncated.status = "incomplete";
    serve(truncated);

    const result = await new PerplexityProvider().run(INPUT);
    expect(result.error?.code).toBe("agent_status_not_completed");
    expect(result.responseText).toBe("");
  });

  test("an absent status is rejected rather than treated as success", async () => {
    const noStatus = goodResponse() as Record<string, unknown>;
    // biome-ignore lint/performance/noDelete: modelling a field the server omitted
    delete noStatus.status;
    serve(noStatus);

    const result = await new PerplexityProvider().run(INPUT);
    expect(result.error?.code).toBe("agent_status_not_completed");
  });
});

const UNSEARCHED_ANSWER =
  "Taskwell is a well-regarded to-do application for small teams.";

/** Fluent, confident, completed — and sourceless. */
function unsearchedResponse() {
  return {
    id: "resp_nosearch",
    status: "completed",
    model: "perplexity/sonar",
    output: [
      {
        type: "message",
        content: [
          { type: "output_text", text: UNSEARCHED_ANSWER, annotations: [] },
        ],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
    error: null,
  };
}

describe("a 200 where the model never searched", () => {
  // Web search is opt-in and the model decides, so this is reachable even
  // though the request carries the tool. Recording it rather than failing it is
  // a decision taken on #16 with the cost understood: the answer comes from
  // parametric memory, not from Perplexity's search index, and once recorded it
  // is scored like any other result.
  test("an answer given without searching is recorded, not failed", async () => {
    serve(unsearchedResponse());

    const result = await new PerplexityProvider().run(INPUT);

    expect(result.error).toBeNull();
    expect(result.searchResults).toEqual([]);
    expect(result.citations).toEqual([]);
    expect(result.searchQueries).toEqual([]);
  });

  test("the recorded answer keeps its text — an uncited result is not an empty one", async () => {
    // The half that would rot silently. Flipping this path back to a throw, or
    // dropping the text on the way through, both leave `searchResults: []` and
    // look identical from the assertions above.
    serve(unsearchedResponse());

    const result = await new PerplexityProvider().run(INPUT);

    expect(result.responseText).toBe(UNSEARCHED_ANSWER);
    expect(result.responseText.trim()).not.toBe("");
    expect(result.metadata.tokenUsage.outputTokens).toBe(20);
  });

  test("rawSearchCalls is empty, which is how an unsearched answer stays distinguishable", async () => {
    // The two zero-result cases produce similar results but are different
    // facts, and this is the field that separates them: no search was
    // attempted here, whereas the test below searched and found nothing. It
    // survives into the JSONL archive, so the distinction is recoverable after
    // the fact even though neither carries an error.
    serve(unsearchedResponse());

    const result = await new PerplexityProvider().run(INPUT);
    expect(result.rawSearchCalls).toEqual([]);
  });

  test("a search that ran and found nothing IS a result — a genuine zero is not a failure", async () => {
    // The other half of the pair above, and the reason the two branches are not
    // collapsed. The search block is present with an empty results array: the
    // engine searched and returned nothing. That is a real measurement of a
    // quiet brand. Both cases are now recorded and both have empty
    // `searchResults`, so the assertions that matter are the ones that tell
    // them apart — the queries it ran, and a rawSearchCall proving a search
    // happened at all.
    serve({
      id: "resp_empty_search",
      status: "completed",
      model: "perplexity/sonar",
      output: [
        { type: "search_results", queries: ["Taskwell"], results: [] },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "I could not find anything.",
              annotations: [],
            },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
      error: null,
    });

    const result = await new PerplexityProvider().run(INPUT);

    expect(result.error).toBeNull();
    expect(result.responseText).toBe("I could not find anything.");
    expect(result.searchResults).toEqual([]);
    expect(result.citations).toEqual([]);
    // The searches themselves are still recorded, so the row carries evidence
    // that a search happened and returned nothing.
    expect(result.searchQueries.map((q) => q.query)).toEqual(["Taskwell"]);
    expect(result.rawSearchCalls).toHaveLength(1);
  });
});

describe("transport failures keep the codes the run summary relies on", () => {
  test("a 401 becomes HTTP_401, which the run summary reads as a credential problem", async () => {
    serve({ error: { message: "unauthorized" } }, 401);
    const result = await new PerplexityProvider().run(INPUT);
    expect(result.error?.code).toBe("HTTP_401");
    expect(result.error && isCredentialError(result.error)).toBe(true);
  });

  test("a 500 becomes HTTP_500 and is retried before giving up", async () => {
    const sent = serve({ error: { message: "boom" } }, 500);
    const result = await new PerplexityProvider().run(INPUT);
    expect(result.error?.code).toBe("HTTP_500");
    // BaseProvider asks for maxRetries: 2, so a retryable status is attempted
    // three times in total. If this drops to 1 the retry path has been lost.
    expect(sent.length).toBe(3);
  });

  test("a 400 is not retried — a bad model id should fail fast, not three times", async () => {
    const sent = serve(
      {
        error: {
          message: 'validation failed: model "sonar-pro" is not supported',
        },
      },
      400,
    );
    const result = await new PerplexityProvider().run(INPUT);
    expect(result.error?.code).toBe("HTTP_400");
    expect(result.error?.message).toContain("is not supported");
    expect(sent).toHaveLength(1);
  });
});

describe("the key never falls back to another vendor's (#15)", () => {
  test("an absent PERPLEXITY_API_KEY sends nothing, even with OPENAI_API_KEY set", async () => {
    const savedOpenAi = process.env[OPENAI_KEY_VAR];
    const OPENAI_SENTINEL = "sentinel-openai-key-not-real";
    delete process.env[KEY_VAR];
    process.env[OPENAI_KEY_VAR] = OPENAI_SENTINEL;

    try {
      const sent = serve(goodResponse());
      const result = await new PerplexityProvider().run(INPUT);

      // Not "the request was rejected" — the request was never made, so the
      // OpenAI key never left the process.
      expect(sent).toEqual([]);
      expect(result.error?.code).toBe("missing_credentials");
      expect(result.error?.message).toContain("PERPLEXITY_API_KEY");
    } finally {
      if (savedOpenAi === undefined) delete process.env[OPENAI_KEY_VAR];
      else process.env[OPENAI_KEY_VAR] = savedOpenAi;
    }
  });

  test("the Authorization header carries the Perplexity key and nothing else", async () => {
    const savedOpenAi = process.env[OPENAI_KEY_VAR];
    const OPENAI_SENTINEL = "sentinel-openai-key-not-real";
    process.env[OPENAI_KEY_VAR] = OPENAI_SENTINEL;

    const seen: string[] = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      seen.push(headers.get("authorization") ?? "");
      return new Response(JSON.stringify(goodResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await new PerplexityProvider().run(INPUT);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(`Bearer ${PERPLEXITY_SENTINEL}`);
      expect(seen[0]).not.toContain(OPENAI_SENTINEL);
    } finally {
      if (savedOpenAi === undefined) delete process.env[OPENAI_KEY_VAR];
      else process.env[OPENAI_KEY_VAR] = savedOpenAi;
    }
  });
});
