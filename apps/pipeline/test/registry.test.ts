import { describe, expect, test } from "bun:test";
import { listProviders } from "../src/providers/registry.js";
import { getProvider } from "../src/providers/registry.js";

describe("provider registry", () => {
  test("lists the full known provider set", () => {
    expect(listProviders().sort()).toEqual(
      [
        "anthropic",
        "anthropic-agent",
        "codex",
        "exa",
        "openai",
        "openrouter",
        "perplexity",
      ].sort(),
    );
  });

  test("getProvider throws a helpful error for an unknown provider", () => {
    expect(() => getProvider("does-not-exist")).toThrow(/Unknown provider/);
  });
});
