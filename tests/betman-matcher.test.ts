import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalLeague,
  findBetmanFixture,
  teamIdForAlias,
} from "../app/lib/betman-matcher.ts";
import { buildAliasIndex } from "../app/lib/team-aliases.ts";
import type { BetmanFixture } from "../app/lib/betman-parser.ts";

const match = {
  leagueCode: "J1" as const,
  date: "2026-08-15",
  kickoffAt: "2026-08-15T19:00:00+09:00",
  homeTeamId: 290,
  awayTeamId: 292,
};

function fixture(overrides: Partial<BetmanFixture> = {}): BetmanFixture {
  return {
    key: "fixture",
    date: "2026-08-15",
    kickoffAt: "2026-08-15T19:10:00+09:00",
    leagueName: "일본 J리그",
    homeTeam: "가시마 앤틀러스",
    awayTeam: "FC도쿄",
    homeKey: "가시마",
    awayKey: "fctokyo",
    markets: [],
    ...overrides,
  };
}

test("recognizes supported Korean and English league names", () => {
  assert.equal(canonicalLeague("J1 League"), "J1");
  assert.equal(canonicalLeague("일본 J리그"), "J1");
  assert.equal(canonicalLeague("일본 J1리그"), "J1");
  assert.equal(canonicalLeague("K리그1"), "K1");
  assert.equal(canonicalLeague("Premier League"), null);
});

test("maps known J1 and retained K1 Betman aliases to API-Football IDs", () => {
  assert.equal(teamIdForAlias("J1", "가시마 앤틀러스"), 290);
  assert.equal(teamIdForAlias("J1", "Kashima"), 290);
  assert.equal(teamIdForAlias("J1", "FC 도쿄"), 292);
  assert.equal(teamIdForAlias("J1", "요코하마 F마리노스"), 296);
  assert.equal(teamIdForAlias("K1", "광주FC"), 2759);
  assert.equal(teamIdForAlias("K1", "FC 서울"), 2766);
  assert.equal(teamIdForAlias("K1", "대구"), 2747);
  assert.equal(teamIdForAlias("K1", "전북 현대모터스"), 2762);
  assert.equal(teamIdForAlias("K1", "부천FC 1995"), 2745);
  assert.equal(teamIdForAlias("K1", "김천상무 프로축구단"), 2768);
  assert.equal(teamIdForAlias("K1", "대전 하나시티즌"), 2750);
  assert.equal(teamIdForAlias("J1", "가시마 시"), null);
});

test("accepts same-team normalized duplicates and rejects cross-team alias collisions", () => {
  const sameTeam = buildAliasIndex([
    [1, ["Shared Alias", "shared-alias"]],
    [1, ["shared alias"]],
  ]);
  assert.equal(sameTeam.get("sharedalias"), 1);

  assert.throws(() => buildAliasIndex([
    [1, ["Shared Alias"]],
    [2, ["shared-alias"]],
  ]), /alias collision.*1.*2/i);
});

test("returns the sole fixture when league, date, kickoff, and team IDs agree", () => {
  const expected = fixture();
  assert.equal(findBetmanFixture(match, [expected]), expected);
});

test("matches Betman's shortened JEF United team name", () => {
  const tokyoMatch = {
    leagueCode: "J1" as const,
    date: "2026-08-21",
    kickoffAt: "2026-08-21T19:30:00+09:00",
    homeTeamId: 292,
    awayTeamId: 301,
  };
  const expected = fixture({
    date: "2026-08-21",
    kickoffAt: "2026-08-21T19:30:00+09:00",
    leagueName: "일본 J1리그",
    homeTeam: "FC도쿄",
    awayTeam: "제프 유나이티드",
  });

  assert.equal(findBetmanFixture(tokyoMatch, [expected]), expected);
});

test("allows a kickoff difference of exactly fifteen minutes", () => {
  const expected = fixture({ kickoffAt: "2026-08-15T19:15:00+09:00" });
  assert.equal(findBetmanFixture(match, [expected]), expected);
});

test("does not match a fixture more than fifteen minutes away", () => {
  assert.equal(findBetmanFixture(match, [fixture({ kickoffAt: "2026-08-15T19:16:00+09:00" })]), undefined);
});

test("does not match a fixture from another league", () => {
  assert.equal(findBetmanFixture(match, [fixture({ leagueName: "K리그1" })]), undefined);
});

test("does not match fixtures with unknown aliases", () => {
  assert.equal(findBetmanFixture(match, [fixture({ homeTeam: "가시마 시" })]), undefined);
});

test("does not choose arbitrarily when multiple fixtures match", () => {
  assert.equal(findBetmanFixture(match, [fixture(), fixture({ key: "duplicate" })]), undefined);
});
