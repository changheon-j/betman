import assert from "node:assert/strict";
import test from "node:test";
import { buildLeaguePayload, mergeLeaguePayloads } from "../app/lib/fixture-data.ts";
import { SUPPORTED_LEAGUES } from "../app/lib/leagues.ts";

const K1 = SUPPORTED_LEAGUES[0];
const J1 = SUPPORTED_LEAGUES[1];

const kStanding = {
  rank: 2,
  teamId: 2921,
  team: "K Team",
  teamCode: "K Team",
  logo: "k-logo",
  played: 20,
  won: 12,
  drawn: 4,
  lost: 4,
  points: 40,
  goalDifference: 15,
  goalsFor: 32,
  goalsAgainst: 17,
};

const jStanding = {
  rank: 1,
  teamId: 981,
  team: "J Team",
  teamCode: "J Team",
  logo: "j-logo",
  played: 21,
  won: 14,
  drawn: 3,
  lost: 4,
  points: 45,
  goalDifference: 18,
  goalsFor: 38,
  goalsAgainst: 20,
};

const lateMatch = {
  id: 29201,
  leagueId: 292,
  leagueCode: "K1" as const,
  leagueName: "K리그1",
  kickoffAt: "2026-08-16T10:00:00.000Z",
  date: "2026-08-16",
  dateLabel: "8월 16일",
  dateShort: "8/16",
  round: "25R",
  time: "19:00",
  venue: "K Stadium",
  homeTeamId: 2921,
  awayTeamId: 2922,
  home: "K Team",
  away: "K Away",
  homeCode: "K Team",
  awayCode: "K Away",
  homeLogo: "k-logo",
  awayLogo: "ka-logo",
  homeRank: 2,
  awayRank: 3,
  homeForm: ["W"] as Array<"W" | "D" | "L">,
  awayForm: ["L"] as Array<"W" | "D" | "L">,
  homeRecord: "12승 4무 4패",
  awayRecord: "10승 5무 5패",
  homeGoals: "32 / 17",
  awayGoals: "27 / 21",
  homePlayed: 20,
  awayPlayed: 20,
  homeRecentPoints: 3,
  awayRecentPoints: 0,
  recentHome: [],
  recentAway: [],
};

const earlyMatch = {
  ...lateMatch,
  id: 9801,
  leagueId: 98,
  leagueCode: "J1" as const,
  leagueName: "J리그1",
  kickoffAt: "2026-08-15T10:00:00.000Z",
  date: "2026-08-15",
};

test("supports the configured K1 and J1 competitions", () => {
  assert.deepEqual(SUPPORTED_LEAGUES.map(({ id, code }) => ({ id, code })), [
    { id: 292, code: "K1" },
    { id: 98, code: "J1" },
  ]);
});

test("merges fulfilled league payloads in kickoff order with standings by league", () => {
  const merged = mergeLeaguePayloads([
    { status: "fulfilled", league: K1, matches: [lateMatch], standings: [kStanding] },
    { status: "fulfilled", league: J1, matches: [earlyMatch], standings: [jStanding] },
  ]);

  assert.deepEqual(merged.matches.map((match) => match.id), [earlyMatch.id, lateMatch.id]);
  assert.deepEqual(Object.keys(merged.standingsByLeague), ["K1", "J1"]);
  assert.deepEqual(merged.standingsByLeague.J1, [jStanding]);
  assert.equal(Object.hasOwn(merged, "h2hFetchFailures"), false);
  assert.deepEqual(merged.leagueErrors, {});
  assert.deepEqual(merged.leagues.map((league) => league.code), ["K1", "J1"]);
});

test("retains fulfilled data and exposes the failed league error", () => {
  const merged = mergeLeaguePayloads([
    { status: "fulfilled", league: K1, matches: [lateMatch], standings: [kStanding] },
    { status: "rejected", league: J1, reason: new Error("standings unavailable") },
  ]);

  assert.deepEqual(merged.matches.map((match) => match.id), [lateMatch.id]);
  assert.deepEqual(merged.standingsByLeague, { K1: [kStanding] });
  assert.equal(merged.leagueErrors.J1, "standings unavailable");
});

test("builds fixture matches without embedded head-to-head data", () => {
  const upcoming = [{
    fixture: {
      id: 29201,
      date: "2026-08-16T19:00:00+09:00",
      status: { short: "NS" },
      venue: { name: "K Stadium" },
    },
    league: { round: "Regular Season - 25" },
    teams: {
      home: { id: 2921, name: "K Team", logo: "k-logo" },
      away: { id: 2922, name: "K Away", logo: "ka-logo" },
    },
    goals: { home: null, away: null },
  }];
  const officialStandings = [{
    rank: 2,
    team: { id: 2921, name: "K Team", logo: "k-logo" },
    points: 40,
    goalsDiff: 15,
    all: { played: 20, win: 12, draw: 4, lose: 4, goals: { for: 32, against: 17 } },
  }];

  const payload = buildLeaguePayload(K1, upcoming, [], officialStandings);

  assert.equal(payload.matches.length, 1);
  assert.equal(Object.hasOwn(payload.matches[0], "headToHead"), false);
  assert.equal(Object.hasOwn(payload, "h2hFetchFailures"), false);
});
