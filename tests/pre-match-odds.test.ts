import assert from "node:assert/strict";
import test from "node:test";
import { matchWinnerOdds, normalizePreMatchOdds, parseFixtureId, preMatchOddsForFixture } from "../app/lib/pre-match-odds.ts";
import { createPreMatchOddsGetHandler } from "../app/api/pre-match-odds/route.ts";
import { MemorySharedCache, cachedEntry } from "./helpers/memory-shared-cache.ts";

const bookmaker = (markets: Array<{ id: number; name: string; values: Array<{ label: string; odds: number }> }>) => ({
  id: 1,
  name: "Test bookmaker",
  markets,
});

test("selects Match Winner even when another market comes first", () => {
  assert.deepEqual(matchWinnerOdds(bookmaker([
    { id: 2, name: "Goals Over/Under", values: [{ label: "Over 2.5", odds: 1.9 }] },
    { id: 1, name: "Match Winner", values: [{ label: "Home", odds: 2.1 }, { label: "Draw", odds: 3.3 }, { label: "Away", odds: 3.5 }] },
  ])), { home: 2.1, draw: 3.3, away: 3.5 });
});

test("normalizes Match Winner and selection labels before matching", () => {
  assert.deepEqual(matchWinnerOdds(bookmaker([
    { id: 1, name: "  match   winner ", values: [{ label: " HOME ", odds: 2.1 }, { label: "draw", odds: 3.3 }, { label: "Away  ", odds: 3.5 }] },
  ])), { home: 2.1, draw: 3.3, away: 3.5 });
});

test("returns Home Draw Away odds in fixed order regardless of source order", () => {
  assert.deepEqual(matchWinnerOdds(bookmaker([
    { id: 1, name: "Match Winner", values: [{ label: "Away", odds: 1.9 }, { label: "Home", odds: 4.1 }, { label: "Draw", odds: 3.35 }] },
  ])), { home: 4.1, draw: 3.35, away: 1.9 });
});

test("returns null when a Match Winner selection is missing", () => {
  assert.equal(matchWinnerOdds(bookmaker([
    { id: 1, name: "Match Winner", values: [{ label: "Home", odds: 2.1 }, { label: "Away", odds: 3.5 }] },
  ])), null);
});

test("returns null when Match Winner is absent", () => {
  assert.equal(matchWinnerOdds(bookmaker([
    { id: 2, name: "Goals Over/Under", values: [{ label: "Over 2.5", odds: 1.9 }] },
  ])), null);
});

test("parses a positive safe-integer fixture ID", () => {
  assert.equal(parseFixtureId("1507031"), 1507031);
  for (const value of [null, "", "0", "-1", "1.5", "abc", "9007199254740992"]) {
    assert.throws(() => parseFixtureId(value), /fixture/);
  }
});

test("normalizes an empty API-Football response", () => {
  assert.deepEqual(normalizePreMatchOdds(1, []), {
    fixtureId: 1,
    bookmakers: [],
  });
});

test("does not expose pre-match odds from a previously selected fixture", () => {
  const payload = normalizePreMatchOdds(101, []);

  assert.equal(preMatchOddsForFixture(102, payload), null);
  assert.equal(preMatchOddsForFixture(101, payload), payload);
});

test("normalizes valid API-Football bookmakers, markets, and numeric selections", () => {
  const payload = normalizePreMatchOdds(1507031, [{
    bookmakers: [
      {
        id: 6,
        name: "1xBet",
        bets: [
          {
            id: 1,
            name: "Match Winner",
            values: [
              { value: "Home", odd: "1.80" },
              { value: "Draw", odd: "3.60" },
              { value: "Away", odd: "4.20" },
              { value: "Invalid odd", odd: "not-a-number" },
              { value: "", odd: "2.00" },
            ],
          },
          { id: 5, name: "Goals Over/Under", values: [{ value: "Over 2.5", odd: "2.05" }] },
        ],
      },
    ],
  }]);

  assert.deepEqual(payload, {
    fixtureId: 1507031,
    bookmakers: [{
      id: 6,
      name: "1xBet",
      markets: [
        {
          id: 1,
          name: "Match Winner",
          values: [
            { label: "Home", odds: 1.8 },
            { label: "Draw", odds: 3.6 },
            { label: "Away", odds: 4.2 },
          ],
        },
        { id: 5, name: "Goals Over/Under", values: [{ label: "Over 2.5", odds: 2.05 }] },
      ],
    }],
  });
});

