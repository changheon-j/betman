import assert from "node:assert/strict";
import test from "node:test";
import type { ApiFixture } from "../app/lib/fixture-data.ts";
import {
  buildHeadToHeadMatches,
  HeadToHeadProviderError,
  headToHeadErrorForFixture,
  headToHeadForFixture,
  headToHeadLoadingForFixture,
  parseHeadToHeadQuery,
  requestHeadToHead,
} from "../app/lib/head-to-head.ts";
import type { HeadToHeadPayload } from "../app/lib/head-to-head.ts";
import { createHeadToHeadGetHandler, GET } from "../app/api/head-to-head/route.ts";

const completedFixture = (
  id: number,
  date: string,
  homeId: number,
  awayId: number,
  homeGoals: number,
  awayGoals: number,
  status = "FT",
): ApiFixture => ({
  fixture: { id, date, status: { short: status }, venue: { name: null } },
  league: { round: "Regular Season - 1" },
  teams: {
    home: { id: homeId, name: `Team ${homeId}`, logo: "" },
    away: { id: awayId, name: `Team ${awayId}`, logo: "" },
  },
  goals: { home: homeGoals, away: awayGoals },
});

test("parses a valid selected-fixture head-to-head query", () => {
  const query = parseHeadToHeadQuery(new URLSearchParams({
    fixture: "1507028",
    home: "2763",
    away: "2764",
    kickoff: "2026-08-16T10:00:00+00:00",
  }));

  assert.deepEqual(query, {
    fixtureId: 1507028,
    homeTeamId: 2763,
    awayTeamId: 2764,
    kickoffAt: "2026-08-16T10:00:00+00:00",
  });
});

test("rejects invalid fixture, equal teams, and non-ISO kickoff", () => {
  assert.throws(() => parseHeadToHeadQuery(new URLSearchParams({ fixture: "0", home: "1", away: "2", kickoff: "2026-08-16T10:00:00Z" })), /fixture/i);
  assert.throws(() => parseHeadToHeadQuery(new URLSearchParams({ fixture: "1", home: "2", away: "2", kickoff: "2026-08-16T10:00:00Z" })), /different/i);
  assert.throws(() => parseHeadToHeadQuery(new URLSearchParams({ fixture: "1", home: "2", away: "3", kickoff: "2026-08-16" })), /kickoff/i);
});

test("rejects impossible ISO calendar dates and out-of-range time or timezone fields", () => {
  const query = (kickoff: string) => new URLSearchParams({ fixture: "1", home: "2", away: "3", kickoff });

  assert.throws(() => parseHeadToHeadQuery(query("2026-02-30T10:00:00Z")), /kickoff/i);
  assert.throws(() => parseHeadToHeadQuery(query("2025-02-29T10:00:00Z")), /kickoff/i);
  assert.throws(() => parseHeadToHeadQuery(query("2026-01-01T24:00:00Z")), /kickoff/i);
  assert.throws(() => parseHeadToHeadQuery(query("2026-01-01T10:60:00Z")), /kickoff/i);
  assert.throws(() => parseHeadToHeadQuery(query("2026-01-01T10:00:00+24:00")), /kickoff/i);
  assert.throws(() => parseHeadToHeadQuery(query("2026-01-01T10:00:00+10:60")), /kickoff/i);
  assert.doesNotThrow(() => parseHeadToHeadQuery(query("2028-02-29T23:59:59-23:59")));
});

test("keeps the newest ten completed pre-kickoff matches with selected-home results", () => {
  const query = {
    fixtureId: 1507028,
    homeTeamId: 2763,
    awayTeamId: 2764,
    kickoffAt: "2026-08-16T10:00:00+00:00",
  };
  const fixtures = Array.from({ length: 12 }, (_, index) => {
    const day = String(index + 1).padStart(2, "0");
    const selectedHomeIsHome = index % 2 === 0;
    return completedFixture(
      index + 1,
      `2026-08-${day}T10:00:00+00:00`,
      selectedHomeIsHome ? 2763 : 2764,
      selectedHomeIsHome ? 2764 : 2763,
      selectedHomeIsHome ? 2 : 0,
      selectedHomeIsHome ? 0 : 1,
      index === 10 ? "AET" : index === 11 ? "PEN" : "FT",
    );
  });
  fixtures.push(
    completedFixture(13, "2026-08-17T10:00:00+00:00", 2763, 2764, 3, 0),
    completedFixture(14, "2026-08-15T10:00:00+00:00", 2763, 2764, 1, 0, "NS"),
  );

  assert.deepEqual(buildHeadToHeadMatches(fixtures, query), [
    ["2026.08.12", false, "0–1", "W"],
    ["2026.08.11", true, "2–0", "W"],
    ["2026.08.10", false, "0–1", "W"],
    ["2026.08.09", true, "2–0", "W"],
    ["2026.08.08", false, "0–1", "W"],
    ["2026.08.07", true, "2–0", "W"],
    ["2026.08.06", false, "0–1", "W"],
    ["2026.08.05", true, "2–0", "W"],
    ["2026.08.04", false, "0–1", "W"],
    ["2026.08.03", true, "2–0", "W"],
  ]);
});

