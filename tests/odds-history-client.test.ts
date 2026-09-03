import assert from "node:assert/strict";
import test from "node:test";
import type { OddsHistoryPayload, OddsHistoryQuery, SyncPayload } from "../app/lib/betman-history-types.ts";
import {
  OddsHistoryClientError,
  fetchOddsHistoryPage,
  pageWindow,
  reconcileHistoryTeam,
  runOddsHistoryRefresh,
  mergeSyncPayload,
} from "../app/lib/odds-history-client.ts";

const query: OddsHistoryQuery = {
  league: "all", team: null, from: "2026-05-21", to: "2026-08-21", page: 1, pageSize: 30,
};

const storedPayload: OddsHistoryPayload = {
  query, teams: [{ key: "K1:1", leagueCode: "K1", id: 1, name: "서울" }], records: [],
  pagination: { page: 1, pageSize: 30, total: 0, totalPages: 0 },
  excludedCounts: { cancelled: 0, pendingResult: 0, missingOdds: 0, teamMatchFailed: 0 },
  archive: { pendingRounds: 0, cooldownPendingRounds: 0, errorRounds: 0, nextPendingRetryAt: null, lastSuccessfulSyncAt: null },
};
const finalPayload: OddsHistoryPayload = { ...storedPayload, pagination: { page: 1, pageSize: 30, total: 1, totalPages: 1 } };
const syncPayload: SyncPayload = {
  status: "completed", processedRounds: 1, maxRoundsPerRequest: 5, maxParallelDetails: 2, rounds: [], hasMore: false,
  nextCursor: null, remainingUnresolvedRounds: 0, deferredPendingRounds: 0, nextPendingRetryAt: null,
  startedAt: "2026-08-21T00:00:00.000Z", finishedAt: "2026-08-21T00:00:01.000Z",
};

function scriptedJsonFetch(payloads: unknown[], requests: Request[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(typeof input === "string" ? new URL(input, "http://local") : input, init));
    const payload = payloads.shift();
    if (payload instanceof Response) return payload;
    return Response.json(payload);
  }) as typeof fetch;
}

function refreshOptions(fetchImpl: typeof fetch) {
  return {
    query, fetchImpl, signal: new AbortController().signal, isCurrent: () => true,
    onStored: () => {}, onSync: () => {}, onFinal: () => {},
  };
}

test("refresh renders stored GET before sequential cursor POSTs and final GET", async () => {
  const events: string[] = [];
  const requests: Request[] = [];
  await runOddsHistoryRefresh({
    ...refreshOptions(scriptedJsonFetch([
      storedPayload,
      { ...syncPayload, hasMore: true, nextCursor: "c2" },
      syncPayload,
      finalPayload,
    ], requests)),
    onStored: () => events.push("stored"), onSync: () => events.push("sync"), onFinal: () => events.push("final"),
  });
  assert.deepEqual(events, ["stored", "sync", "sync", "final"]);
  assert.deepEqual(requests.map((request) => request.method), ["GET", "POST", "POST", "GET"]);
  assert.deepEqual(await requests[1].json(), { from: query.from, to: query.to, cursor: null });
  assert.deepEqual(await requests[2].json(), { from: query.from, to: query.to, cursor: "c2" });
});

test("client keeps an earlier partial sync and retry time sticky across cursor pages", async () => {
  const received: SyncPayload[] = [];
  const firstPage: SyncPayload = {
    ...syncPayload,
    status: "partial",
    hasMore: true,
    nextCursor: "c2",
    remainingUnresolvedRounds: 2,
    deferredPendingRounds: 1,
    nextPendingRetryAt: "2026-08-21T00:30:00.000Z",
  };
  await runOddsHistoryRefresh({
    ...refreshOptions(scriptedJsonFetch([storedPayload, firstPage, syncPayload, finalPayload])),
    onSync: (payload) => received.push(payload),
  });

  assert.equal(received.length, 2);
  assert.deepEqual(received[1], {
    ...syncPayload,
    status: "partial",
    remainingUnresolvedRounds: 2,
    deferredPendingRounds: 1,
    nextPendingRetryAt: "2026-08-21T00:30:00.000Z",
  });
  assert.equal(mergeSyncPayload(firstPage, syncPayload).status, "partial");
});

