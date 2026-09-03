import type { BetmanFixture } from "./betman-parser.ts";
import type { LeagueCode } from "./leagues.ts";
import { teamIdForAlias } from "./team-aliases.ts";

export { teamIdForAlias } from "./team-aliases.ts";

export type MatchForBetmanFixture = {
  leagueCode: LeagueCode;
  date: string;
  kickoffAt: string;
  homeTeamId: number;
  awayTeamId: number;
};

function normalizeLeague(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("en").replace(/[\s\p{P}]/gu, "");
}

export function canonicalLeague(value: string): LeagueCode | null {
  const normalized = normalizeLeague(value);
  if (["k1", "kleague1", "k리그1", "한국k리그1"].includes(normalized)) return "K1";
  if (["j1", "j1league", "j리그", "j리그1", "일본j리그", "일본j리그1", "일본j1리그"].includes(normalized)) return "J1";
  return null;
}

function kickoffDifferenceInMinutes(first: string, second: string) {
  const firstTime = Date.parse(first);
  const secondTime = Date.parse(second);
  if (!Number.isFinite(firstTime) || !Number.isFinite(secondTime)) return Number.POSITIVE_INFINITY;
  return Math.abs(firstTime - secondTime) / 60_000;
}

function matchesFixture(match: MatchForBetmanFixture, fixture: BetmanFixture) {
  if (canonicalLeague(fixture.leagueName) !== match.leagueCode || fixture.date !== match.date) return false;
  if (kickoffDifferenceInMinutes(match.kickoffAt, fixture.kickoffAt) > 15) return false;
  return teamIdForAlias(match.leagueCode, fixture.homeTeam) === match.homeTeamId
    && teamIdForAlias(match.leagueCode, fixture.awayTeam) === match.awayTeamId;
}

export function findBetmanFixture(
  match: MatchForBetmanFixture,
  fixtures: readonly BetmanFixture[],
): BetmanFixture | undefined {
  const matches = fixtures.filter((fixture) => matchesFixture(match, fixture));
  return matches.length === 1 ? matches[0] : undefined;
}
