import assert from "node:assert/strict";
import test from "node:test";
import * as contracts from "../src/suites/contracts.mjs";
import {
  assertFixtureContract,
  assertHeadToHeadContract,
  assertPreMatchOddsContract,
  assertSavedPredictionContract,
} from "../src/suites/contracts.mjs";
import { createClient } from "../src/http.mjs";

function validOddsHistory() {
  return {
    query: { league: "all", team: null, from: "2026-05-21", to: "2026-08-21", page: 1, pageSize: 30 },
    teams: [
      { key: "J1:292", leagueCode: "J1", id: 292, name: "FC 도쿄" },
      { key: "J1:301", leagueCode: "J1", id: 301, name: "제프 유나이티드 지바" },
    ],
    records: [{
      sourceKey: "G101:260098:5345",
      round: "260098",
      matchSeq: "5345",
      leagueCode: "J1",
      leagueName: "J리그1",
      kickoffAt: "2026-08-21T19:30:00+09:00",
      date: "2026-08-21",
      homeTeamId: 292,
      awayTeamId: 301,
      homeTeam: "FC 도쿄",
      awayTeam: "제프 유나이티드 지바",
      betmanHomeTeam: "FC도쿄",
      betmanAwayTeam: "제프 유나이티드",
      score: { home: 2, away: 1 },
      result: "H",
      odds: { home: 2.1, draw: 3.2, away: 3.4 },
      finalizedAt: "2026-08-21T14:00:00.000Z",
    }],
    pagination: { page: 1, pageSize: 30, total: 1, totalPages: 1 },
    excludedCounts: { cancelled: 0, pendingResult: 0, missingOdds: 0, teamMatchFailed: 0 },
    archive: {
      pendingRounds: 0,
      cooldownPendingRounds: 0,
      errorRounds: 0,
      nextPendingRetryAt: null,
      lastSuccessfulSyncAt: "2026-08-21T14:00:00.000Z",
    },
  };
}

function historyRecord(overrides = {}) {
  const record = { ...validOddsHistory().records[0], ...overrides };
  if (!("sourceKey" in overrides)) record.sourceKey = `G101:${record.round}:${record.matchSeq}`;
  return record;
}

function historyWithRecords(records, overrides = {}) {
  const base = validOddsHistory();
  return {
    ...base,
    ...overrides,
    records,
    pagination: {
      ...base.pagination,
      total: records.length,
      totalPages: records.length === 0 ? 0 : 1,
      ...overrides.pagination,
    },
  };
}

test("validates the exact stored odds history GET response contract", () => {
  assert.equal(typeof contracts.assertOddsHistoryContract, "function", "assertOddsHistoryContract must be exported");
  assert.doesNotThrow(() => contracts.assertOddsHistoryContract(validOddsHistory()));
  assert.throws(() => contracts.assertOddsHistoryContract({ ...validOddsHistory(), unexpected: true }), /keys|shape/i);
  assert.throws(() => contracts.assertOddsHistoryContract({
    ...validOddsHistory(),
    query: { ...validOddsHistory().query, pageSize: 25 },
  }), /page size/i);
});

test("rejects non-final or incomplete odds history records", () => {
  assert.equal(typeof contracts.assertOddsHistoryContract, "function", "assertOddsHistoryContract must be exported");
  const payload = validOddsHistory();
  const invalidRecord = (changes) => ({ ...payload, records: [{ ...payload.records[0], ...changes }] });

  assert.throws(() => contracts.assertOddsHistoryContract(invalidRecord({ leagueCode: "K2" })), /league/i);
  assert.throws(() => contracts.assertOddsHistoryContract(invalidRecord({ result: "PENDING" })), /final result/i);
  assert.throws(() => contracts.assertOddsHistoryContract(invalidRecord({ odds: { home: 0, draw: 3.2, away: 3.4 } })), /positive final odds/i);
  assert.throws(() => contracts.assertOddsHistoryContract(invalidRecord({ betmanAwayTeam: "" })), /canonical and raw team names/i);
  assert.throws(() => contracts.assertOddsHistoryContract(invalidRecord({ score: { home: 2, away: 1, extra: 0 } })), /keys|shape/i);
});

