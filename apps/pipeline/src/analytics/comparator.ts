import type {
  BrandRank,
  ResultDelta,
  ResultVerdict,
  WeekComparison,
  WeekComparisonSummary,
} from "./types.js";

function resultKey(v: ResultVerdict): string {
  return `${v.prompt}|||${v.provider}|||${v.model}`;
}

function rankToNumber(rank: BrandRank): number {
  return rank === "not_ranked" ? 4 : rank;
}

export function compareWeeks(
  current: ResultVerdict[],
  previous: ResultVerdict[],
  currentDate: string,
  previousDate: string,
): WeekComparison {
  const prevMap = new Map<string, ResultVerdict>();
  for (const v of previous) {
    prevMap.set(resultKey(v), v);
  }

  const deltas: ResultDelta[] = [];

  for (const curr of current) {
    const prev = prevMap.get(resultKey(curr));
    if (!prev) continue;

    const prevMentioned = prev.brandMention.mentioned;
    const currMentioned = curr.brandMention.mentioned;
    const prevAcc = prev.descriptionAccuracy?.score ?? null;
    const currAcc = curr.descriptionAccuracy?.score ?? null;
    const prevCited = prev.ownedCitation.cited;
    const currCited = curr.ownedCitation.cited;

    const prevCompetitors = new Set(
      prev.competitivePosition.competitors
        .filter((c) => c.mentioned)
        .map((c) => c.name),
    );
    const currCompetitors = new Set(
      curr.competitivePosition.competitors
        .filter((c) => c.mentioned)
        .map((c) => c.name),
    );

    deltas.push({
      prompt: curr.prompt,
      provider: curr.provider,
      model: curr.model,
      newMention: !prevMentioned && currMentioned,
      lostMention: prevMentioned && !currMentioned,
      prevAccuracy: prevAcc,
      currAccuracy: currAcc,
      accuracyDelta:
        prevAcc !== null && currAcc !== null ? currAcc - prevAcc : null,
      gainedOwnedCitation: !prevCited && currCited,
      lostOwnedCitation: prevCited && !currCited,
      prevRank: prev.competitivePosition.brandRank,
      currRank: curr.competitivePosition.brandRank,
      rankImproved:
        rankToNumber(curr.competitivePosition.brandRank) <
        rankToNumber(prev.competitivePosition.brandRank),
      newCompetitors: [...currCompetitors].filter(
        (c) => !prevCompetitors.has(c),
      ),
      departedCompetitors: [...prevCompetitors].filter(
        (c) => !currCompetitors.has(c),
      ),
      mentionHypothesis: curr.mentionHypothesis,
    });
  }

  const summary = buildSummary(current, previous, deltas);

  return {
    currentDate,
    previousDate,
    deltas,
    summary,
  };
}

function buildSummary(
  current: ResultVerdict[],
  previous: ResultVerdict[],
  _deltas: ResultDelta[],
): WeekComparisonSummary {
  const prevMentioned = previous.filter((v) => v.brandMention.mentioned);
  const currMentioned = current.filter((v) => v.brandMention.mentioned);

  const prevAccScores = previous
    .map((v) => v.descriptionAccuracy?.score)
    .filter((s) => s != null) as number[];
  const currAccScores = current
    .map((v) => v.descriptionAccuracy?.score)
    .filter((s) => s != null) as number[];

  const prevCited = previous.filter((v) => v.ownedCitation.cited);
  const currCited = current.filter((v) => v.ownedCitation.cited);

  const prevPrimary = previous.filter(
    (v) => v.competitivePosition.brandRank === 1,
  );
  const currPrimary = current.filter(
    (v) => v.competitivePosition.brandRank === 1,
  );

  const competitorCounts: Record<string, { prev: number; curr: number }> = {};
  for (const v of previous) {
    for (const c of v.competitivePosition.competitors) {
      if (c.mentioned) {
        competitorCounts[c.name] = competitorCounts[c.name] ?? {
          prev: 0,
          curr: 0,
        };
        competitorCounts[c.name].prev++;
      }
    }
  }
  for (const v of current) {
    for (const c of v.competitivePosition.competitors) {
      if (c.mentioned) {
        competitorCounts[c.name] = competitorCounts[c.name] ?? {
          prev: 0,
          curr: 0,
        };
        competitorCounts[c.name].curr++;
      }
    }
  }

  return {
    totalResults: current.length,
    mentionedCount: { prev: prevMentioned.length, curr: currMentioned.length },
    avgAccuracy: {
      prev:
        prevAccScores.length > 0
          ? prevAccScores.reduce((a, b) => a + b, 0) / prevAccScores.length
          : null,
      curr:
        currAccScores.length > 0
          ? currAccScores.reduce((a, b) => a + b, 0) / currAccScores.length
          : null,
    },
    ownedCitationCount: { prev: prevCited.length, curr: currCited.length },
    primaryRankCount: { prev: prevPrimary.length, curr: currPrimary.length },
    competitorCounts,
  };
}
