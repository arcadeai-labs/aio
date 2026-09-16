import type { UnifiedResult } from "../types/unified-result.js";
import type { BrandConfig } from "./types.js";

export function buildSystemPrompt(): string {
  return `You are an expert analyst evaluating brand presence in AI-generated search responses.
You will receive a brand profile and an AI response to analyze. Your job is to evaluate:
1. Whether and how the brand is mentioned
2. How accurately the brand is described (if mentioned)
3. Whether the brand's owned domains appear in citations
4. How the brand is positioned relative to competitors

Respond with JSON matching the requested schema. Be precise and evidence-based.`;
}

export type JudgeMode = "full" | "competitive_only";

export function buildUserPrompt(
  result: UnifiedResult,
  brand: BrandConfig,
  mode: JudgeMode,
): string {
  const citationUrls = result.citations.map((c) => c.url);
  const searchResultUrls = result.searchResults.map((sr) => sr.url);
  const allUrls = [...new Set([...citationUrls, ...searchResultUrls])];

  const parts: string[] = [];

  parts.push("## Brand Profile");
  parts.push(`Name: ${brand.name}`);
  parts.push(`Aliases: ${brand.aliases.join(", ") || "(none)"}`);
  parts.push(`Owned domains: ${brand.ownedDomains.join(", ") || "(none)"}`);
  if (brand.groundTruthDescription) {
    parts.push(`Ground truth description: ${brand.groundTruthDescription}`);
  }
  parts.push(
    `Known competitors: ${brand.knownCompetitors.join(", ") || "(none)"}`,
  );

  parts.push("");
  parts.push("## AI Response to Analyze");
  parts.push(`Prompt: ${result.prompt}`);
  parts.push(`Provider: ${result.metadata.provider}`);
  parts.push(`Model: ${result.metadata.model}`);
  parts.push("");
  parts.push("### Response Text");
  parts.push(result.responseText);
  parts.push("");
  parts.push("### URLs Referenced");
  parts.push(allUrls.length > 0 ? allUrls.join("\n") : "(none)");

  parts.push("");
  parts.push("## Instructions");

  if (mode === "full") {
    parts.push(`Analyze this response for:

1. **Brand Mention**: Is "${brand.name}" (or any alias: ${brand.aliases.join(", ")}) mentioned in the response text?
   - Count all mentions (including aliases)
   - Extract up to 3 short verbatim excerpts (1-2 sentences each) where the brand appears

2. **Description Accuracy**: If the brand IS mentioned, rate how accurately it is described on a 1-5 scale:
   - 1 = Completely wrong or misleading description
   - 2 = Mostly wrong with minor correct elements
   - 3 = Partially correct but missing key aspects or has errors
   - 4 = Mostly accurate with minor omissions
   - 5 = Perfectly accurate description
   Provide reasoning for your score. If the brand is NOT mentioned, set descriptionAccuracy to null.

3. **Owned Citation**: Are any of the brand's owned domains (${brand.ownedDomains.join(", ")}) present in the URLs?

4. **Competitive Position**: Which competitor tools/platforms are mentioned?
   - List each known competitor and whether they appear
   - Also note any other competitor-like tools not in the known list
   - Rank the brand's position: 1 = primary recommendation, 2 = secondary, 3 = tertiary, "not_ranked" = mentioned but not ranked or not mentioned

5. **Mention Hypothesis**: If the brand IS mentioned, briefly hypothesize why (e.g., "directly relevant to the query", "listed as a competitor"). If NOT mentioned, hypothesize why it was omitted (e.g., "query not related to brand's domain", "competitors favored"). Set to null only if analysis is inconclusive.`);
  } else {
    parts.push(`The brand was NOT found in the response text via pre-screening. Analyze only competitive positioning:

1. **Competitive Position**: Which competitor tools/platforms are mentioned?
   - List each known competitor and whether they appear
   - Note any other competitor-like tools
   - Brand rank should be "not_ranked" since it is not mentioned

2. **Mention Hypothesis**: Briefly hypothesize why the brand was not mentioned.

For brand mention fields, use: mentioned=false, mentionCount=0, excerpts=[].
For descriptionAccuracy, use null.
Check the URLs for owned domain citations (the brand may be cited without being mentioned in text).`);
  }

  return parts.join("\n");
}