test("highlights only the winning team and leaves both teams plain for a draw", async () => {
  const headToHeadModule = await import("../app/lib/head-to-head.ts") as Record<string, unknown>;
  const winnerClasses = headToHeadModule.headToHeadWinnerClasses as
    | ((selectedHomeWasHome: boolean, result: "W" | "D" | "L") => [string, string])
    | undefined;

  assert.deepEqual(winnerClasses?.(true, "W") ?? null, ["winning-team", ""]);
  assert.deepEqual(winnerClasses?.(false, "W") ?? null, ["", "winning-team"]);
  assert.deepEqual(winnerClasses?.(true, "L") ?? null, ["", "winning-team"]);
  assert.deepEqual(winnerClasses?.(false, "L") ?? null, ["winning-team", ""]);
  assert.deepEqual(winnerClasses?.(true, "D") ?? null, ["", ""]);
  assert.deepEqual(winnerClasses?.(false, "D") ?? null, ["", ""]);
});

const validQuery = {
  fixtureId: 1507028,
  homeTeamId: 2763,
  awayTeamId: 2764,
  kickoffAt: "2026-08-16T10:00:00+00:00",
};

test("requests API-Football head-to-head exactly once", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls += 1;
    assert.match(String(input), /fixtures\/headtohead\?h2h=2763-2764&last=20&timezone=Asia%2FSeoul/);
    assert.deepEqual(init?.headers, { "x-apisports-key": "secret" });
    return Response.json({ errors: [], response: [] });
  };

  const matches = await requestHeadToHead(validQuery, "secret", fetcher);
  assert.equal(calls, 1);
  assert.deepEqual(matches, []);
});

test("maps API-Football rate limits to 429 after one request", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return Response.json({ errors: { rateLimit: "Too many requests" }, response: [] });
  };

  await assert.rejects(
    requestHeadToHead(validQuery, "secret", fetcher),
    (error: unknown) => error instanceof HeadToHeadProviderError && error.status === 429,
  );
  assert.equal(calls, 1);
});

test("maps an empty API-Football rateLimit error value to 429", async () => {
  const fetcher: typeof fetch = async () => Response.json({ errors: { rateLimit: "" }, response: [] });

  await assert.rejects(
    requestHeadToHead(validQuery, "secret", fetcher),
    (error: unknown) => error instanceof HeadToHeadProviderError && error.status === 429,
  );
});

test("keeps non-rate API-Football error payloads at 502", async () => {
  for (const errors of [["Provider error"], { message: "Provider error" }]) {
    const fetcher: typeof fetch = async () => Response.json({ errors, response: [] });
    await assert.rejects(
      requestHeadToHead(validQuery, "secret", fetcher),
      (error: unknown) => error instanceof HeadToHeadProviderError && error.status === 502,
    );
  }
});

test("maps upstream failures to 502 after one request", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return Response.json({ errors: [], response: [] }, { status: 500 });
  };

  await assert.rejects(
    requestHeadToHead(validQuery, "secret", fetcher),
    (error: unknown) => error instanceof HeadToHeadProviderError && error.status === 502,
  );
  assert.equal(calls, 1);
});

test("keeps head-to-head state scoped to the selected fixture", () => {
  const payload: HeadToHeadPayload = { fixtureId: 11, matches: [["2026.08.01", true, "1–0", "W"]] };
  const error = { fixtureId: 11, message: "Unable to load head-to-head" };

  assert.deepEqual(headToHeadForFixture(11, payload), payload.matches);
  assert.equal(headToHeadErrorForFixture(11, error), error.message);
  assert.equal(headToHeadForFixture(22, payload), null);
  assert.equal(headToHeadForFixture(undefined, payload), null);
  assert.equal(headToHeadErrorForFixture(22, error), "");
  assert.equal(headToHeadErrorForFixture(undefined, error), "");
});

