import type { ResultVerdict, WeekComparison } from "./types.js";

export function generateReport(
  verdicts: ResultVerdict[],
  date: string,
  comparison: WeekComparison | null,
  brandName: string,
): string {
  const lines: string[] = [];

  lines.push(`# ${brandName} Brand Presence Report — ${date}`);
  lines.push("");

  // --- Overview ---
  lines.push("## Overview");
  lines.push("");

  const mentioned = verdicts.filter((v) => v.brandMention.mentioned);
  const accScores = verdicts
    .map((v) => v.descriptionAccuracy?.score)
    .filter((s) => s != null) as number[];
  const avgAcc =
    accScores.length > 0
      ? (accScores.reduce((a, b) => a + b, 0) / accScores.length).toFixed(1)
      : "N/A";
  const cited = verdicts.filter((v) => v.ownedCitation.cited);
  const primaryRank = verdicts.filter(
    (v) => v.competitivePosition.brandRank === 1,
  );

  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Total results analyzed | ${verdicts.length} |`);
  lines.push(
    `| Brand mentioned | ${mentioned.length} (${pct(mentioned.length, verdicts.length)}) |`,
  );
  lines.push(`| Avg accuracy score | ${avgAcc} / 5 |`);
  lines.push(
    `| Owned domain cited | ${cited.length} (${pct(cited.length, verdicts.length)}) |`,
  );
  lines.push(
    `| Primary recommendation (#1) | ${primaryRank.length} (${pct(primaryRank.length, verdicts.length)}) |`,
  );
  lines.push("");

  // --- By Provider ---
  lines.push("## Brand Mentions by Provider");
  lines.push("");
  const byProvider = groupBy(verdicts, (v) => v.provider);
  lines.push("| Provider | Results | Mentioned | Rate | Avg Accuracy |");
  lines.push("|----------|---------|-----------|------|-------------|");
  for (const [provider, group] of sorted(byProvider)) {
    const m = group.filter((v) => v.brandMention.mentioned);
    const acc = group
      .map((v) => v.descriptionAccuracy?.score)
      .filter((s) => s != null) as number[];
    const avg =
      acc.length > 0
        ? (acc.reduce((a, b) => a + b, 0) / acc.length).toFixed(1)
        : "N/A";
    lines.push(
      `| ${provider} | ${group.length} | ${m.length} | ${pct(m.length, group.length)} | ${avg} |`,
    );
  }
  lines.push("");

  // --- By Category ---
  const hasCategories = verdicts.some((v) => v.promptCategory);
  if (hasCategories) {
    lines.push("## Brand Mentions by Prompt Category");
    lines.push("");
    const byCategory = groupBy(
      verdicts,
      (v) => v.promptCategory ?? "uncategorized",
    );
    lines.push("| Category | Results | Mentioned | Rate |");
    lines.push("|----------|---------|-----------|------|");
    for (const [cat, group] of sorted(byCategory)) {
      const m = group.filter((v) => v.brandMention.mentioned);
      lines.push(
        `| ${cat} | ${group.length} | ${m.length} | ${pct(m.length, group.length)} |`,
      );
    }
    lines.push("");
  }

  // --- Competitive Landscape ---
  lines.push("## Competitive Landscape");
  lines.push("");

  const competitorStats = new Map<
    string,
    { mentions: number; citedUrls: Set<string> }
  >();
  for (const v of verdicts) {
    for (const c of v.competitivePosition.competitors) {
      if (!c.mentioned) continue;
      const entry = competitorStats.get(c.name) ?? {
        mentions: 0,
        citedUrls: new Set<string>(),
      };
      entry.mentions++;
      for (const url of c.citedUrls) entry.citedUrls.add(url);
      competitorStats.set(c.name, entry);
    }
  }

  if (competitorStats.size > 0) {
    lines.push("| Competitor | Mentions | Cited URLs |");
    lines.push("|------------|----------|-----------|");
    const sortedCompetitors = [...competitorStats.entries()].sort(
      (a, b) => b[1].mentions - a[1].mentions,
    );
    for (const [name, stats] of sortedCompetitors) {
      const urls =
        stats.citedUrls.size > 0
          ? [...stats.citedUrls].slice(0, 3).join(", ")
          : "-";
      lines.push(`| ${name} | ${stats.mentions} | ${urls} |`);
    }
  } else {
    lines.push("No competitors detected in responses.");
  }
  lines.push("");

  // --- Week-over-week ---
  if (comparison) {
    lines.push("## Week-over-Week Changes");
    lines.push("");
    lines.push(
      `Comparing **${comparison.previousDate}** → **${comparison.currentDate}**`,
    );
    lines.push("");

    const s = comparison.summary;
    lines.push("| Metric | Previous | Current | Change |");
    lines.push("|--------|----------|---------|--------|");
    lines.push(
      `| Mentioned | ${s.mentionedCount.prev} | ${s.mentionedCount.curr} | ${delta(s.mentionedCount.curr - s.mentionedCount.prev)} |`,
    );
    lines.push(
      `| Avg accuracy | ${s.avgAccuracy.prev?.toFixed(1) ?? "N/A"} | ${s.avgAccuracy.curr?.toFixed(1) ?? "N/A"} | ${s.avgAccuracy.prev != null && s.avgAccuracy.curr != null ? delta(s.avgAccuracy.curr - s.avgAccuracy.prev, 1) : "N/A"} |`,
    );
    lines.push(
      `| Owned citations | ${s.ownedCitationCount.prev} | ${s.ownedCitationCount.curr} | ${delta(s.ownedCitationCount.curr - s.ownedCitationCount.prev)} |`,
    );
    lines.push(
      `| Primary rank (#1) | ${s.primaryRankCount.prev} | ${s.primaryRankCount.curr} | ${delta(s.primaryRankCount.curr - s.primaryRankCount.prev)} |`,
    );
    lines.push("");

    const newMentions = comparison.deltas.filter((d) => d.newMention);
    const lostMentions = comparison.deltas.filter((d) => d.lostMention);

    if (newMentions.length > 0) {
      lines.push("### New Mentions");
      lines.push("");
      for (const d of newMentions) {
        lines.push(
          `- **${d.provider}** / ${d.model}: "${truncate(d.prompt, 80)}"`,
        );
      }
      lines.push("");
    }

    if (lostMentions.length > 0) {
      lines.push("### Lost Mentions");
      lines.push("");
      for (const d of lostMentions) {
        lines.push(
          `- **${d.provider}** / ${d.model}: "${truncate(d.prompt, 80)}"`,
        );
      }
      lines.push("");
    }
  }

  // --- Notable Results ---
  lines.push("## Notable Results");
  lines.push("");

  const withAccuracy = verdicts.filter((v) => v.descriptionAccuracy != null);
  if (withAccuracy.length > 0) {
    const sortedByAccuracy = [...withAccuracy].sort(
      (a, b) => a.descriptionAccuracy!.score - b.descriptionAccuracy!.score,
    );

    const worst = sortedByAccuracy.slice(0, 3);
    if (worst.length > 0 && worst[0].descriptionAccuracy!.score < 5) {
      lines.push("### Lowest Accuracy Scores");
      lines.push("");
      for (const v of worst) {
        lines.push(
          `- **${v.descriptionAccuracy!.score}/5** — ${v.provider} / ${v.model}`,
        );
        lines.push(`  - Prompt: "${truncate(v.prompt, 80)}"`);
        lines.push(`  - Reasoning: ${v.descriptionAccuracy!.reasoning}`);
        if (v.brandMention.excerpts.length > 0) {
          lines.push(
            `  - Excerpt: "${truncate(v.brandMention.excerpts[0], 120)}"`,
          );
        }
        lines.push("");
      }
    }

    const best = sortedByAccuracy.slice(-3).reverse();
    if (best.length > 0) {
      lines.push("### Highest Accuracy Scores");
      lines.push("");
      for (const v of best) {
        lines.push(
          `- **${v.descriptionAccuracy!.score}/5** — ${v.provider} / ${v.model}`,
        );
        lines.push(`  - Prompt: "${truncate(v.prompt, 80)}"`);
        lines.push(`  - Reasoning: ${v.descriptionAccuracy!.reasoning}`);
        lines.push("");
      }
    }
  } else {
    lines.push(
      "No results with accuracy scores (brand not mentioned in any response).",
    );
    lines.push("");
  }

  lines.push("---");
  lines.push(`*Generated at ${new Date().toISOString()} by aio analytics*`);
  lines.push("");

  return lines.join("\n");
}

// --- Helpers ---

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

function delta(n: number, decimals = 0): string {
  const formatted = decimals > 0 ? n.toFixed(decimals) : String(n);
  return n > 0 ? `+${formatted}` : formatted;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function groupBy<T>(arr: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of arr) {
    const k = key(item);
    const group = map.get(k) ?? [];
    group.push(item);
    map.set(k, group);
  }
  return map;
}

function sorted<T>(map: Map<string, T>): [string, T][] {
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
