import assert from "node:assert/strict";
import test from "node:test";
import { createPredictionsGetHandler } from "../app/api/predictions/route.ts";
import { SharedCacheStorageError } from "../app/lib/shared-api-cache.ts";
import { MemorySharedCache, cachedEntry } from "./helpers/memory-shared-cache.ts";

const NOW = Date.parse("2026-09-03T00:00:00.000Z");
const request = new Request("https://example.test/api/predictions?fixture=77");

test("a fresh prediction cache hit skips API key loading and provider fetch", async () => {
  const store = new MemorySharedCache();
  const payload = { source: "API-Football Predictions", fixtureId: 77, prediction: null };
  store.entries.set("predictions:v1:77", cachedEntry(payload, NOW + 1_000, NOW + 2_000));
  let keyLoads = 0;
  let fetches = 0;
  const handler = createPredictionsGetHandler({
    cacheStoreLoader: async () => store,
    apiKeyLoader: async () => { keyLoads += 1; return "secret"; },
    fetcher: async () => { fetches += 1; return Response.json({ errors: [], response: [] }); },
    now: () => NOW,
    inFlight: new Map(),
  });

  const response = await handler(request);
  assert.equal(response.headers.get("X-Cache-Status"), "fresh");
  assert.deepEqual(await response.json(), payload);
  assert.equal(keyLoads, 0);
  assert.equal(fetches, 0);
});

test("prediction rate-limit responses are not cached and a later request retries upstream", async () => {
  const store = new MemorySharedCache();
  let fetches = 0;
  const handler = createPredictionsGetHandler({
    cacheStoreLoader: async () => store,
    apiKeyLoader: async () => "secret",
    fetcher: async () => {
      fetches += 1;
      return Response.json({ errors: { rateLimit: "Too many requests" }, response: [] });
    },
    now: () => NOW,
    token: () => `owner-${fetches}`,
    inFlight: new Map(),
  });

  assert.equal((await handler(request)).status, 502);
  assert.equal((await handler(request)).status, 502);
  assert.equal(fetches, 2);
  assert.equal(store.writes, 0);
  assert.equal(store.entries.get("predictions:v1:77")?.payloadJson, null);
});

test("an expired prediction uses the last normal value when refresh is rate-limited", async () => {
  const store = new MemorySharedCache();
  const payload = { source: "API-Football Predictions", fixtureId: 77, prediction: null };
  store.entries.set("predictions:v1:77", cachedEntry(payload, NOW - 1, NOW + 60_000));
  const handler = createPredictionsGetHandler({
    cacheStoreLoader: async () => store,
    apiKeyLoader: async () => "secret",
    fetcher: async () => Response.json({ errors: { rateLimit: "Too many requests" }, response: [] }),
    now: () => NOW,
    token: () => "owner",
    inFlight: new Map(),
  });

  const response = await handler(request);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Cache-Status"), "stale");
  assert.deepEqual(await response.json(), payload);
  assert.equal(store.writes, 0);
});

test("a shared-cache storage failure returns 503 without calling API-Football", async () => {
  const store = new MemorySharedCache();
  store.read = async () => { throw new SharedCacheStorageError(); };
  let fetches = 0;
  const handler = createPredictionsGetHandler({
    cacheStoreLoader: async () => store,
    apiKeyLoader: async () => "secret",
    fetcher: async () => { fetches += 1; return Response.json({ errors: [], response: [] }); },
    now: () => NOW,
    inFlight: new Map(),
  });

  const response = await handler(request);
  assert.equal(response.status, 503);
  assert.equal(fetches, 0);
});
