import { describe, expect, test } from "bun:test";
import {
  formatRunSummary,
  isCredentialError,
  summarizeRun,
} from "../src/run-summary.js";
import { DEFAULT_TARGETS } from "../src/targets.js";
import type { TargetEntry } from "../src/types/config.js";
import type { RunError } from "../src/types/unified-result.js";

const OK = null;

function err(
  code: string,
  message: string,
  overrides: Partial<RunError> = {},
): RunError {
  return { code, message, retryable: false, retriesAttempted: 0, ...overrides };
}

/** The error the OpenAI SDK throws when no key is configured. */
const OPENAI_NO_KEY = err(
  "UNKNOWN",
  "Missing credentials. Please pass an `apiKey`, or set the `OPENAI_API_KEY` environment variable.",
);

/** The error the Anthropic SDK throws when no key is configured. */
const ANTHROPIC_NO_KEY = err(
  "UNKNOWN",
  "Could not resolve authentication method. Expected either apiKey or authToken to be set.",
);

/** The error exa-js throws when no key is configured. */
const EXA_NO_KEY = err(
  "UNKNOWN",
  "API key must be provided as an argument or as an environment variable (EXA_API_KEY)",
);

/** What a retired or mistyped model id comes back as. */
const BAD_MODEL = err(
  "HTTP_404",
  "404 The model `gpt-5.0-imaginary` does not exist or you do not have access to it.",
);

const TARGETS: TargetEntry[] = [
  { provider: "openai", model: "gpt-x" },
  { provider: "anthropic", model: "claude-x" },
];

function outcomes(
  provider: string,
  model: string,
  errors: Array<RunError | null>,
) {
  return errors.map((error) => ({ provider, model, error }));
}

describe("isCredentialError", () => {
  test("recognizes the absent-key error each SDK in this repo throws", () => {
    expect(isCredentialError(OPENAI_NO_KEY)).toBe(true);
    expect(isCredentialError(ANTHROPIC_NO_KEY)).toBe(true);
    expect(isCredentialError(EXA_NO_KEY)).toBe(true);
  });

  test("recognizes a present-but-rejected key by HTTP status", () => {
    expect(isCredentialError(err("HTTP_401", "Unauthorized"))).toBe(true);
    expect(isCredentialError(err("HTTP_403", "Forbidden"))).toBe(true);
  });

  test("does not mistake a wrong model id for a missing key", () => {
    expect(isCredentialError(BAD_MODEL)).toBe(false);
    expect(isCredentialError(err("HTTP_400", "invalid model parameter"))).toBe(
      false,
    );
    expect(isCredentialError(err("HTTP_500", "internal server error"))).toBe(
      false,
    );
  });
});