test("rejects invalid odds history values across query, teams, records, pagination, exclusions, and archive", () => {
  const invalidCases = [
    [{ query: { ...validOddsHistory().query, team: "J1:not-an-id" } }, /query team/i],
    [{ teams: [{ ...validOddsHistory().teams[0], key: "K1:292" }, validOddsHistory().teams[1]] }, /team key/i],
    [{ records: [{ ...validOddsHistory().records[0], score: { home: "2", away: 1 } }] }, /score home/i],
    [{ records: [{ ...validOddsHistory().records[0], finalizedAt: "not-a-timestamp" }] }, /finalizedAt/i],
    [{ pagination: { ...validOddsHistory().pagination, total: -1 } }, /pagination total/i],
    [{ pagination: { ...validOddsHistory().pagination, total: 2, totalPages: 1 } }, /record count/i],
    [{ excludedCounts: { ...validOddsHistory().excludedCounts, cancelled: -1 } }, /excluded.*cancelled/i],
    [{ archive: { ...validOddsHistory().archive, nextPendingRetryAt: "2026-02-30T00:00:00.000Z" } }, /nextPendingRetryAt/i],
    [{ archive: { ...validOddsHistory().archive, nextPendingRetryAt: "2026-08-21T15:00:00.000Z" } }, /retry timestamp/i],
  ];

  for (const [changes, pattern] of invalidCases) {
    assert.throws(() => contracts.assertOddsHistoryContract({ ...validOddsHistory(), ...changes }), pattern);
  }
});

test("enforces the producer's clamped one-calendar-year query boundary", () => {
  const overYear = {
    ...validOddsHistory(),
    query: { ...validOddsHistory().query, from: "2024-02-29", to: "2025-03-01" },
  };
  assert.throws(() => contracts.assertOddsHistoryContract(overYear), /one calendar year/i);

  const clampedBoundaryRecord = historyRecord({
    kickoffAt: "2025-02-28T19:30:00+09:00",
    date: "2025-02-28",
    finalizedAt: "2025-02-28T11:00:00.000Z",
  });
  const clampedBoundary = historyWithRecords([clampedBoundaryRecord], {
    query: { ...validOddsHistory().query, from: "2024-02-29", to: "2025-02-28" },
  });
  assert.doesNotThrow(() => contracts.assertOddsHistoryContract(clampedBoundary));
});

test("rejects odds history records outside their query, league, team, Korean kickoff, and finalization constraints", () => {
  const base = validOddsHistory();
  const invalidCases = [
    [{
      query: { ...base.query, league: "K1" },
      teams: [
        { key: "K1:1", leagueCode: "K1", id: 1, name: "K1 Home" },
        { key: "K1:2", leagueCode: "K1", id: 2, name: "K1 Away" },
      ],
    }, /record league/i],
    [{
      query: { ...base.query, from: "2026-08-20", to: "2026-08-21" },
      records: [historyRecord({ kickoffAt: "2026-08-19T19:30:00+09:00", date: "2026-08-19" })],
    }, /record date.*query/i],
    [{
      query: { ...base.query, team: "J1:292" },
      records: [historyRecord({ homeTeamId: 301, awayTeamId: 302 })],
    }, /record team.*query/i],
    [{ records: [historyRecord({ kickoffAt: "2026-08-21T10:30:00Z" })] }, /Korean.*kickoff/i],
    [{ records: [historyRecord({ finalizedAt: "2026-08-21T10:29:59.999Z" })] }, /finalizedAt.*kickoff/i],
  ];

  for (const [changes, pattern] of invalidCases) {
    assert.throws(() => contracts.assertOddsHistoryContract({ ...base, ...changes }), pattern);
  }
});

