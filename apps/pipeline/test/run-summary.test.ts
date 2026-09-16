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
