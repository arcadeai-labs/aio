import { describe, expect, test } from "bun:test";
import { nestedSessionError } from "../src/providers/anthropic-agent.js";
import { isCredentialError } from "../src/run-summary.js";

/**
 * `anthropic-agent` is the only provider that runs a subprocess, and it was the
 * only one whose failures said nothing: the Agent SDK passes `stdio[2] =
 * "ignore"` unless an `stderr` callback is supplied, so the CLI's own
 * explanation was discarded at the OS level and every failure arrived as the
 * bare string "Claude Code process exited with code 1".
 *
 * These cover the two conditions that produce that string which we can detect
 * without credentials.
 */
describe("nestedSessionError", () => {
  test("refuses up front when CLAUDECODE is set", () => {
    const err = nestedSessionError({ CLAUDECODE: "1" });
    expect(err).not.toBeNull();
    // The message has to name both the cause and the fix — the CLI's own exit
    // code names neither, which is what made this look like a bad model id.
    expect(err?.message).toContain("CLAUDECODE");
    expect(err?.message).toContain("nested sessions");
    expect((err as { code?: string })?.code).toBe("CLAUDE_CODE_NESTED_SESSION");
  });

  test("allows the run when CLAUDECODE is absent or empty", () => {
    expect(nestedSessionError({})).toBeNull();
    expect(nestedSessionError({ CLAUDECODE: "" })).toBeNull();
    expect(nestedSessionError({ PATH: "/usr/bin" })).toBeNull();
  });

  test("a nested-session refusal is a provider failure, not a missing key", () => {
    // It must not be swept into missing-credentials: that status does not fail
    // the run, and this one has to.
    const err = nestedSessionError({ CLAUDECODE: "1" });
    expect(
      isCredentialError({
        code: "CLAUDE_CODE_NESTED_SESSION",
        message: err?.message ?? "",
        retryable: false,
        retriesAttempted: 0,
      }),
    ).toBe(false);
  });
});
