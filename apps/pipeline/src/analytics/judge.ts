import { stripNulChars } from "@aio/core";
import type OpenAI from "openai";
import type { UnifiedResult } from "../types/unified-result.js";
import { withRetry } from "../util/retry.js";
import {
  type JudgeMode,
  buildSystemPrompt,
  buildUserPrompt,
} from "./judge-prompt.js";
import type {
  AnalyticsConfig,
  BrandConfig,
  JudgeTokens,
  ResultVerdict,
} from "./types.js";

const VERDICT_SCHEMA = {
  type: "object" as const,
  properties: {
    brandMention: {
      type: "object" as const,
      properties: {
        mentioned: { type: "boolean" as const },
        mentionCount: { type: "integer" as const },
        excerpts: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
      required: ["mentioned", "mentionCount", "excerpts"],
      additionalProperties: false,
    },
    descriptionAccuracy: {
      anyOf: [
        {
          type: "object" as const,
          properties: {
            score: { type: "integer" as const, enum: [1, 2, 3, 4, 5] },
            reasoning: { type: "string" as const },
          },
          required: ["score", "reasoning"],
          additionalProperties: false,
        },
        { type: "null" as const },
      ],
    },
    ownedCitation: {
      type: "object" as const,
      properties: {
        cited: { type: "boolean" as const },
        urls: { type: "array" as const, items: { type: "string" as const } },
      },
      required: ["cited", "urls"],
      additionalProperties: false,
    },
    competitivePosition: {
      type: "object" as const,
      properties: {
        othersPresent: { type: "boolean" as const },
        othersCount: { type: "integer" as const },
        brandRank: {
          anyOf: [
            { type: "integer" as const, enum: [1, 2, 3] },
            { type: "string" as const, enum: ["not_ranked"] },
          ],
        },
        competitors: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              name: { type: "string" as const },
              mentioned: { type: "boolean" as const },
              citedUrls: {
                type: "array" as const,
                items: { type: "string" as const },
              },
            },
            required: ["name", "mentioned", "citedUrls"],
            additionalProperties: false,
          },
        },
      },
      required: ["othersPresent", "othersCount", "brandRank", "competitors"],
      additionalProperties: false,
    },
    mentionHypothesis: {
      anyOf: [{ type: "string" as const }, { type: "null" as const }],
    },
  },
  required: [
    "brandMention",
    "descriptionAccuracy",
    "ownedCitation",
    "competitivePosition",
    "mentionHypothesis",
  ],
  additionalProperties: false,
};

interface JudgeRawOutput {
  brandMention: {
    mentioned: boolean;
    mentionCount: number;
    excerpts: string[];
  };
  descriptionAccuracy: { score: number; reasoning: string } | null;
  ownedCitation: { cited: boolean; urls: string[] };
  competitivePosition: {
    othersPresent: boolean;
    othersCount: number;
    brandRank: number | string;
    competitors: { name: string; mentioned: boolean; citedUrls: string[] }[];
  };
  mentionHypothesis: string | null;
}

export function detectBrandInText(text: string, brand: BrandConfig): boolean {
  const terms = [brand.name, ...brand.aliases];
  const lower = text.toLowerCase();
  return terms.some((t) => lower.includes(t.toLowerCase()));
}

export function detectOwnedDomainInUrls(
  urls: string[],
  brand: BrandConfig,
): string[] {
  return urls.filter((url) =>
    brand.ownedDomains.some((domain) => {
      try {
        const hostname = new URL(url).hostname;
        return hostname === domain || hostname.endsWith(`.${domain}`);
      } catch {
        return url.includes(domain);
      }
    }),
  );
}

function collectAllUrls(result: UnifiedResult): string[] {
  const citationUrls = result.citations.map((c) => c.url);
  const searchResultUrls = result.searchResults.map((sr) => sr.url);
  return [...new Set([...citationUrls, ...searchResultUrls])];
}

export async function judgeResult(
  result: UnifiedResult,
  config: AnalyticsConfig,
  client: OpenAI,
): Promise<ResultVerdict> {
  const brand = config.brand;
  const allUrls = collectAllUrls(result);

  const hasBrandInText = detectBrandInText(result.responseText, brand);
  const hasBrandInUrls = detectOwnedDomainInUrls(allUrls, brand).length > 0;
  const mode: JudgeMode =
    hasBrandInText || hasBrandInUrls ? "full" : "competitive_only";

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(result, brand, mode);

  const { result: completion } = await withRetry(
    () =>
      client.chat.completions.create({
        model: config.judgeModel.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "verdict",
            strict: true,
            schema: VERDICT_SCHEMA,
          },
        },
        temperature: 0.1,
      }),
    { maxRetries: 3 },
  );

  const rawContent = completion.choices[0]?.message?.content;
  if (!rawContent) {
    throw new Error(`Empty response from judge for result ${result.id}`);
  }

  const raw = stripNulChars(JSON.parse(rawContent)) as JudgeRawOutput;
  const tokens: JudgeTokens = {
    input: completion.usage?.prompt_tokens ?? 0,
    output: completion.usage?.completion_tokens ?? 0,
  };

  return {
    resultId: result.id,
    prompt: result.prompt,
    provider: result.metadata.provider,
    model: result.metadata.model,
    promptCategory: result.promptCategory ?? null,

    brandMention: raw.brandMention,
    descriptionAccuracy: raw.descriptionAccuracy
      ? {
          score: raw.descriptionAccuracy.score as 1 | 2 | 3 | 4 | 5,
          reasoning: raw.descriptionAccuracy.reasoning,
        }
      : null,
    ownedCitation: raw.ownedCitation,
    competitivePosition: {
      othersPresent: raw.competitivePosition.othersPresent,
      othersCount: raw.competitivePosition.othersCount,
      brandRank:
        raw.competitivePosition.brandRank === "not_ranked"
          ? "not_ranked"
          : (raw.competitivePosition.brandRank as 1 | 2 | 3),
      competitors: raw.competitivePosition.competitors,
    },
    mentionHypothesis: raw.mentionHypothesis,

    analyzedAt: new Date().toISOString(),
    judgeModel: config.judgeModel.model,
    judgeTokens: tokens,
  };
}
