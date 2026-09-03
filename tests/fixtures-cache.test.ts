import assert from "node:assert/strict";
import test from "node:test";
import { createFixturesGetHandler } from "../app/api/fixtures/route.ts";
import { MemorySharedCache, cachedEntry } from "./helpers/memory-shared-cache.ts";

const NOW = Date.parse("2026-09-03T00:00:00.000Z");

function standings(leagueId: number) {
  return [{
    league: {
      standings: [[{
        rank: 1,
        team: { id: leagueId * 10, name: `Team ${leagueId}`, logo: "logo" },
        points: 30,
        goalsDiff: 10,
        all: { played: 12, win: 9, draw: 3, lose: 0, goals: { for: 24, against: 14 } },
      }]],
    },
  }];
}

function successfulProvider() {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    const url = new URL(String(input));
    urls.push(url.toString());
    const leagueId = Number(url.searchParams.get("league"));
    await Promise.resolve();
    active -= 1;
    return Response.json({ errors: [], response: url.pathname.endsWith("/standings") ? standings(leagueId) : [] });
  };
  return { fetcher, calls: () => calls, maxActive: () => maxActive, urls };
}

test("a fresh fixtures cache hit skips both API key loading and all provider calls", async () => {
  const store = new MemorySharedCache();
  const payload = {
    source: "API-Football",
    leagueId: 292,
    today: "2026-09-03",
    rangeEnd: "2026-09-17",
    statsThrough: "2026-09-02",
    fetchedAt: "2026-09-03T00:00:00.000Z",
    matches: [],
    standingsByLeague: { K1: [], J1: [] },
    leagueErrors: {},
    leagues: [],
    standings: [],
  };
  store.entries.set("fixtures:v1:2026-09-03", cachedEntry(payload, NOW + 1_000, NOW + 2_000));
  let keyLoads = 0;
  let fetches = 0;
  const handler = createFixturesGetHandler({
    cacheStoreLoader: async () => store,
    apiKeyLoader: async () => { keyLoads += 1; return "secret"; },
    fetcher: async () => { fetches += 1; return Response.json({ errors: [], response: [] }); },
    now: () => NOW,
    inFlight: new Map(),
  });

  const response = await handler();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Cache-Status"), "fresh");
  assert.deepEqual(await response.json(), payload);
  assert.equal(keyLoads, 0);
  assert.equal(fetches, 0);
});

test("one cold fixtures refresh makes four sequential provider calls and stores only the complete payload", async () => {
  const store = new MemorySharedCache();
  const provider = successfulProvider();
  let keyLoads = 0;
  const handler = createFixturesGetHandler({
    cacheStoreLoader: async () => store,
    apiKeyLoader: async () => { keyLoads += 1; return "secret"; },
    fetcher: provider.fetcher,
    now: () => NOW,
    token: () => "owner",
    inFlight: new Map(),
  });

  const response = await handler();
  const payload = await response.json() as { leagueErrors: Record<string, string>; standingsByLeague: object };
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Cache-Status"), "refreshed");
  assert.deepEqual(payload.leagueErrors, {});
  assert.deepEqual(Object.keys(payload.standingsByLeague), ["K1", "J1"]);
  assert.equal(provider.calls(), 4);
  assert.equal(provider.maxActive(), 1);
  const fixtureUrls = provider.urls.filter((value) => new URL(value).pathname.endsWith("/fixtures"));
  assert.equal(fixtureUrls.length, 2);
  assert.deepEqual(fixtureUrls.map((value) => {
    const url = new URL(value);
    return [url.searchParams.get("league"), url.searchParams.get("from")];
  }), [["292", "2026-01-01"], ["98", "2026-07-01"]]);
  assert.ok(fixtureUrls.every((value) => new URL(value).searchParams.get("to") === "2026-09-17"));
  assert.equal(keyLoads, 1);
  assert.equal(store.writes, 1);
});

test("a partial fixtures result stays visible but is never written to shared cache", async () => {
  const store = new MemorySharedCache();
  let calls = 0;
  const handler = createFixturesGetHandler({
    cacheStoreLoader: async () => store,
    apiKeyLoader: async () => "secret",
    fetcher: async (input) => {
      calls += 1;
      const url = new URL(String(input));
      const leagueId = Number(url.searchParams.get("league"));
      if (leagueId === 98) return Response.json({ errors: { rateLimit: "Too many requests" }, response: [] });
      return Response.json({ errors: [], response: url.pathname.endsWith("/standings") ? standings(leagueId) : [] });
    },
    now: () => NOW,
    token: () => "owner",
    inFlight: new Map(),
  });

  const response = await handler();
  const payload = await response.json() as { leagueErrors: Record<string, string> };
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Cache-Status"), "uncached");
  assert.match(payload.leagueErrors.J1, /rateLimit/);
  assert.equal(calls, 3);
  assert.equal(store.writes, 0);
  assert.equal(store.entries.get("fixtures:v1:2026-09-03")?.payloadJson, null);
});

test("a total fixtures rate-limit failure returns 502 and leaves no cached error payload", async () => {
  const store = new MemorySharedCache();
  const handler = createFixturesGetHandler({
    cacheStoreLoader: async () => store,
    apiKeyLoader: async () => "secret",
    fetcher: async () => Response.json({ errors: { rateLimit: "Too many requests" }, response: [] }),
    now: () => NOW,
    token: () => "owner",
    inFlight: new Map(),
  });

  const response = await handler();
  assert.equal(response.status, 502);
  assert.equal(store.writes, 0);
  assert.equal(store.entries.get("fixtures:v1:2026-09-03")?.payloadJson, null);
});