describe("summarizeRun", () => {
  test("a fully successful run is ok and reports per-target counts", () => {
    const summary = summarizeRun(TARGETS, [
      ...outcomes("openai", "gpt-x", [OK, OK, OK]),
      ...outcomes("anthropic", "claude-x", [OK, OK, OK]),
    ]);

    expect(summary.ok).toBe(true);
    expect(summary.succeeded).toBe(6);
    expect(summary.failed).toBe(0);
    expect(summary.targets.map((t) => [t.provider, t.status])).toEqual([
      ["openai", "ok"],
      ["anthropic", "ok"],
    ]);
  });

  test("a provider that returns only errors fails the run", () => {
    const summary = summarizeRun(TARGETS, [
      ...outcomes("openai", "gpt-x", [OK, OK, OK]),
      ...outcomes("anthropic", "claude-x", [BAD_MODEL, BAD_MODEL, BAD_MODEL]),
    ]);

    expect(summary.ok).toBe(false);
    expect(summary.failedTargets).toEqual(["anthropic/claude-x"]);

    const anthropic = summary.targets.find((t) => t.provider === "anthropic");
    expect(anthropic?.status).toBe("failed");
    expect(anthropic?.succeeded).toBe(0);
    expect(anthropic?.failed).toBe(3);
    expect(anthropic?.errorCodes).toEqual({ HTTP_404: 3 });
    expect(anthropic?.sampleError).toContain("does not exist");
  });

  test("a provider with some successes is partial, and does not fail the run", () => {
    const summary = summarizeRun(TARGETS, [
      ...outcomes("openai", "gpt-x", [OK]),
      ...outcomes("anthropic", "claude-x", [OK, BAD_MODEL]),
    ]);

    expect(summary.ok).toBe(true);
    const anthropic = summary.targets.find((t) => t.provider === "anthropic");
    expect(anthropic?.status).toBe("partial");
    expect(anthropic?.succeeded).toBe(1);
    expect(anthropic?.failed).toBe(1);
  });

  test("an unconfigured key is reported separately and does not fail the run", () => {
    const summary = summarizeRun(TARGETS, [
      ...outcomes("openai", "gpt-x", [OK, OK]),
      ...outcomes("anthropic", "claude-x", [
        ANTHROPIC_NO_KEY,
        ANTHROPIC_NO_KEY,
      ]),
    ]);

    expect(summary.ok).toBe(true);
    expect(summary.missingCredentialTargets).toEqual(["anthropic/claude-x"]);
    expect(summary.failedTargets).toEqual([]);
    expect(
      summary.targets.find((t) => t.provider === "anthropic")?.status,
    ).toBe("missing-credentials");
  });

  test("a run where every provider is unconfigured is not a success", () => {
    const summary = summarizeRun(TARGETS, [
      ...outcomes("openai", "gpt-x", [OPENAI_NO_KEY]),
      ...outcomes("anthropic", "claude-x", [ANTHROPIC_NO_KEY]),
    ]);

    expect(summary.succeeded).toBe(0);
    expect(summary.ok).toBe(false);
    expect(summary.missingCredentialTargets).toHaveLength(2);
  });

  test("a key error mixed with a real error is a failure, not a missing key", () => {
    const summary = summarizeRun(TARGETS, [
      ...outcomes("openai", "gpt-x", [OK]),
      ...outcomes("anthropic", "claude-x", [ANTHROPIC_NO_KEY, BAD_MODEL]),
    ]);

    expect(summary.ok).toBe(false);
    expect(summary.failedTargets).toEqual(["anthropic/claude-x"]);
  });

  test("a configured target that produced no result at all is reported, not dropped", () => {
    const summary = summarizeRun(TARGETS, outcomes("openai", "gpt-x", [OK]));

    expect(summary.ok).toBe(false);
    expect(summary.notRunTargets).toEqual(["anthropic/claude-x"]);
    expect(
      summary.targets.find((t) => t.provider === "anthropic")?.attempted,
    ).toBe(0);
  });

  test("results for a target outside the matrix still appear in the summary", () => {
    const summary = summarizeRun(TARGETS, [
      ...outcomes("openai", "gpt-x", [OK]),
      ...outcomes("anthropic", "claude-x", [OK]),
      ...outcomes("retired-provider", "old-model", [BAD_MODEL]),
    ]);

    expect(summary.failedTargets).toEqual(["retired-provider/old-model"]);
    expect(summary.ok).toBe(false);
  });

  test("an empty run over the real default matrix fails rather than reporting success", () => {
    const summary = summarizeRun(DEFAULT_TARGETS, []);

    expect(summary.ok).toBe(false);
    expect(summary.attempted).toBe(0);
    expect(summary.notRunTargets).toHaveLength(DEFAULT_TARGETS.length);
  });
});

