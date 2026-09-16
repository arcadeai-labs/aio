import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRunInput } from "../types/provider.js";
import type {
  Citation,
  RawSearchCall,
  SearchQuery,
  SearchResult,
  UnifiedResult,
} from "../types/unified-result.js";
import { BaseProvider } from "./base.js";

interface WebSearchToolInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

interface WebFetchToolInput {
  url: string;
  prompt?: string;
}

// Claude's native web tools. The base toolset is restricted to exactly these
// so the agent cannot reach filesystem tools or anything else.
const NATIVE_WEB_TOOLS = ["WebSearch", "WebFetch"];

// The session must be hermetic: no filesystem settings and no MCP servers.
// strictMcpConfig is required — without it the CLI still loads MCP servers
// from the local ~/.claude config even when mcpServers is empty, which
// contaminated the 2026-07-13 run with this machine's MCP tools.
const ISOLATION_OPTIONS = {
  settingSources: [] as [],
  mcpServers: {},
  strictMcpConfig: true,
  permissionMode: "bypassPermissions" as const,
  allowDangerouslySkipPermissions: true,
};

// How much subprocess stderr to keep. The CLI can be chatty on the way down;
// the useful line is almost always near the end, so we keep a tail rather than
// a head and never let a runaway process balloon a result record.
const MAX_STDERR_CAPTURE = 4000;

/**
 * Collector for the Claude Code subprocess's stderr.
 *
 * This provider is the only one that shells out, and it was the only one whose
 * failures said nothing: the Agent SDK spawns the CLI with `stdio[2] = "ignore"`
 * **unless** an `stderr` callback is supplied, so without one every failure
 * arrives as the bare string "Claude Code process exited with code 1" and the
 * CLI's own explanation is discarded at the OS level. Supplying the callback
 * flips that to a pipe and gives us the diagnosis.
 */
class StderrTail {
  private chunks: string[] = [];
  private length = 0;

  readonly onData = (data: string): void => {
    this.chunks.push(data);
    this.length += data.length;
    // Drop from the front once we are over budget, keeping the tail.
    while (this.length > MAX_STDERR_CAPTURE && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.length -= dropped?.length ?? 0;
    }
  };

  text(): string {
    return this.chunks.join("").slice(-MAX_STDERR_CAPTURE).trim();
  }
}

/**
 * The Claude Code CLI refuses to launch when `CLAUDECODE` is set, because that
 * marks the caller as an already-running Claude Code session and nested
 * sessions share runtime resources. It exits 1 and the SDK reports the bare
 * string "Claude Code process exited with code 1" — with stderr piped, verbatim:
 *
 *   Error: Claude Code cannot be launched inside another Claude Code session.
 *   Nested sessions share runtime resources and will crash all active sessions.
 *   To bypass this check, unset the CLAUDECODE environment variable.
 *
 * Every prompt in the run hits this, so the target reports 0/N and is dropped
 * from every downstream denominator — and because the message names neither the
 * cause nor the fix, it reads exactly like a bad model id. Check it once, up
 * front, instead of spawning a doomed subprocess per prompt. We do not unset the
 * variable for the child: the guard is the CLI's, the warning about crashing
 * active sessions is real, and silently defeating another tool's safety check on
 * someone's machine is not this pipeline's call to make.
 */
export function nestedSessionError(
  env: Record<string, string | undefined>,
): Error | null {
  if (!env.CLAUDECODE) return null;
  return Object.assign(
    new Error(
      "Refusing to run: CLAUDECODE is set, so the Claude Code CLI this " +
        "provider spawns will refuse to launch (nested sessions share runtime " +
        "resources). Run the pipeline outside a Claude Code session, or unset " +
        "CLAUDECODE if you accept the nesting risk.",
    ),
    { code: "CLAUDE_CODE_NESTED_SESSION" },
  );
}

/**
 * Rebuild a thrown SDK error so the run summary can say something useful.
 *
 * `Claude Code process exited with code 1` is all the SDK gives us; the reason
 * is in the subprocess's stderr. Folding that into the message means it reaches
 * `UnifiedResult.error.message` and the summary's per-target sample line, and it
 * also lets the existing credential classifier do its job — an auth failure from
 * the CLI now reads as one instead of as an opaque provider failure.
 */
function withStderr(err: unknown, stderr: string): Error {
  const base = err instanceof Error ? err.message : String(err);
  const rebuilt = new Error(
    stderr.length > 0 ? `${base} — stderr: ${stderr}` : base,
  );
  // Preserve a parseable code so the summary groups these together rather than
  // lumping every subprocess death under "UNKNOWN".
  const exit = base.match(/exited with code (\d+)/)?.[1];
  if (exit) Object.assign(rebuilt, { code: `CLAUDE_CODE_EXIT_${exit}` });
  if (err instanceof Error && err.stack) rebuilt.stack = err.stack;
  return rebuilt;
}

interface TrackedToolUse {
  tool: "WebSearch" | "WebFetch";
  queryText: string;
  rawInput: unknown;
}

export class AnthropicAgentProvider extends BaseProvider {
  readonly name = "anthropic-agent";
  readonly displayName = "Anthropic (Agent SDK)";
  // NOT the same list as the `anthropic` provider's, and that is the point.
  // This provider talks to the Claude Code CLI the Agent SDK bundles, which is
  // versioned separately from the Messages API and lags it. Read out of the
  // pinned build (claude-agent-sdk 0.2.50 -> Claude Code 2.1.50) on 2026-09-16:
  // the binary contains no Claude 5 model string, and the newest id it knows
  // per tier is the list below. Keep it sourced from the bundled CLI, not from
  // Anthropic's model docs — a model the API serves is not automatically a
  // model this subprocess can run.
  readonly supportedModels = [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5-20251001",
  ];

