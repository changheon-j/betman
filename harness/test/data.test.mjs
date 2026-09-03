import assert from "node:assert/strict";
import test from "node:test";
import { runData } from "../src/suites/data.mjs";

function fixturesPayload(matches) {
  return {
    today: "2026-08-14",
    rangeEnd: "2026-08-28",
    leagues: [{ code: "K1" }],
    matches,
    standingsByLeague: {
      K1: [
        { rank: 1, teamId: 2763, team: "Home", teamCode: "HOME", played: 1, won: 1, drawn: 0, lost: 0, goalsFor: 2, goalsAgainst: 0, goalDifference: 2 },
        { rank: 2, teamId: 2764, team: "Away", teamCode: "AWAY", played: 1, won: 0, drawn: 0, lost: 1, goalsFor: 0, goalsAgainst: 2, goalDifference: -2 },
      ],
    },
  };
}

function fixture(id = 1507031) {
  return {
    id,
    leagueCode: "K1",
    date: "2026-08-16",
    kickoffAt: "2026-08-16T10:00:00.000Z",
    homeTeamId: 2763,
    awayTeamId: 2764,
    homeCode: "HOME",
    awayCode: "AWAY",
    homeRank: 1,
    awayRank: 2,
  };
}

function reportThatPropagatesFailures() {
  return {
    check: async (_suite, _name, operation) => operation(),
    skip: () => undefined,
  };
}

test("requests head-to-head exactly once for the first fixture", async () => {
  const requests = [];
  const first = fixture();
  const client = {
    json: async (path) => {
      requests.push(path);
      if (path === "/api/fixtures") return { body: fixturesPayload([first, fixture(1507032)]) };
      if (path === "/api/betman-odds") return { body: { configured: false, fixtures: [] } };
      if (path.startsWith("/api/head-to-head?")) return { body: {
        fixtureId: first.id,
        fetchedAt: "2026-08-14T01:00:00.000Z",
        cacheSeconds: 1800,
        matches: [["2026.05.13", true, "0–0", "D"]],
      } };
      throw new Error(`unexpected request: ${path}`);
    },
  };

  await runData({ client, report: reportThatPropagatesFailures(), state: {} });

  const expected = "/api/head-to-head?fixture=1507031&home=2763&away=2764&kickoff=2026-08-16T10%3A00%3A00.000Z";
  assert.equal(requests.filter((path) => path.startsWith("/api/head-to-head?")).length, 1);
  assert.equal(requests.at(-1), expected);
  assert.ok(requests.indexOf(expected) > requests.indexOf("/api/fixtures"));
});

test("does not request head-to-head when fixtures are empty", async () => {
  const requests = [];
  const client = {
    json: async (path) => {
      requests.push(path);
      if (path === "/api/fixtures") return { body: fixturesPayload([]) };
      if (path === "/api/betman-odds") return { body: { configured: false, fixtures: [] } };
      throw new Error(`unexpected request: ${path}`);
    },
  };

  await runData({ client, report: reportThatPropagatesFailures(), state: {} });

  assert.equal(requests.filter((path) => path.startsWith("/api/head-to-head?")).length, 0);
});
