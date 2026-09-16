// Per-result analysis verdict produced by the LLM judge.
// Shared data contract between the pipeline (writer) and the dashboard
// (ingest + reader).

export interface BrandMention {
  mentioned: boolean;
  mentionCount: number;
  excerpts: string[];
}

export interface DescriptionAccuracy {
  score: 1 | 2 | 3 | 4 | 5;
  reasoning: string;
}

export interface OwnedCitation {
  cited: boolean;
  urls: string[];
}

export type BrandRank = 1 | 2 | 3 | "not_ranked";

export interface CompetitorEntry {
  name: string;
  mentioned: boolean;
  citedUrls: string[];
}

export interface CompetitivePosition {
  othersPresent: boolean;
  othersCount: number;
  brandRank: BrandRank;
  competitors: CompetitorEntry[];
}

export interface JudgeTokens {
  input: number;
  output: number;
}

export interface ResultVerdict {
  resultId: string;
  prompt: string;
  provider: string;
  model: string;
  promptCategory: string | null;

  brandMention: BrandMention;
  descriptionAccuracy: DescriptionAccuracy | null;
  ownedCitation: OwnedCitation;

  competitivePosition: CompetitivePosition;

  mentionHypothesis: string | null;

  analyzedAt: string;
  judgeModel: string;
  judgeTokens: JudgeTokens;
}