test("keeps the first valid occurrence of duplicate bookmaker and market IDs", () => {
  const payload = normalizePreMatchOdds(1, [{
    bookmakers: [
      { id: 2, name: "First bookmaker", bets: [{ id: 9, name: "First market", values: [{ value: "Yes", odd: "1.5" }] }] },
      { id: 2, name: "Duplicate bookmaker", bets: [{ id: 10, name: "Other", values: [{ value: "No", odd: "2.5" }] }] },
      {
        id: 3,
        name: "Second bookmaker",
        bets: [
          { id: 9, name: "First market", values: [{ value: "Over", odd: "1.8" }] },
          { id: 9, name: "Duplicate market", values: [{ value: "Under", odd: "2.1" }] },
        ],
      },
    ],
  }]);

  assert.deepEqual(payload.bookmakers, [
    { id: 2, name: "First bookmaker", markets: [{ id: 9, name: "First market", values: [{ label: "Yes", odds: 1.5 }] }] },
    { id: 3, name: "Second bookmaker", markets: [{ id: 9, name: "First market", values: [{ label: "Over", odds: 1.8 }] }] },
  ]);
});

test("a fresh pre-match odds cache hit skips the provider and preserves the response contract", async () => {
  const now = Date.parse("2026-09-03T00:00:00.000Z");
  const store = new MemorySharedCache();
  const payload = { fixtureId: 77, fetchedAt: "2026-09-03T00:00:00.000Z", cacheSeconds: 1800, bookmakers: [] };
  store.entries.set("pre-match-odds:v1:77", cachedEntry(payload, now + 1_000, now + 2_000));
  let fetches = 0;
  let keyLoads = 0;
  const handler = createPreMatchOddsGetHandler({
    cacheStoreLoader: async () => store,
    apiKeyLoader: async () => { keyLoads += 1; return "secret"; },
    fetcher: async () => { fetches += 1; return Response.json({ errors: [], response: [] }); },
    now: () => now,
    inFlight: new Map(),
  });

  const response = await handler(new Request("https://example.test/api/pre-match-odds?fixture=77"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Cache-Status"), "fresh");
  assert.deepEqual(await response.json(), payload);
  assert.equal(fetches, 0);
  assert.equal(keyLoads, 0);
});

test("pre-match odds rate-limit errors never replace a stale normal value", async () => {
  const now = Date.parse("2026-09-03T00:00:00.000Z");
  const store = new MemorySharedCache();
  const payload = { fixtureId: 77, fetchedAt: "2026-09-02T23:00:00.000Z", cacheSeconds: 1800, bookmakers: [] };
  store.entries.set("pre-match-odds:v1:77", cachedEntry(payload, now - 1, now + 60_000));
  const handler = createPreMatchOddsGetHandler({
    cacheStoreLoader: async () => store,
    apiKeyLoader: async () => "secret",
    fetcher: async () => Response.json({ errors: { rateLimit: "Too many requests" }, response: [] }),
    now: () => now,
    token: () => "owner",
    inFlight: new Map(),
  });

  const response = await handler(new Request("https://example.test/api/pre-match-odds?fixture=77"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Cache-Status"), "stale");
  assert.deepEqual(await response.json(), payload);
  assert.equal(store.writes, 0);
  assert.equal(store.entries.get("pre-match-odds:v1:77")?.payloadJson, JSON.stringify(payload));
});