test("rejects duplicate source keys and producer-inconsistent record ordering", () => {
  const duplicate = historyRecord();
  assert.throws(
    () => contracts.assertOddsHistoryContract(historyWithRecords([duplicate, { ...duplicate }])),
    /source key.*unique/i,
  );

  const outOfOrderCases = [
    [
      historyRecord({ round: "260099", matchSeq: "1", kickoffAt: "2026-08-20T19:30:00+09:00", date: "2026-08-20" }),
      historyRecord({ round: "260098", matchSeq: "1" }),
    ],
    [
      historyRecord({ round: "10", matchSeq: "1" }),
      historyRecord({ round: "9", matchSeq: "1" }),
    ],
    [
      historyRecord({ matchSeq: "10" }),
      historyRecord({ matchSeq: "9" }),
    ],
  ];

  for (const records of outOfOrderCases) {
    assert.throws(() => contracts.assertOddsHistoryContract(historyWithRecords(records)), /record order/i);
  }
});

test("accepts an empty result page with nullable archive timestamps", () => {
  const payload = historyWithRecords([], {
    archive: {
      pendingRounds: 0,
      cooldownPendingRounds: 0,
      errorRounds: 0,
      nextPendingRetryAt: null,
      lastSuccessfulSyncAt: null,
    },
  });
  assert.doesNotThrow(() => contracts.assertOddsHistoryContract(payload));
});

function validFixturesForTransport() {
  const j1 = Array.from({ length: 20 }, (_, index) => ({
    rank: index + 1,
    teamId: index + 1,
    team: `J1 Team ${index + 1}`,
    teamCode: `J1-${index + 1}`,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    points: 0,
    goalsFor: 0,
    goalsAgainst: 0,
  }));
  return {
    source: "API-Football",
    today: "2026-08-21",
    rangeEnd: "2026-09-04",
    statsThrough: "2026-08-20",
    leagues: [
      { id: 292, code: "K1", name: "K League 1", apiName: "K League 1", season: 2026 },
      { id: 98, code: "J1", name: "J1 League", apiName: "J1 League", season: 2027 },
    ],
    matches: [],
    standingsByLeague: { K1: [], J1: j1 },
  };
}

async function withInterceptedFetch(handler, operation) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => handler(new Request(input, init));
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("contracts suite uses GET transport for stored odds history and never requests sync", async () => {
  const requests = [];
  const report = {
    check: async (_suite, _name, operation) => operation(),
    skip: () => undefined,
  };
  const responses = new Map([
    ["/api/fixtures", validFixturesForTransport()],
    ["/api/betman-odds", { configured: false, fixtures: [] }],
    ["/api/odds-history", validOddsHistory()],
    ["/api/market-predictions", { predictions: [] }],
  ]);

  await withInterceptedFetch(async (request) => {
    requests.push(request);
    const body = responses.get(new URL(request.url).pathname);
    assert.notEqual(body, undefined, `unexpected request: ${request.url}`);
    return Response.json(body);
  }, async () => {
    const client = createClient({ baseUrl: "https://harness.test", timeoutMs: 15_000 });
    await contracts.runContracts({ client, config: {}, report, state: {} });
  });

  assert.equal(requests.every((request) => request.method === "GET"), true);
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    "/api/fixtures",
    "/api/betman-odds",
    "/api/odds-history",
    "/api/market-predictions",
  ]);
  assert.equal(requests.some((request) => new URL(request.url).pathname === "/api/odds-history/sync"), false);
});

