import assert from "node:assert/strict";
import test from "node:test";
import { handleOddsHistoryGet } from "../app/api/odds-history/route.ts";
import type { OddsHistoryPayload } from "../app/lib/betman-history-types.ts";
import { OddsHistoryValidationError } from "../app/lib/odds-history-contract.ts";
import type { OddsHistoryStore } from "../app/lib/odds-history-store.ts";

const fixedNow = () => new Date("2026-08-21T00:00:00.000Z");

const historyPayload: OddsHistoryPayload = {
  query: { league: "J1", team: "J1:292", from: "2026-05-21", to: "2026-08-21", page: 1, pageSize: 30 },
  teams: [], records: [],
  pagination: { page: 1, pageSize: 30, total: 0, totalPages: 0 },
  excludedCounts: { cancelled: 0, pendingResult: 0, missingOdds: 0, teamMatchFailed: 0 },
  archive: { pendingRounds: 0, cooldownPendingRounds: 0, errorRounds: 0, nextPendingRetryAt: null, lastSuccessfulSyncAt: null },
};

function fakeStore(query: OddsHistoryStore["query"]): OddsHistoryStore {
  return { query } as OddsHistoryStore;
}

test("GET returns the exact stored D1 payload", async () => {
  const calls: Array<{ now: string }> = [];
  const store = fakeStore(async (query, now) => {
    calls.push({ now });
    assert.deepEqual(query, historyPayload.query);
    return historyPayload;
  });

  const response = await handleOddsHistoryGet(
    new Request("http://local/api/odds-history?league=J1&team=J1%3A292&from=2026-05-21&to=2026-08-21&page=1"),
    { store, now: fixedNow },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), historyPayload);
  assert.deepEqual(calls, [{ now: "2026-08-21T00:00:00.000Z" }]);
});

test("GET maps validation errors to the exact 400 envelope", async () => {
  const response = await handleOddsHistoryGet(
    new Request("http://local/api/odds-history?from=bad&to=2026-08-21"),
    { store: fakeStore(async () => historyPayload), now: fixedNow },
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: { code: "INVALID_DATE", message: "날짜가 올바르지 않습니다.", field: "from", retryable: false },
  });
});

test("GET maps D1 failures to a safe retryable 503 envelope", async () => {
  const response = await handleOddsHistoryGet(
    new Request("http://local/api/odds-history?from=2026-05-21&to=2026-08-21"),
    { store: fakeStore(async () => { throw new Error("D1 binding DB secret-details"); }), now: fixedNow },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: { code: "DATABASE_UNAVAILABLE", message: "D1 저장소를 사용할 수 없습니다.", field: null, retryable: true },
  });
});

test("GET maps a store-wrapped DATABASE_UNAVAILABLE error to retryable 503", async () => {
  const response = await handleOddsHistoryGet(
    new Request("http://local/api/odds-history?from=2026-05-21&to=2026-08-21"),
    {
      store: fakeStore(async () => {
        throw new OddsHistoryValidationError(
          "DATABASE_UNAVAILABLE",
          "D1 저장소를 사용할 수 없습니다.",
          null,
          true,
        );
      }),
      now: fixedNow,
    },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: { code: "DATABASE_UNAVAILABLE", message: "D1 저장소를 사용할 수 없습니다.", field: null, retryable: true },
  });
});
