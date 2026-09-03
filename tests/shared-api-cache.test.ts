import assert from "node:assert/strict";
import test from "node:test";
import {
  SharedCacheBusyError,
  getOrRefreshShared,
  type SharedCacheResult,
  type SharedCacheStore,
  type StoredCacheEntry,
} from "../app/lib/shared-api-cache.ts";

class MemoryStore implements SharedCacheStore {
  entries = new Map<string, StoredCacheEntry>();
  acquireCount = 0;
  writeCount = 0;
  releaseCount = 0;

  async read(key: string) {
    return this.entries.get(key) ?? null;
  }

  async acquireLease(key: string, token: string, now: number, leaseUntil: number) {
    this.acquireCount += 1;
    const current = this.entries.get(key);
    if (current && current.leaseUntil > now) return false;
    this.entries.set(key, current
      ? { ...current, leaseToken: token, leaseUntil }
      : {
          payloadJson: null,
          fetchedAt: null,
          expiresAt: 0,
          staleUntil: 0,
          leaseToken: token,
          leaseUntil,
        });
    return true;
  }

  async writeSuccess(key: string, token: string, entry: StoredCacheEntry) {
    if (this.entries.get(key)?.leaseToken !== token) return false;
    this.writeCount += 1;
    this.entries.set(key, entry);
    return true;
  }

  async releaseLease(key: string, token: string) {
    const current = this.entries.get(key);
    if (current?.leaseToken !== token) return;
    this.releaseCount += 1;
    this.entries.set(key, { ...current, leaseToken: null, leaseUntil: 0 });
  }
}

function entry(value: unknown, expiresAt: number, staleUntil: number): StoredCacheEntry {
  return {
    payloadJson: JSON.stringify(value),
    fetchedAt: "2026-09-03T00:00:00.000Z",
    expiresAt,
    staleUntil,
    leaseToken: null,
    leaseUntil: 0,
  };
}

test("returns a fresh shared value without acquiring a lease or loading upstream", async () => {
  const store = new MemoryStore();
  store.entries.set("fixtures", entry({ matches: [1] }, 2_000, 4_000));
  let loads = 0;

  const result = await getOrRefreshShared({
    key: "fixtures",
    ttlMs: 600,
    staleTtlMs: 3_600,
    store,
    now: () => 1_000,
    load: async () => { loads += 1; return { matches: [2] }; },
    inFlight: new Map(),
  });

  assert.deepEqual(result, { value: { matches: [1] }, cacheStatus: "fresh" });
  assert.equal(loads, 0);
  assert.equal(store.acquireCount, 0);
});

test("an empty cache is refreshed once and stores the normal value with both expiries", async () => {
  const store = new MemoryStore();

  const result = await getOrRefreshShared({
    key: "predictions:7",
    ttlMs: 600,
    staleTtlMs: 3_600,
    store,
    now: () => 1_000,
    token: () => "owner",
    load: async () => ({ fixtureId: 7 }),
    inFlight: new Map(),
  });

  assert.deepEqual(result, { value: { fixtureId: 7 }, cacheStatus: "refreshed" });
  assert.deepEqual(store.entries.get("predictions:7"), {
    payloadJson: JSON.stringify({ fixtureId: 7 }),
    fetchedAt: "1970-01-01T00:00:01.000Z",
    expiresAt: 1_600,
    staleUntil: 4_600,
    leaseToken: null,
    leaseUntil: 0,
  });
  assert.equal(store.writeCount, 1);
});

test("ten same-instance misses share one in-flight loader", async () => {
  const store = new MemoryStore();
  const inFlight = new Map<string, Promise<SharedCacheResult<unknown>>>();
  let loads = 0;
  let finish!: (value: { ok: boolean }) => void;
  const pending = new Promise<{ ok: boolean }>((resolve) => { finish = resolve; });
  const options = {
    key: "fixtures",
    ttlMs: 600,
    staleTtlMs: 3_600,
    store,
    now: () => 1_000,
    token: () => "owner",
    load: async () => { loads += 1; return pending; },
    inFlight,
  };

  const requests = Array.from({ length: 10 }, () => getOrRefreshShared(options));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
  finish({ ok: true });
  const results = await Promise.all(requests);
  assert.equal(results.length, 10);
  assert.ok(results.every((result) => result.value.ok));
  assert.equal(loads, 1);
});