function validSavedPrediction() {
  return {
    predictionKey: "fixture:1507028|round:260095|game:1654",
    matchId: 1507028,
    matchDate: "2026-08-15",
    kickoffTime: "19:30",
    homeTeam: "광주 FC",
    awayTeam: "포항 스틸러스",
    marketIndex: 0,
    marketType: "축구 승무패",
    marketCondition: "",
    betmanRound: "260095",
    matchSeq: "1654",
    options: [
      { label: "승", odds: 2.2, probability: 0.5, expectedReturn: 0.1 },
      { label: "패", odds: 2.8, probability: 0.5, expectedReturn: 0.4 },
    ],
    probabilitySum: 1,
    savedAt: "2026-08-13T01:00:00.000Z",
  };
}

test("신규 저장 내역의 안정적인 시장 식별자를 검증한다", () => {
  assert.doesNotThrow(() => assertSavedPredictionContract(validSavedPrediction()));
  assert.throws(() => assertSavedPredictionContract({ ...validSavedPrediction(), matchSeq: null }), /betmanRound.*matchSeq/);
});

test("accepts K1 and J1 fixture metadata with standings separated by league", () => {
  const j1Standings = Array.from({ length: 20 }, (_, index) => ({
    rank: index + 1,
    teamId: 100 + index,
    team: `J1 Team ${index + 1}`,
    teamCode: `J1-${index + 1}`,
    played: 1,
    won: index === 0 ? 1 : 0,
    drawn: 0,
    lost: index === 0 ? 0 : 1,
    points: index === 0 ? 3 : 0,
    goalsFor: index === 0 ? 1 : 0,
    goalsAgainst: index === 0 ? 0 : 1,
  }));
  const payload = {
    source: "API-Football",
    today: "2026-08-13",
    rangeEnd: "2026-08-27",
    statsThrough: "2026-08-12",
    leagues: [
      { id: 292, code: "K1", name: "K League 1", apiName: "K League 1", season: 2026 },
      { id: 98, code: "J1", name: "J1 League", apiName: "J1 League", season: 2027 },
    ],
    matches: [
      { id: 29201, leagueCode: "K1", date: "2026-08-15", home: "Home", away: "Away", homeRank: 1, awayRank: 2 },
      { id: 9801, leagueCode: "J1", date: "2026-08-16", home: "Home", away: "Away", homeRank: 1, awayRank: 2 },
    ],
    standingsByLeague: {
      K1: [{ rank: 1, teamId: 1, team: "K1 Home", teamCode: "K1H", played: 1, won: 1, drawn: 0, lost: 0, points: 3, goalsFor: 2, goalsAgainst: 0 }],
      J1: j1Standings,
    },
  };

  assert.doesNotThrow(() => assertFixtureContract(payload));
  assert.throws(() => assertFixtureContract({ ...payload, matches: [{ ...payload.matches[0], leagueCode: "EPL" }] }), /league/i);
  assert.throws(() => assertFixtureContract({
    ...payload,
    leagues: payload.leagues.map((league) => league.code === "J1" ? { ...league, season: 2026 } : league),
  }), /J1.*2027/);
  assert.throws(() => assertFixtureContract({
    ...payload,
    standingsByLeague: { ...payload.standingsByLeague, J1: j1Standings.slice(0, 19) },
  }), /J1.*20/);
  assert.throws(() => assertFixtureContract({
    ...payload,
    standingsByLeague: { ...payload.standingsByLeague, J1: j1Standings.map((row, index) => index === 19 ? { ...row, teamId: 100 } : row) },
  }), /duplicate.*team/i);
  assert.throws(() => assertFixtureContract({
    ...payload,
    standingsByLeague: { ...payload.standingsByLeague, J1: [j1Standings[1], j1Standings[0], ...j1Standings.slice(2)] },
  }), /official rank order/i);
});

test("rejects fixture metadata when K1 and J1 league IDs are swapped", () => {
  const swappedLeagueIds = {
    source: "API-Football",
    today: "2026-08-13",
    rangeEnd: "2026-08-27",
    statsThrough: "2026-08-12",
    leagues: [
      { id: 98, code: "K1", name: "K League 1", apiName: "K League 1", season: 2026 },
      { id: 292, code: "J1", name: "J1 League", apiName: "J1 League", season: 2027 },
    ],
    matches: [],
    standingsByLeague: {},
  };

  assert.throws(() => assertFixtureContract(swappedLeagueIds), /K1.*292/);
});

