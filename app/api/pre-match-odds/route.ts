import {
  normalizePreMatchOdds,
  parseFixtureId,
  type PreMatchOddsPayload,
} from "../../lib/pre-match-odds.ts";
import {
  SharedCacheBusyError,
  SharedCacheStorageError,
  getOrRefreshShared,
  type SharedCacheResult,
  type SharedCacheStore,
} from "../../lib/shared-api-cache.ts";
import { getD1ApiResponseCache } from "../../../db/api-response-cache.ts";

type ApiOddsResponse = {
  errors?: Record<string, string> | string[];
  response?: unknown[];
};

const API_BASE = "https://v3.football.api-sports.io";
const CACHE_SECONDS = 1800;
const CACHE_TTL_MS = CACHE_SECONDS * 1000;
const CACHE_STALE_MS = 2 * 60 * 60 * 1000;

async function getApiKey() {
  const { env } = await import("cloudflare:workers");
  const value = (env as unknown as Record<string, unknown>).API_FOOTBALL_KEY;
  if (typeof value !== "string" || !value.trim()) throw new Error("API_FOOTBALL_KEY is not configured");
  return value.trim();
}

function hasErrors(errors: ApiOddsResponse["errors"]) {
  return Boolean(errors && (Array.isArray(errors) ? errors.length : Object.keys(errors).length));
}

type PreMatchOddsResponse = PreMatchOddsPayload & { fetchedAt: string; cacheSeconds: number };

export type PreMatchOddsRouteDependencies = {
  cacheStoreLoader?: () => Promise<SharedCacheStore>;
  apiKeyLoader?: () => Promise<string>;
  fetcher?: typeof fetch;
  now?: () => number;
  token?: () => string;
  inFlight?: Map<string, Promise<SharedCacheResult<unknown>>>;
};

export function createPreMatchOddsGetHandler(dependencies: PreMatchOddsRouteDependencies = {}) {
  const cacheStoreLoader = dependencies.cacheStoreLoader ?? getD1ApiResponseCache;
  const apiKeyLoader = dependencies.apiKeyLoader ?? getApiKey;
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;

  return async function GET(request: Request) {
    let fixtureId: number;
    try {
      fixtureId = parseFixtureId(new URL(request.url).searchParams.get("fixture"));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid fixture" }, { status: 400 });
    }

    let store: SharedCacheStore;
    try {
      store = await cacheStoreLoader();
    } catch {
      return Response.json({ error: "Shared cache is unavailable" }, { status: 503 });
    }

    try {
      const result = await getOrRefreshShared<PreMatchOddsResponse>({
        key: `pre-match-odds:v1:${fixtureId}`,
        ttlMs: CACHE_TTL_MS,
        staleTtlMs: CACHE_STALE_MS,
        store,
        now,
        token: dependencies.token,
        inFlight: dependencies.inFlight,
        load: async () => {
    const apiKey = await apiKeyLoader();
    const response = await fetcher(`${API_BASE}/odds?fixture=${fixtureId}`, {
      headers: { "x-apisports-key": apiKey },
    });
    const body = await response.json() as ApiOddsResponse;
    if (!response.ok) throw new Error(`API-Football odds request failed (${response.status})`);
    if (hasErrors(body.errors)) throw new Error(`API-Football odds response error: ${JSON.stringify(body.errors)}`);

    const payload = normalizePreMatchOdds(fixtureId, Array.isArray(body.response) ? body.response : []);
          return { ...payload, fetchedAt: new Date(now()).toISOString(), cacheSeconds: CACHE_SECONDS };
        },
      });
      return Response.json(result.value, { headers: { "X-Cache-Status": result.cacheStatus } });
  } catch (error) {
      const status = error instanceof SharedCacheBusyError || error instanceof SharedCacheStorageError ? 503 : 502;
      return Response.json({ error: error instanceof Error ? error.message : "Unable to load pre-match odds" }, { status });
    }
  }
}

export const GET = createPreMatchOddsGetHandler();
