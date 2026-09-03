import type { ParsedClosedRound } from "./betman-history-types.ts";

export type BetmanHistorySmokeSummary = {
  roundKey: string | null;
  eventFrom: string | null;
  eventTo: string | null;
  providerFinal: boolean | null;
  candidateCount: number;
  fetchedAt: string | null;
};

export function betmanHistorySmokeSummary(parsed: ParsedClosedRound | null): BetmanHistorySmokeSummary {
  if (!parsed) {
    return {
      roundKey: null,
      eventFrom: null,
      eventTo: null,
      providerFinal: null,
      candidateCount: 0,
      fetchedAt: null,
    };
  }
  return {
    roundKey: `${parsed.round.gmId}:${parsed.round.gmTs}`,
    eventFrom: parsed.eventFrom,
    eventTo: parsed.eventTo,
    providerFinal: parsed.providerFinal,
    candidateCount: parsed.matches.length,
    fetchedAt: parsed.fetchedAt,
  };
}
