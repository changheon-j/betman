import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSyncCursor,
  defaultHistoryRange,
  encodeSyncCursor,
  historyQueryString,
  parseOddsHistoryQuery,
  parseSyncBody,
} from "../app/lib/odds-history-contract.ts";
import { teamIdentityForAlias, teamsForLeague } from "../app/lib/team-aliases.ts";

test("three-month defaults clamp month ends in Asia/Seoul", () => {
  assert.deepEqual(defaultHistoryRange(new Date("2024-05-31T03:00:00Z")), {
    from: "2024-02-29",
    to: "2024-05-31",
  });
});

test("query rejects impossible, reversed, and over-one-year ranges", () => {
  for (const url of [
    "http://local/api/odds-history?from=2026-02-30&to=2026-03-01",
    "http://local/api/odds-history?from=2026-08-22&to=2026-08-21",
    "http://local/api/odds-history?from=2025-08-20&to=2026-08-21",
  ]) {
    assert.throws(() => parseOddsHistoryQuery(new URL(url)), /INVALID_DATE|INVALID_DATE_RANGE/);
  }
});

test("query rejects year zero and applies Gregorian leap years below 100", () => {
  assert.throws(() => parseOddsHistoryQuery(new URL("http://local/api/odds-history?from=0000-02-28&to=0000-02-28")), /INVALID_DATE/);
  assert.throws(() => parseOddsHistoryQuery(new URL("http://local/api/odds-history?from=0100-02-29&to=0100-03-01")), /INVALID_DATE/);
  assert.equal(parseOddsHistoryQuery(new URL("http://local/api/odds-history?from=0096-02-29&to=0096-03-01")).from, "0096-02-29");
});

test("query validates team keys against league-scoped canonical teams", () => {
  const parsed = parseOddsHistoryQuery(new URL("http://local/api/odds-history?league=J1&team=J1%3A292&from=2026-08-20&to=2026-08-21&page=2"));
  assert.deepEqual(parsed, { league: "J1", team: "J1:292", from: "2026-08-20", to: "2026-08-21", page: 2, pageSize: 30 });
  assert.throws(() => parseOddsHistoryQuery(new URL("http://local/api/odds-history?league=K1&team=J1%3A292&from=2026-08-20&to=2026-08-21")), /INVALID_TEAM/);
  assert.throws(() => parseOddsHistoryQuery(new URL("http://local/api/odds-history?team=J1%3A999&from=2026-08-20&to=2026-08-21")), /INVALID_TEAM/);
});

test("team keys remain league scoped", () => {
  assert.equal(teamIdentityForAlias("J1", "FC도쿄")?.key, "J1:292");
  assert.equal(teamIdentityForAlias("J1", "가시마 시"), null);
  assert.ok(teamsForLeague("K1").every((team) => team.leagueCode === "K1"));
  assert.deepEqual(teamsForLeague("all").map((team) => team.leagueCode), [...teamsForLeague("all")].map((team) => team.leagueCode).sort());
});

test("sync body accepts only complete date ranges and a string cursor", () => {
  assert.deepEqual(parseSyncBody({ from: "2026-08-20", to: "2026-08-21", cursor: null }), { from: "2026-08-20", to: "2026-08-21", cursor: null });
  assert.throws(() => parseSyncBody({ from: "2026-08-20" }), /INVALID_DATE/);
  assert.throws(() => parseSyncBody({ from: "2026-08-20", to: "2026-08-21", cursor: 1 }), /INVALID_CURSOR/);
});

test("cursor binds structure, range, expiry, and discovered round order", () => {
  const now = new Date("2026-08-21T00:00:00Z");
  const cursor = encodeSyncCursor({
    version: 1,
    from: "2026-05-21",
    to: "2026-08-21",
    roundKeys: ["G101:2", "G101:1"],
    nextIndex: 1,
    issuedAt: now.toISOString(),
  });
  assert.equal(decodeSyncCursor(cursor, { from: "2026-05-21", to: "2026-08-21" }, ["G101:2", "G101:1"], now).nextIndex, 1);
  assert.throws(() => decodeSyncCursor(cursor, { from: "2026-05-20", to: "2026-08-21" }, ["G101:2", "G101:1"], now), /INVALID_CURSOR/);
  assert.throws(() => decodeSyncCursor(cursor, { from: "2026-05-21", to: "2026-08-21" }, ["G101:1"], now), /INVALID_CURSOR/);
  assert.throws(() => decodeSyncCursor(cursor, { from: "2026-05-21", to: "2026-08-21" }, ["G101:1", "G101:2"], now), /INVALID_CURSOR/);
  assert.throws(() => decodeSyncCursor(cursor, { from: "2026-05-21", to: "2026-08-21" }, ["G101:2", "G101:1"], new Date("2026-08-21T00:30:00.001Z")), /INVALID_CURSOR/);
  assert.throws(() => decodeSyncCursor("not-base64", { from: "2026-05-21", to: "2026-08-21" }, ["G101:2", "G101:1"], now), /INVALID_CURSOR/);
});

test("cursor accepts only validated cumulative sync progress", () => {
  const now = new Date("2026-08-21T00:00:00Z");
  const base = {
    version: 1 as const,
    from: "2026-05-21",
    to: "2026-08-21",
    roundKeys: ["G101:2", "G101:1"],
    nextIndex: 1,
    issuedAt: now.toISOString(),
  };
  const cursor = encodeSyncCursor({
    ...base,
    progress: {
      remainingUnresolvedRounds: 2,
      deferredPendingRounds: 1,
      nextPendingRetryAt: "2026-08-21T00:30:00.000Z",
      hadPartial: true,
    },
  });
  assert.deepEqual(
    decodeSyncCursor(cursor, { from: base.from, to: base.to }, base.roundKeys, now).progress,
    {
      remainingUnresolvedRounds: 2,
      deferredPendingRounds: 1,
      nextPendingRetryAt: "2026-08-21T00:30:00.000Z",
      hadPartial: true,
    },
  );
  const malformed = encodeSyncCursor({
    ...base,
    progress: {
      remainingUnresolvedRounds: 2,
      deferredPendingRounds: 1,
      nextPendingRetryAt: null,
      hadPartial: "yes",
    },
  } as never);
  assert.throws(() => decodeSyncCursor(malformed, { from: base.from, to: base.to }, base.roundKeys, now), /INVALID_CURSOR/);
});

test("history query string preserves the supported filter parameters", () => {
  assert.equal(historyQueryString({ league: "J1", team: "J1:292", from: "2026-08-20", to: "2026-08-21", page: 3, pageSize: 30 }), "league=J1&from=2026-08-20&to=2026-08-21&page=3&team=J1%3A292");
});
