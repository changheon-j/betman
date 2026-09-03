import {
  HeadToHeadProviderError,
  parseHeadToHeadQuery,
  requestHeadToHead,
  type HeadToHeadQuery,
  type HeadToHeadPayload,
} from "../../lib/head-to-head.ts";
import {
  SharedCacheBusyError,
  SharedCacheStorageError,
  getOrRefreshShared,
  type SharedCacheResult,
  type SharedCacheStore,
} from "../../lib/shared-api-cache.ts";
import { getD1ApiResponseCache } from "../../../db/api-response-cache.ts";

const CACHE_SECONDS = 1800;
const CACHE_TTL_MS = CACHE_SECONDS * 1000;
const CACHE_STALE_MS = 24 * 60 * 60 * 1000;

export type HeadToHeadRouteDependencies = {
  cacheStoreLoader?: () => Promise<SharedCacheStore>;
  apiKeyLoader?: () => Promise<string>;
  fetcher?: typeof fetch;
  now?: () => number;
  token?: () => string;
  inFlight?: Map<string, Promise<SharedCacheResult<unknown>>>;
};

async function getApiKey(): Promise<string> {
  const { env } = await import("cloudflare:workers");
  const value = (env as unknown as Record<string, unknown>).API_FOOTBALL_KEY;
  if (typeof value !== "string" || !value.trim()) throw new Error("API_FOOTBALL_KEY is not configured");
  return value.trim();
}

function cacheKey(query: HeadToHeadQuery): string {
  return `head-to-head:v1:${query.fixtureId}:${query.homeTeamId}:${query.awayTeamId}:${query.kickoffAt}`;
}

export function createHeadToHeadGetHandler(dependencies: HeadToHeadRouteDependencies = {}) {
  const cacheStoreLoader = dependencies.cacheStoreLoader ?? getD1ApiResponseCache;
  const apiKeyLoader = dependencies.apiKeyLoader ?? getApiKey;
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;

  return async function GET(request: Request) {
    let query: HeadToHeadQuery;
    try {
      query = parseHeadToHeadQuery(new URL(request.url).searchParams);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid head-to-head query" }, { status: 400 });
    }

    let store: SharedCacheStore;
    try {
      store = await cacheStoreLoader();
    } catch {
      return Response.json({ error: "Shared cache is unavailable" }, { status: 503 });
    }

    try {
      const result = await getOrRefreshShared<HeadToHeadPayload>({
        key: cacheKey(query),
        ttlMs: CACHE_TTL_MS,
        staleTtlMs: CACHE_STALE_MS,
        store,
        now,
        token: dependencies.token,
        inFlight: dependencies.inFlight,
        load: async () => ({
          fixtureId: query.fixtureId,
          fetchedAt: new Date(now()).toISOString(),
          cacheSeconds: CACHE_SECONDS,
          matches: await requestHeadToHead(query, await apiKeyLoader(), fetcher),
        }),
      });
      return Response.json(result.value, { headers: { "X-Cache-Status": result.cacheStatus } });
    } catch (error) {
      const status = error instanceof HeadToHeadProviderError
        ? error.status
        : error instanceof SharedCacheBusyError || error instanceof SharedCacheStorageError ? 503 : 502;
      return Response.json({ error: "Unable to load head-to-head" }, { status });
    }
  };
}

export const GET = createHeadToHeadGetHandler();
