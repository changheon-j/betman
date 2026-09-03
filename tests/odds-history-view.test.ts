import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HistoryTeamOption, OddsHistoryPayload, SyncPayload } from "../app/lib/betman-history-types.ts";
import {
  OddsHistory,
  canGoNext,
  canGoPrevious,
  formatHistoryDate,
  historyTeamsForLeague,
  historyPayloadForQuery,
  mergeHistoryTeamCatalog,
  resultLabel,
  shouldShowHistoryRetry,
  syncStatusText,
} from "../app/odds-history.tsx";

const archive: OddsHistoryPayload["archive"] = {
  pendingRounds: 0,
  cooldownPendingRounds: 0,
  errorRounds: 0,
  nextPendingRetryAt: null,
  lastSuccessfulSyncAt: null,
};

const partialSync: SyncPayload = {
  status: "partial",
  processedRounds: 3,
  maxRoundsPerRequest: 5,
  maxParallelDetails: 2,
  rounds: [],
  hasMore: false,
  nextCursor: null,
  remainingUnresolvedRounds: 2,
  deferredPendingRounds: 1,
  nextPendingRetryAt: "2026-08-21T15:30:00.000Z",
  startedAt: "2026-08-21T15:00:00.000Z",
  finishedAt: "2026-08-21T15:01:00.000Z",
};

function payloadFor(page: number, totalPages: number): OddsHistoryPayload {
  return {
    query: { league: "all", team: null, from: "2026-05-21", to: "2026-08-21", page, pageSize: 30 },
    teams: [],
    records: [],
    pagination: { page, pageSize: 30, total: totalPages * 30, totalPages },
    excludedCounts: { cancelled: 0, pendingResult: 0, missingOdds: 0, teamMatchFailed: 0 },
    archive,
  };
}

test("history view exposes ordered filters and real archive table columns without running effects", () => {
  const html = renderToStaticMarkup(createElement(OddsHistory));
  const labels = ["리그", "팀 선택", "시작일", "종료일"];
  let previous = -1;
  for (const label of labels) {
    const current = html.indexOf(label);
    assert.ok(current > previous, `${label} filter should follow the specified order`);
    previous = current;
  }
  for (const text of ["경기일", "리그", "홈팀", "원정팀", "경기결과", "승 배당", "무 배당", "패 배당"]) {
    assert.match(html, new RegExp(text));
  }
  assert.match(html, /Betman 마감게임 · D1 아카이브/);
  assert.doesNotMatch(html, /샘플|데모 데이터/);
  const pagination = html.match(/<nav class="odds-pagination"[\s\S]*?<\/nav>/u)?.[0] ?? "";
  assert.equal([...pagination.matchAll(/<button[^>]*disabled=""/gu)].length, 5, "all controls must be disabled without pagination metadata");
});

test("sync status gives the earliest Korean cooldown time precedence over partial status", () => {
  assert.equal(syncStatusText(partialSync, archive), "다음 동기화 가능 2026.08.22 00:30");
  assert.equal(syncStatusText({ ...partialSync, nextPendingRetryAt: null }, archive), "일부 회차 미확정 2개");
  assert.equal(syncStatusText({ ...partialSync, nextPendingRetryAt: null }, archive, { pageLoading: true }), "일부 회차 미확정 2개");
  assert.equal(syncStatusText({ ...partialSync, status: "completed", remainingUnresolvedRounds: 0, nextPendingRetryAt: null }, archive), "동기화 완료");
  assert.equal(syncStatusText(null, archive, { failed: true }), "동기화 실패");
  assert.equal(syncStatusText(null, archive, { failed: true, pageLoading: true }), "동기화 실패");
});

test("history formatting and pagination helpers cover result and zero-page boundaries", () => {
  assert.equal(formatHistoryDate("2026-08-21"), "2026.08.21");
  assert.deepEqual([resultLabel("H"), resultLabel("D"), resultLabel("A")], ["홈승", "무승부", "원정승"]);
  assert.equal(canGoPrevious(null), false);
  assert.equal(canGoNext(null), false);
  assert.equal(canGoPrevious(payloadFor(1, 0)), false);
  assert.equal(canGoNext(payloadFor(1, 0)), false);
  assert.equal(canGoPrevious(payloadFor(2, 3)), true);
  assert.equal(canGoNext(payloadFor(2, 3)), true);
  assert.equal(canGoPrevious(payloadFor(2, 3), true), false);
  assert.equal(canGoNext(payloadFor(2, 3), true), false);
});

test("team catalog unions league-scoped IDs and keeps J1 options after a K1-only payload", () => {
  const initial: HistoryTeamOption[] = [
    { key: "K1:1", leagueCode: "K1", id: 1, name: "서울" },
    { key: "J1:1", leagueCode: "J1", id: 1, name: "가시마" },
  ];
  const merged = mergeHistoryTeamCatalog(initial, [
    { key: "K1:1", leagueCode: "K1", id: 1, name: "FC 서울" },
    { key: "K1:2", leagueCode: "K1", id: 2, name: "울산" },
  ]);

  assert.deepEqual(merged.map((team) => [team.key, team.name]), [
    ["K1:1", "FC 서울"],
    ["J1:1", "가시마"],
    ["K1:2", "울산"],
  ]);
  assert.deepEqual(historyTeamsForLeague(merged, "J1").map((team) => team.key), ["J1:1"]);
  assert.deepEqual(historyTeamsForLeague(merged, "all").map((team) => team.key), ["K1:1", "J1:1", "K1:2"]);
});

test("trusted rows are scoped to the applied query and a failed new filter exposes retry", () => {
  const previous = payloadFor(1, 1);
  const nextQuery = { ...previous.query, league: "J1" as const };
  const visible = historyPayloadForQuery(previous, nextQuery);

  assert.equal(visible, null);
  assert.equal(shouldShowHistoryRetry("D1 저장소를 사용할 수 없습니다.", visible), true);
  assert.equal(historyPayloadForQuery({ ...previous, query: nextQuery }, nextQuery)?.query.league, "J1");
});