test("initial GET failure does not start sync and exposes the error envelope", async () => {
  const requests: Request[] = [];
  await assert.rejects(
    () => runOddsHistoryRefresh(refreshOptions(scriptedJsonFetch([
      new Response(JSON.stringify({ error: { code: "DATABASE_UNAVAILABLE", message: "D1 오류", field: null, retryable: true } }), { status: 503 }),
    ], requests))),
    (error: unknown) => error instanceof OddsHistoryClientError && error.code === "DATABASE_UNAVAILABLE" && error.retryable,
  );
  assert.deepEqual(requests.map((request) => request.method), ["GET"]);
});

test("sync HTTP failure retains stored data, reports the typed failure, and performs one final GET", async () => {
  const events: string[] = [];
  const requests: Request[] = [];
  let reported: OddsHistoryClientError | undefined;
  await runOddsHistoryRefresh({
    ...refreshOptions(scriptedJsonFetch([
      storedPayload,
      new Response(JSON.stringify({ error: { code: "BETMAN_UNAVAILABLE", message: "Betman 오류", field: null, retryable: true } }), { status: 502 }),
      finalPayload,
    ], requests)),
    onStored: () => events.push("stored"),
    onFinal: () => events.push("final"),
    onSyncError: (error) => { reported = error; events.push("error"); },
  });
  assert.deepEqual(events, ["stored", "final", "error"]);
  assert.equal(reported?.code, "BETMAN_UNAVAILABLE");
  assert.deepEqual(requests.map((request) => request.method), ["GET", "POST", "GET"]);
});

test("refresh rejects sync failure after final GET when no error hook is supplied", async () => {
  const requests: Request[] = [];
  let finalCalls = 0;
  await assert.rejects(
    () => runOddsHistoryRefresh({
      ...refreshOptions(scriptedJsonFetch([
        storedPayload,
        new Response(JSON.stringify({ error: { code: "BETMAN_UNAVAILABLE", message: "Betman 오류", field: null, retryable: true } }), { status: 502 }),
        finalPayload,
      ], requests)),
      onFinal: () => { finalCalls += 1; },
    }),
    (error: unknown) => error instanceof OddsHistoryClientError && error.code === "BETMAN_UNAVAILABLE",
  );
  assert.equal(finalCalls, 1);
  assert.deepEqual(requests.map((request) => request.method), ["GET", "POST", "GET"]);
});

test("final GET failure keeps the original typed sync failure after stored publication", async () => {
  const events: string[] = [];
  const requests: Request[] = [];
  await assert.rejects(
    () => runOddsHistoryRefresh({
      ...refreshOptions(scriptedJsonFetch([
        storedPayload,
        new Response(JSON.stringify({ error: { code: "BETMAN_UNAVAILABLE", message: "Betman 오류", field: null, retryable: true } }), { status: 502 }),
        new Response("bad gateway", { status: 502 }),
      ], requests)),
      onStored: () => events.push("stored"),
    }),
    (error: unknown) => error instanceof OddsHistoryClientError && error.code === "BETMAN_UNAVAILABLE",
  );
  assert.deepEqual(events, ["stored"]);
  assert.deepEqual(requests.map((request) => request.method), ["GET", "POST", "GET"]);
});

test("final callback errors are not swallowed by sync-failure recovery", async () => {
  const callbackError = new Error("render failed");
  let syncErrorCalls = 0;
  await assert.rejects(
    () => runOddsHistoryRefresh({
      ...refreshOptions(scriptedJsonFetch([
        storedPayload,
        new Response(JSON.stringify({ error: { code: "BETMAN_UNAVAILABLE", message: "Betman 오류", field: null, retryable: true } }), { status: 502 }),
        finalPayload,
      ])),
      onFinal: () => { throw callbackError; },
      onSyncError: () => { syncErrorCalls += 1; },
    }),
    (error: unknown) => error === callbackError,
  );
  assert.equal(syncErrorCalls, 0);
});

