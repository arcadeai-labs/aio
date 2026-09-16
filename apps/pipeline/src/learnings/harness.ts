// Tier-1 (structured) generator harness: focused prompt → judge-model LLM call →
// validated Learning record. Reuses the analytics judge-model configuration and
// the same OpenAI client construction as the analysis pass. The deterministic
// preprocessing (context building) and post-validation live elsewhere; this
// module owns only the LLM round-trip and provenance stamping.

import {
  type AnalyticsConfig,
  type Learning,
  type LearningTier,
  stripNulChars,
} from "@aio/core";
import type OpenAI from "openai";
import { withRetry } from "../util/retry.js";
import type { StructuredLearningDraft } from "./types.js";
import { assertValidLearning } from "./validate.js";

// Strict JSON-schema for the model's draft. All keys are required (strict mode);
// `delta` is an always-present string that we drop when empty.
const DRAFT_SCHEMA = {
  type: "object" as const,
  properties: {
    status: {
      type: "string" as const,
      enum: ["ok", "nothing_notable", "unavailable"],
    },
    headline: { type: "string" as const },
    body: { type: "string" as const },
    confidence: { type: "string" as const, enum: ["low", "medium", "high"] },
    evidence: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          label: { type: "string" as const },
          value: { type: "string" as const },
          delta: { type: "string" as const },
          source: { type: "string" as const },
        },
        required: ["label", "value", "delta", "source"],
        additionalProperties: false,
      },
    },
  },
  required: ["status", "headline", "body", "confidence", "evidence"],
  additionalProperties: false,
};

interface DraftRaw {
  status: StructuredLearningDraft["status"];
  headline: string;
  body: string;
  confidence: StructuredLearningDraft["confidence"];
  evidence: { label: string; value: string; delta: string; source: string }[];
}

export interface StructuredHarnessInput {
  slug: string;
  tier: LearningTier;
  runDate: string;
  config: AnalyticsConfig;
  client: OpenAI;
  systemPrompt: string;
  userPrompt: string;
}

/** `slug@provider:model` — captures which judge produced the record. */
export function generatorProvenance(
  slug: string,
  config: AnalyticsConfig,
): string {
  return `${slug}@${config.judgeModel.provider}:${config.judgeModel.model}`;
}

export async function runStructuredGenerator(
  input: StructuredHarnessInput,
): Promise<Learning> {
  const { result: completion } = await withRetry(
    () =>
      input.client.chat.completions.create({
        model: input.config.judgeModel.model,
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "learning", strict: true, schema: DRAFT_SCHEMA },
        },
        temperature: 0.2,
      }),
    { maxRetries: 3 },
  );

  const rawContent = completion.choices[0]?.message?.content;
  if (!rawContent) {
    throw new Error(`Empty response from judge for learning ${input.slug}`);
  }

  // Strip NUL chars for consistency with the other LLM-JSON boundaries
  // (judge.ts, corpus.ts): a stray U+0000 aborts the Postgres insert once
  // these records are ingested.
  const draft = stripNulChars(JSON.parse(rawContent)) as DraftRaw;

  const learning: Learning = {
    slug: input.slug,
    tier: input.tier,
    runDate: input.runDate,
    status: draft.status,
    headline: draft.headline,
    body: draft.body,
    evidence: draft.evidence.map((e) => ({
      label: e.label,
      value: e.value,
      ...(e.delta.trim().length > 0 ? { delta: e.delta } : {}),
      source: e.source,
    })),
    confidence: draft.confidence,
    generator: generatorProvenance(input.slug, input.config),
    generatedAt: new Date().toISOString(),
  };

  assertValidLearning(learning);
  return learning;
}
