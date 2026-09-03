import {
  normalizePreMatchOdds,
  parseFixtureId,
  type PreMatchOddsPayload,
} from "../../lib/pre-match-odds.ts";

type ApiOddsResponse = {
  errors?: Record<string, string> | string[];
  response?: unknown[];
};

type CachedOdds = {
  expiresAt: number;
  payload: PreMatchOddsPayload;
  fetchedAt: string;
};

const API_BASE = "https://v3.football.api-sports.io";
const CACHE_SECONDS = 1800;
const CACHE_TTL_MS = CACHE_SECONDS * 1000;
const MAX_CACHE_ENTRIES = 100;
const oddsCache = new Map<number, CachedOdds>();

async function getApiKey() {
  const { env } = await import("cloudflare:workers");
  const value = (env as unknown as Record<string, unknown>).API_FOOTBALL_KEY;
  if (typeof value !== "string" || !value.trim()) throw new Error("API_FOOTBALL_KEY is not configured");
  return value.trim();
}

function hasErrors(errors: ApiOddsResponse["errors"]) {
  return Boolean(errors && (Array.isArray(errors) ? errors.length : Object.keys(errors).length));
}

function responsePayload(cached: CachedOdds) {
  return { ...cached.payload, fetchedAt: cached.fetchedAt, cacheSeconds: CACHE_SECONDS };
}

function cacheOdds(fixtureId: number, cached: CachedOdds) {
  if (!oddsCache.has(fixtureId) && oddsCache.size >= MAX_CACHE_ENTRIES) {
    const oldestFixtureId = oddsCache.keys().next().value;
    if (oldestFixtureId !== undefined) oddsCache.delete(oldestFixtureId);
  }
  oddsCache.set(fixtureId, cached);
}

export async function GET(request: Request) {
  let fixtureId: number;
  try {
    fixtureId = parseFixtureId(new URL(request.url).searchParams.get("fixture"));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid fixture" }, { status: 400 });
  }

  const cached = oddsCache.get(fixtureId);
  if (cached && cached.expiresAt > Date.now()) return Response.json(responsePayload(cached));

  try {
    const apiKey = await getApiKey();
    const response = await fetch(`${API_BASE}/odds?fixture=${fixtureId}`, {
      headers: { "x-apisports-key": apiKey },
    });
    const body = await response.json() as ApiOddsResponse;
    if (!response.ok) throw new Error(`API-Football odds request failed (${response.status})`);
    if (hasErrors(body.errors)) throw new Error(`API-Football odds response error: ${JSON.stringify(body.errors)}`);

    const fetchedAt = new Date().toISOString();
    const payload = normalizePreMatchOdds(fixtureId, Array.isArray(body.response) ? body.response : []);
    const nextCached = { expiresAt: Date.now() + CACHE_TTL_MS, payload, fetchedAt };
    cacheOdds(fixtureId, nextCached);
    return Response.json(responsePayload(nextCached));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to load pre-match odds" }, { status: 502 });
  }
}