  async healthCheck(): Promise<boolean> {
    try {
      for await (const msg of query({
        prompt: "Say 'ok'",
        options: {
          maxTurns: 1,
          tools: [],
          allowedTools: [],
          ...ISOLATION_OPTIONS,
        },
      })) {
        if (msg.type === "result") return msg.subtype === "success";
      }
      return false;
    } catch {
      return false;
    }
  }

  protected async execute(input: ProviderRunInput): Promise<UnifiedResult> {
    const searchQueries: SearchQuery[] = [];
    const searchResults: SearchResult[] = [];
    const rawSearchCalls: RawSearchCall[] = [];
    let responseText = "";
    let totalCostUsd: number | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let searchRequests = 0;
    // tool_use id → call details, so tool_result blocks are attributed to the
    // exact call they answer instead of "whatever tool_use came last".
    const trackedToolUses = new Map<string, TrackedToolUse>();
    const stderr = new StderrTail();

    const nested = nestedSessionError(process.env);
    if (nested) throw nested;

    try {
      for await (const msg of query({
        prompt: input.prompt,
        options: {
          model: input.model,
          tools: NATIVE_WEB_TOOLS,
          allowedTools: NATIVE_WEB_TOOLS,
          maxTurns: 10,
          stderr: stderr.onData,
          ...ISOLATION_OPTIONS,
        },
      })) {
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type !== "tool_use") continue;
            if (block.name === "WebSearch") {
              const toolInput = block.input as WebSearchToolInput;
              searchQueries.push({
                query: toolInput.query,
                timestamp: new Date().toISOString(),
              });
              searchRequests++;
              trackedToolUses.set(block.id, {
                tool: "WebSearch",
                queryText: toolInput.query,
                rawInput: block.input,
              });
            } else if (block.name === "WebFetch") {
              const toolInput = block.input as WebFetchToolInput;
              trackedToolUses.set(block.id, {
                tool: "WebFetch",
                queryText: toolInput.url,
                rawInput: block.input,
              });
            }
          }
        }

        if (msg.type === "user") {
          const content = msg.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type !== "tool_result") continue;
              const call = trackedToolUses.get(block.tool_use_id);
              if (!call) continue;
              trackedToolUses.delete(block.tool_use_id);

              rawSearchCalls.push({
                callIndex: rawSearchCalls.length,
                timestamp: new Date().toISOString(),
                queryText: call.queryText,
                rawInput: call.rawInput,
                rawOutput: block.content,
              });

              if (call.tool === "WebSearch") {
                searchResults.push(...parseWebSearchResults(block.content));
              }
            }
          }
        }

        if (msg.type === "result") {
          if (msg.subtype === "success") {
            responseText = msg.result;
          }
          totalCostUsd = msg.total_cost_usd;
          inputTokens = msg.usage.input_tokens ?? undefined;
          outputTokens = msg.usage.output_tokens ?? undefined;
        }
      }
    } catch (err) {
      throw withStderr(err, stderr.text());
    }

    // Derive citations from search results referenced in the response
    const citations: Citation[] = [];
    for (const sr of searchResults) {
      if (
        responseText.includes(sr.url) ||
        (sr.title.length > 0 && responseText.includes(sr.title))
      ) {
        citations.push({
          url: sr.url,
          title: sr.title,
          citedText: sr.snippet,
        });
      }
    }

    return {
      id: crypto.randomUUID(),
      prompt: input.prompt,
      promptCategory: input.promptCategory,
      promptMeta: input.promptMeta,
      searchQueries,
      searchResults,
      responseText,
      citations,
      rawSearchCalls,
      metadata: {
        provider: this.name,
        model: input.model,
        searchTool: "claude-agent-sdk-websearch",
        startedAt: "",
        completedAt: "",
        latencyMs: 0,
        tokenUsage: {
          inputTokens,
          outputTokens,
          searchRequests,
        },
        estimatedCostUsd: totalCostUsd,
        runId: input.runId,
        providerMeta: {
          sdk: "@anthropic-ai/claude-agent-sdk",
        },
      },
      error: null,
    };
  }
}

/**
 * Parse a WebSearch tool_result into search results.
 *
 * The native WebSearch tool returns a text block shaped like:
 *
 *   Web search results for query: "..."
 *
 *   Links: [{"title":"...","url":"..."}, ...]
 *
 *   <model-readable summary>
 *
 * The Links array is a single line of JSON. Entries without a string url are
 * dropped — a missing url in the results file crashes downstream analytics.
 */
function parseWebSearchResults(content: unknown): SearchResult[] {
  const texts: string[] = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    }
  }

  const results: SearchResult[] = [];
  for (const text of texts) {
    const match = text.match(/^Links:\s*(\[.*\])\s*$/m);
    if (!match?.[1]) continue;
    let links: unknown;
    try {
      links = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (!Array.isArray(links)) continue;
    for (const link of links) {
      const l = link as { url?: unknown; title?: unknown };
      if (typeof l.url !== "string" || l.url.length === 0) continue;
      results.push({
        url: l.url,
        title: typeof l.title === "string" ? l.title : "",
        snippet: "",
      });
    }
  }
  return results;
}