test("reports loading only while the selected fixture has no matching result or error", () => {
  const payload: HeadToHeadPayload = { fixtureId: 11, matches: [] };
  const error = { fixtureId: 11, message: "Unable to load head-to-head" };

  assert.equal(headToHeadLoadingForFixture(undefined, null, null), false);
  assert.equal(headToHeadLoadingForFixture(11, payload, null), false);
  assert.equal(headToHeadLoadingForFixture(11, null, error), false);
  assert.equal(headToHeadLoadingForFixture(11, null, null), true);
  assert.equal(headToHeadLoadingForFixture(22, payload, error), true);
});

test("rejects invalid route input before reading the provider key", async () => {
  const response = await GET(new Request("https://example.test/api/head-to-head?fixture=0&home=1&away=2&kickoff=2026-08-16T10:00:00Z"));

  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /fixture/i);
});

const routeRequest = (
  fixture = "1",
  home = "2",
  away = "3",
  kickoff = "2026-08-16T10:00:00+00:00",
) => new Request(`https://example.test/api/head-to-head?${new URLSearchParams({ fixture, home, away, kickoff })}`);

test("uses the complete cache key and returns a cache hit without another provider request", async () => {
  let calls = 0;
  let keyLoads = 0;
  const cache = new Map();
  const handler = createHeadToHeadGetHandler({
    cache,
    now: () => 0,
    apiKeyLoader: async () => {
      keyLoads += 1;
      return "secret";
    },
    fetcher: async () => {
      calls += 1;
      return Response.json({ errors: [], response: [] });
    },
  });

  const first = await handler(routeRequest());
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    fixtureId: 1,
    fetchedAt: "1970-01-01T00:00:00.000Z",
    cacheSeconds: 1800,
    matches: [],
  });
  assert.equal(calls, 1);
  assert.equal(keyLoads, 1);

  assert.equal((await handler(routeRequest())).status, 200);
  assert.equal(calls, 1);
  assert.equal(keyLoads, 1);

  await handler(routeRequest("2"));
  await handler(routeRequest("1", "4"));
  await handler(routeRequest("1", "2", "4"));
  await handler(routeRequest("1", "2", "3", "2026-08-17T10:00:00+00:00"));
  assert.equal(calls, 5);
  assert.equal(keyLoads, 5);
});

test("re-requests at the 1800-second TTL boundary", async () => {
  let calls = 0;
  let now = 0;
  const handler = createHeadToHeadGetHandler({
    cache: new Map(),
    now: () => now,
    apiKeyLoader: async () => "secret",
    fetcher: async () => {
      calls += 1;
      return Response.json({ errors: [], response: [] });
    },
  });

  await handler(routeRequest());
  now = 1800 * 1000;
  await handler(routeRequest());
  assert.equal(calls, 2);
});

test("evicts the oldest insertion when the route cache receives its 101st key", async () => {
  let calls = 0;
  const cache = new Map();
  const handler = createHeadToHeadGetHandler({
    cache,
    now: () => 0,
    apiKeyLoader: async () => "secret",
    fetcher: async () => {
      calls += 1;
      return Response.json({ errors: [], response: [] });
    },
  });

  for (let fixture = 1; fixture <= 101; fixture += 1) {
    await handler(routeRequest(String(fixture)));
  }
  assert.equal(cache.size, 100);
  assert.equal(calls, 101);

  await handler(routeRequest("1"));
  assert.equal(calls, 102);
});

test("keeps a refreshed expired cache entry when the next key triggers eviction", async () => {
  let calls = 0;
  let now = 0;
  const cache = new Map();
  const handler = createHeadToHeadGetHandler({
    cache,
    now: () => now,
    apiKeyLoader: async () => "secret",
    fetcher: async () => {
      calls += 1;
      return Response.json({ errors: [], response: [] });
    },
  });

  await handler(routeRequest("1"));
  now = 1;
  for (let fixture = 2; fixture <= 100; fixture += 1) {
    await handler(routeRequest(String(fixture)));
  }

  now = 1800 * 1000;
  await handler(routeRequest("1"));
  await handler(routeRequest("101"));
  assert.equal((await handler(routeRequest("1"))).status, 200);
  assert.equal(calls, 102);
});

test("returns provider 429 and 502 statuses from the route", async () => {
  const rateLimited = createHeadToHeadGetHandler({
    cache: new Map(),
    apiKeyLoader: async () => "secret",
    fetcher: async () => Response.json({ errors: { rateLimit: "Too many requests" }, response: [] }),
  });
  const unavailable = createHeadToHeadGetHandler({
    cache: new Map(),
    apiKeyLoader: async () => "secret",
    fetcher: async () => Response.json({ errors: [], response: [] }, { status: 500 }),
  });

  assert.equal((await rateLimited(routeRequest())).status, 429);
  assert.equal((await unavailable(routeRequest())).status, 502);
});