test("accepts an empty pre-match odds response and rejects invalid offered odds", () => {
  const empty = { fixtureId: 1507031, fetchedAt: "2026-08-13T01:00:00.000Z", cacheSeconds: 1800, bookmakers: [] };
  assert.doesNotThrow(() => assertPreMatchOddsContract(empty, 1507031));

  const invalidOdds = {
    ...empty,
    bookmakers: [{ id: 1, name: "Bookmaker", markets: [{ id: 2, name: "Winner", values: [{ label: "Home", odds: 0 }] }] }],
  };
  assert.throws(() => assertPreMatchOddsContract(invalidOdds, 1507031), /odds/i);
});

test("accepts a selected fixture head-to-head response contract", () => {
  const payload = {
    fixtureId: 1507031,
    fetchedAt: "2026-08-13T01:00:00.000Z",
    cacheSeconds: 1800,
    matches: [
      ["2026.05.13", true, "0–0", "D"],
      ["2026.03.01", false, "2–1", "L"],
    ],
  };

  assert.doesNotThrow(() => assertHeadToHeadContract(payload, 1507031, "2026-08-16T10:00:00.000Z"));
});

test("rejects invalid selected fixture head-to-head responses", () => {
  const payload = {
    fixtureId: 1507031,
    fetchedAt: "2026-08-13T01:00:00.000Z",
    cacheSeconds: 1800,
    matches: [["2026.05.13", true, "0–0", "D"]],
  };
  const assertInvalid = (overrides, pattern) => assert.throws(
    () => assertHeadToHeadContract({ ...payload, ...overrides }, 1507031, "2026-08-16T10:00:00.000Z"),
    pattern,
  );

  assertInvalid({ fixtureId: 1 }, /fixtureId/i);
  assertInvalid({ fetchedAt: "invalid" }, /fetchedAt/i);
  assertInvalid({ fetchedAt: "2026-02-30T01:00:00.000Z" }, /fetchedAt/i);
  assertInvalid({ cacheSeconds: 1799 }, /cacheSeconds/i);
  assertInvalid({ matches: Array.from({ length: 11 }, () => payload.matches[0]) }, /ten|10/i);
  assertInvalid({ matches: [["2026.05.13", true, "0–0"]] }, /tuple|four|4/i);
  assertInvalid({ matches: [["2026-05-13", true, "0–0", "D"]] }, /date/i);
  assertInvalid({ matches: [["2026.05.13", "true", "0–0", "D"]] }, /home|boolean/i);
  assertInvalid({ matches: [["2026.05.13", true, "none", "D"]] }, /score/i);
  assertInvalid({ matches: [["2026.05.13", true, "0-0", "D"]] }, /score/i);
  assertInvalid({ matches: [["2026.05.13", true, "0–0", "X"]] }, /result/i);
  assertInvalid({ matches: [["2026.08.16", true, "0–0", "D"]] }, /kickoff|historical|before/i);
});

test("두 안정 식별자가 모두 없는 기존 저장 내역은 허용한다", () => {
  assert.doesNotThrow(() => assertSavedPredictionContract({
    ...validSavedPrediction(),
    predictionKey: "match:1507028|광주 FC_vs_포항 스틸러스|market:축구 승무패|",
    betmanRound: null,
    matchSeq: null,
  }));
});

test("저장 옵션의 잘못된 숫자와 확률합을 거부한다", () => {
  const invalidOdds = validSavedPrediction();
  invalidOdds.options[0].odds = 0;
  assert.throws(() => assertSavedPredictionContract(invalidOdds), /배당/);
  assert.throws(() => assertSavedPredictionContract({ ...validSavedPrediction(), probabilitySum: 0.8 }), /확률합/);
});