test("a distributed cold follower waits for the lease owner and never loads upstream", async () => {
  const store = new MemoryStore();
  let ownerLoads = 0;
  let followerLoads = 0;
  let finish!: (value: { owner: boolean }) => void;
  const pending = new Promise<{ owner: boolean }>((resolve) => { finish = resolve; });
  const owner = getOrRefreshShared({
    key: "fixtures",
    ttlMs: 600,
    staleTtlMs: 3_600,
    store,
    now: () => 1_000,
    token: () => "owner",
    load: async () => { ownerLoads += 1; return pending; },
    inFlight: new Map(),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  let waits = 0;
  const follower = getOrRefreshShared({
    key: "fixtures",
    ttlMs: 600,
    staleTtlMs: 3_600,
    store,
    now: () => 1_000,
    token: () => "follower",
    load: async () => { followerLoads += 1; return { owner: false }; },
    wait: async () => {
      waits += 1;
      finish({ owner: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    inFlight: new Map(),
  });

  assert.deepEqual(await owner, { value: { owner: true }, cacheStatus: "refreshed" });
  assert.deepEqual(await follower, { value: { owner: true }, cacheStatus: "fresh" });
  assert.equal(ownerLoads, 1);
  assert.equal(followerLoads, 0);
  assert.equal(waits, 1);
});

test("a follower returns a stale normal value immediately while another owner refreshes", async () => {
  const store = new MemoryStore();
  store.entries.set("fixtures", {
    ...entry({ matches: [1] }, 900, 2_000),
    leaseToken: "other",
    leaseUntil: 1_500,
  });
  let loads = 0;
  let waits = 0;

  const result = await getOrRefreshShared({
    key: "fixtures",
    ttlMs: 600,
    staleTtlMs: 3_600,
    store,
    now: () => 1_000,
    load: async () => { loads += 1; return { matches: [2] }; },
    wait: async () => { waits += 1; },
    inFlight: new Map(),
  });

  assert.deepEqual(result, { value: { matches: [1] }, cacheStatus: "stale" });
  assert.equal(loads, 0);
  assert.equal(waits, 0);
});

test("an owner refresh error releases its lease and falls back only to stale-valid normal data", async () => {
  const store = new MemoryStore();
  store.entries.set("fixtures", entry({ matches: [1] }, 900, 2_000));

  const result = await getOrRefreshShared({
    key: "fixtures",
    ttlMs: 600,
    staleTtlMs: 3_600,
    store,
    now: () => 1_000,
    token: () => "owner",
    load: async () => { throw new Error("rate limited"); },
    inFlight: new Map(),
  });

  assert.deepEqual(result, { value: { matches: [1] }, cacheStatus: "stale" });
  assert.equal(store.releaseCount, 1);
  assert.equal(store.writeCount, 0);

  const expired = new MemoryStore();
  expired.entries.set("fixtures", entry({ matches: [1] }, 800, 900));
  await assert.rejects(() => getOrRefreshShared({
    key: "fixtures",
    ttlMs: 600,
    staleTtlMs: 3_600,
    store: expired,
    now: () => 1_000,
    token: () => "owner",
    load: async () => { throw new Error("rate limited"); },
    inFlight: new Map(),
  }), /rate limited/);
  assert.equal(expired.releaseCount, 1);
});

test("a partial value is returned uncached and releases the refresh lease", async () => {
  const store = new MemoryStore();

  const result = await getOrRefreshShared({
    key: "fixtures",
    ttlMs: 600,
    staleTtlMs: 3_600,
    store,
    now: () => 1_000,
    token: () => "owner",
    load: async () => ({ leagueErrors: { J1: "rate limited" } }),
    canStore: (value) => Object.keys(value.leagueErrors).length === 0,
    inFlight: new Map(),
  });

  assert.deepEqual(result.cacheStatus, "uncached");
  assert.equal(store.writeCount, 0);
  assert.equal(store.releaseCount, 1);
  assert.equal(store.entries.get("fixtures")?.payloadJson, null);
});

test("a cold follower times out without bypassing an active distributed lease", async () => {
  const store = new MemoryStore();
  store.entries.set("fixtures", {
    payloadJson: null,
    fetchedAt: null,
    expiresAt: 0,
    staleUntil: 0,
    leaseToken: "other",
    leaseUntil: 5_000,
  });
  let loads = 0;
  let now = 1_000;

  await assert.rejects(() => getOrRefreshShared({
    key: "fixtures",
    ttlMs: 600,
    staleTtlMs: 3_600,
    store,
    now: () => now,
    load: async () => { loads += 1; return {}; },
    wait: async (milliseconds) => { now += milliseconds; },
    inFlight: new Map(),
  }), (error: unknown) => error instanceof SharedCacheBusyError && error.status === 503);
  assert.equal(loads, 0);
});

