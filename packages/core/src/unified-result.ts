export interface SearchQuery {
  query: string;
  timestamp: string;
}

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  score?: number;
  pageDate?: string;
}

export interface Citation {
  url: string;
  title: string;
  citedText: string;
  startIndex?: number;
  endIndex?: number;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  searchRequests?: number;
}

export interface RunMetadata {
  provider: string;
  model: string;
  searchTool: string;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  tokenUsage: TokenUsage;
  estimatedCostUsd?: number;
  runId: string;
  providerMeta?: Record<string, unknown>;
}

export interface RawSearchCall {
  callIndex: number;
  timestamp: string;
  queryText: string | null;
  rawInput: unknown;
  rawOutput: unknown;
}

export interface RunError {
  code: string;
  message: string;
  retryable: boolean;
  retriesAttempted: number;
}

export interface UnifiedResult {
  id: string;
  prompt: string;
  promptCategory?: string;
  promptMeta?: Record<string, string>;
  searchQueries: SearchQuery[];
  searchResults: SearchResult[];
  responseText: string;
  citations: Citation[];
  metadata: RunMetadata;
  rawSearchCalls?: RawSearchCall[];
  error: RunError | null;
}
