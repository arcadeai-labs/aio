// Movers (tier-1 structured): interprets the week's biggest positive and
// negative shifts — mentions, accuracy, owned citations, brand rank, and
// competitor movement — absorbing "wins" and "blockers" as positively /
// negatively-signed movers. Grounded in `comparison-<date>.json`; may report
// `nothing_notable`.

import type { Learning } from "@aio/core";
import { buildMoversContext, loadComparison } from "../context.js";
import { runStructuredGenerator } from "../harness.js";
import type { GeneratorRunContext } from "../registry.js";
import type { MoversContext } from "../types.js";

export const MOVERS_SLUG = "movers";

function fmt(n: number | null): string {
  if (n === null) return "n/a";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function signed(n: number | null): string {
  if (n === null) return "n/a";
  const r = Number.isInteger(n) ? String(Math.abs(n)) : Math.abs(n).toFixed(2);
  return n > 0 ? `+${r}` : n < 0 ? `-${r}` : "0";
}

export function buildMoversSystemPrompt(brandName: string): string {
  return `You are a brand-presence analyst interpreting one week's change in how AI search engines talk about "${brandName}".

You are given a pre-computed, week-over-week comparison. Your job is to interpret it: explain the most significant POSITIVE shifts (wins) and NEGATIVE shifts (blockers) as a single set of signed "movers". Do not restate every number — surface what moved and what it means.

Hard rules:
- Ground every claim in the provided data. Cite specific figures as evidence; never invent numbers.
- Each evidence item's "source" MUST be the provided source filename.
- "value" and "delta" are short display strings (e.g. value "1180", delta "+13"); use delta "" when a figure has no week-over-week change to report.
- Set confidence: "high" when several metrics move the same direction by a clear margin; "medium" for a mixed or modest picture; "low" when signals are small or conflicting.
- If nothing moved meaningfully this week, return status "nothing_notable" with a brief body and no manufactured findings.
- headline: one tight sentence. body: 2-4 sentences of interpretation, leading with the biggest mover.`;
}

export function buildMoversUserPrompt(ctx: MoversContext): string {
  const parts: string[] = [];

  parts.push(`## Comparison: ${ctx.previousDate} → ${ctx.currentDate}`);
  parts.push(`Source filename (use as evidence source): ${ctx.source}`);
  parts.push(`Total results compared: ${ctx.totalResults}`);

  parts.push("");
  parts.push("## Headline metric moves (prev → curr, delta)");
  for (const m of ctx.metrics) {
    parts.push(
      `- ${m.label}: ${fmt(m.prev)} → ${fmt(m.curr)} (${signed(m.delta)})`,
    );
  }

  parts.push("");
  parts.push("## Per-result event tallies (this run)");
  const t = ctx.tallies;
  parts.push(`- New brand mentions: ${t.newMentions}`);
  parts.push(`- Lost brand mentions: ${t.lostMentions}`);
  parts.push(`- Gained owned-domain citations: ${t.gainedOwnedCitations}`);
  parts.push(`- Lost owned-domain citations: ${t.lostOwnedCitations}`);
  parts.push(`- Brand rank improved: ${t.ranksImproved}`);
  parts.push(`- Accuracy gains: ${t.accuracyGains}`);
  parts.push(`- Accuracy drops: ${t.accuracyDrops}`);

  parts.push("");
  parts.push("## Competitors gaining the most mentions");
  parts.push(
    ctx.topGainingCompetitors.length > 0
      ? ctx.topGainingCompetitors
          .map((c) => `- ${c.name}: ${c.prev} → ${c.curr} (${signed(c.delta)})`)
          .join("\n")
      : "- (none)",
  );

  parts.push("");
  parts.push("## Competitors losing the most mentions");
  parts.push(
    ctx.topLosingCompetitors.length > 0
      ? ctx.topLosingCompetitors
          .map((c) => `- ${c.name}: ${c.prev} → ${c.curr} (${signed(c.delta)})`)
          .join("\n")
      : "- (none)",
  );

  if (ctx.notableExamples.length > 0) {
    parts.push("");
    parts.push("## Notable individual examples");
    for (const ex of ctx.notableExamples) {
      parts.push(
        `- [${ex.kind}] ${ex.detail} — "${ex.prompt}" (${ex.provider}/${ex.model})`,
      );
    }
  }

  parts.push("");
  parts.push(
    "Interpret the above into a single Movers learning following the contract.",
  );

  return parts.join("\n");
}

export async function generateMovers(
  ctx: GeneratorRunContext,
): Promise<Learning> {
  const source = `comparison-${ctx.runDate}.json`;
  const comparison = await loadComparison(ctx.outputDir, ctx.runDate);
  const moversContext = buildMoversContext(comparison, source);

  return runStructuredGenerator({
    slug: MOVERS_SLUG,
    tier: "structured",
    runDate: ctx.runDate,
    config: ctx.config,
    client: ctx.client,
    systemPrompt: buildMoversSystemPrompt(ctx.config.brand.name),
    userPrompt: buildMoversUserPrompt(moversContext),
  });
}