test("refresh rejects an impossible cursor response after the final GET", async () => {
  const requests: Request[] = [];
  await assert.rejects(
    () => runOddsHistoryRefresh(refreshOptions(scriptedJsonFetch([
      storedPayload, { ...syncPayload, hasMore: true, nextCursor: null }, finalPayload,
    ], requests))),
    (error: unknown) => error instanceof OddsHistoryClientError && error.code === "INTERNAL_ERROR",
  );
  assert.deepEqual(requests.map((request) => request.method), ["GET", "POST", "GET"]);
});

test("stale generation cannot publish late responses", async () => {
  let current = true;
  const events: string[] = [];
  const requests: Request[] = [];
  await runOddsHistoryRefresh({
    ...refreshOptions(scriptedJsonFetch([storedPayload, syncPayload, finalPayload], requests)),
    isCurrent: () => current,
    onStored: () => { events.push("stored"); current = false; },
    onSync: () => events.push("sync"), onFinal: () => events.push("final"),
  });
  assert.deepEqual(events, ["stored"]);
  assert.deepEqual(requests.map((request) => request.method), ["GET"]);
});

test("abort propagates AbortError and does not publish a response", async () => {
  const controller = new AbortController();
  const fetchImpl = (async () => {
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  }) as typeof fetch;
  await assert.rejects(
    () => runOddsHistoryRefresh({ ...refreshOptions(fetchImpl), signal: controller.signal }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});

test("page-only fetch performs one GET and no sync", async () => {
  const requests: Request[] = [];
  let pageCalls = 0;
  await fetchOddsHistoryPage({
    query, fetchImpl: scriptedJsonFetch([storedPayload], requests), signal: new AbortController().signal,
    isCurrent: () => true, onPage: () => { pageCalls += 1; },
  });
  assert.equal(pageCalls, 1);
  assert.deepEqual(requests.map((request) => [request.method, new URL(request.url).pathname]), [["GET", "/api/odds-history"]]);
});

test("client errors safely fall back when an error response is not JSON", async () => {
  await assert.rejects(
    () => fetchOddsHistoryPage({
      query, fetchImpl: scriptedJsonFetch([new Response("bad gateway", { status: 502 })]), signal: new AbortController().signal,
      isCurrent: () => true, onPage: () => {},
    }),
    (error: unknown) => error instanceof OddsHistoryClientError
      && error.code === "INTERNAL_ERROR" && error.message === "요청을 처리하지 못했습니다.",
  );
});

test("initial non-OK JSON parsing preserves AbortError", async () => {
  const abortError = new DOMException("body cancelled", "AbortError");
  const fetchImpl = (async () => ({
    ok: false,
    json: async () => { throw abortError; },
  }) as unknown as Response) as typeof fetch;
  await assert.rejects(
    () => fetchOddsHistoryPage({
      query, fetchImpl, signal: new AbortController().signal, isCurrent: () => true, onPage: () => {},
    }),
    (error: unknown) => error === abortError,
  );
});

test("team reconciliation is league scoped and pagination keeps useful boundaries", () => {
  const teams = [
    { key: "K1:1" as const, leagueCode: "K1" as const, id: 1, name: "서울" },
    { key: "J1:2" as const, leagueCode: "J1" as const, id: 2, name: "도쿄" },
  ];
  assert.equal(reconcileHistoryTeam("K1:1", "K1", teams), "K1:1");
  assert.equal(reconcileHistoryTeam("K1:1", "J1", teams), null);
  assert.equal(reconcileHistoryTeam("J1:999", "all", teams), null);
  assert.deepEqual(pageWindow(5, 12), [1, "ellipsis", 3, 4, 5, 6, 7, "ellipsis", 12]);
  assert.deepEqual(pageWindow(1, 0), [1]);
});