// The regression the credentialed verification run on PR #14 found: every
// anthropic-agent prompt failed with a bare subprocess exit code while the five
// other targets were clean. These lock in that such a run cannot exit 0.
describe("the anthropic-agent regression of 2026-09-16", () => {
  // Copied verbatim from the recorded result record, not paraphrased.
  const AGENT_EXIT = err("UNKNOWN", "Claude Code process exited with code 1", {
    retriesAttempted: 2,
  });

  const MATRIX: TargetEntry[] = [
    { provider: "openai", model: "gpt-5.6-terra" },
    { provider: "anthropic", model: "claude-sonnet-5" },
    { provider: "anthropic-agent", model: "claude-sonnet-4-6" },
    { provider: "openrouter", model: "openai/gpt-5.6-terra:online" },
    { provider: "perplexity", model: "sonar-pro" },
    { provider: "exa", model: "exa-auto" },
  ];

  function replayRun() {
    return summarizeRun(
      MATRIX,
      MATRIX.flatMap((t) =>
        outcomes(
          t.provider,
          t.model,
          Array.from({ length: 16 }, () =>
            t.provider === "anthropic-agent" ? AGENT_EXIT : OK,
          ),
        ),
      ),
    );
  }

  test("one provider at 0/16 fails the run even though the other five are clean", () => {
    const summary = replayRun();
    expect(summary.succeeded).toBe(80);
    expect(summary.failed).toBe(16);
    expect(summary.ok).toBe(false);
    expect(summary.failedTargets).toEqual([
      "anthropic-agent/claude-sonnet-4-6",
    ]);
  });

  test("a bare subprocess exit code is not mistaken for an absent key", () => {
    // Misclassifying this as missing-credentials would exit 0 and ship the gap.
    expect(isCredentialError(AGENT_EXIT)).toBe(false);
    expect(replayRun().missingCredentialTargets).toEqual([]);
  });

  test("the summary names the failing target and quotes what it said", () => {
    const text = formatRunSummary(replayRun());
    expect(text).toContain("anthropic-agent/claude-sonnet-4-6");
    expect(text).toContain("0/16 ok");
    expect(text).toContain("PROVIDER FAILURE");
    expect(text).toContain("Claude Code process exited with code 1");
  });

  test("subprocess stderr folded into the message reclassifies a real auth failure", () => {
    // What the same failure looks like once anthropic-agent attaches stderr —
    // string taken from an actual CLI run, not invented. An absent/invalid key
    // must read as missing-credentials, not as a broken model id.
    const withStderr = err(
      "CLAUDE_CODE_EXIT_1",
      "Claude Code process exited with code 1 — stderr: Failed to authenticate. API Error: 401 API key is invalid.",
    );
    expect(isCredentialError(withStderr)).toBe(true);

    const summary = summarizeRun(
      [{ provider: "anthropic-agent", model: "claude-sonnet-4-6" }],
      outcomes("anthropic-agent", "claude-sonnet-4-6", [
        withStderr,
        withStderr,
      ]),
    );
    expect(summary.targets[0].status).toBe("missing-credentials");
  });
});

describe("formatRunSummary", () => {
  test("names the failing target and says why it matters", () => {
    const text = formatRunSummary(
      summarizeRun(TARGETS, [
        ...outcomes("openai", "gpt-x", [OK, OK]),
        ...outcomes("anthropic", "claude-x", [BAD_MODEL, BAD_MODEL]),
      ]),
    );

    expect(text).toContain("RUN SUMMARY");
    expect(text).toContain("FAILED");
    expect(text).toContain("anthropic/claude-x");
    expect(text).toContain("HTTP_404×2");
    expect(text).toContain("PROVIDER FAILURE");
    expect(text).toContain("does not exist");
  });

  test("distinguishes an unconfigured provider from a broken one", () => {
    const text = formatRunSummary(
      summarizeRun(TARGETS, [
        ...outcomes("openai", "gpt-x", [OK]),
        ...outcomes("anthropic", "claude-x", [ANTHROPIC_NO_KEY]),
      ]),
    );

    expect(text).toContain("NO CREDENTIALS");
    expect(text).toContain("No credentials (expected if unconfigured)");
    expect(text).not.toContain("PROVIDER FAILURE");
  });

  test("says plainly when a run produced nothing", () => {
    const text = formatRunSummary(
      summarizeRun(TARGETS, [
        ...outcomes("openai", "gpt-x", [OPENAI_NO_KEY]),
        ...outcomes("anthropic", "claude-x", [ANTHROPIC_NO_KEY]),
      ]),
    );

    expect(text).toContain("NOTHING SUCCEEDED");
  });

  test("confirms a clean run in one line", () => {
    const text = formatRunSummary(
      summarizeRun(TARGETS, [
        ...outcomes("openai", "gpt-x", [OK]),
        ...outcomes("anthropic", "claude-x", [OK]),
      ]),
    );

    expect(text).toContain(
      "Every configured target returned at least one usable result.",
    );
  });
});
