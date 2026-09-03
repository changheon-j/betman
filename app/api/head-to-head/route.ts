import {
  HeadToHeadProviderError,
  parseHeadToHeadQuery,
  requestHeadToHead,
  type HeadToHeadMatch,
  type HeadToHeadQuery,
  type HeadToHeadPayload,
} from "../../lib/head-to-head.ts";

type CachedHeadToHead = {
  expiresAt: number;
  fetchedAt: string;
  matches: HeadToHeadMatch[];
};

const CACHE_SECONDS = 1800;
const CACHE_TTL_MS = CACHE_SECONDS * 1000;
const MAX_CACHE_ENTRIES = 100;

export type HeadToHeadRouteDependencies = {
  apiKeyLoader?: () => Promise<string>;
  fetcher?: typeof fetch;
  now?: () => number;
  cache?: Map<string, CachedHeadToHead>;
};

async function getApiKey(): Promise<string> {
  const { env } = await import("cloudflare:workers");
  const value = (env as unknown as Record<string, unknown>).API_FOOTBALL_KEY;
  if (typeof value !== "string" || !value.trim()) throw new Error("API_FOOTBALL_KEY is not configured");
  return value.trim();
}

function cacheKey(query: HeadToHeadQuery): string {
  return `${query.fixtureId}:${query.homeTeamId}:${query.awayTeamId}:${query.kickoffAt}`;
}

function responsePayload(fixtureId: number, cached: CachedHeadToHead): HeadToHeadPayload {
  return {
    fixtureId,
    fetchedAt: cached.fetchedAt,
    cacheSeconds: CACHE_SECONDS,
    matches: cached.matches,
  };
}

function cacheHeadToHead(cache: Map<string, CachedHeadToHead>, key: string, cached: CachedHeadToHead) {
  cache.delete(key);
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, cached);
}

export function createHeadToHeadGetHandler(dependencies: HeadToHeadRouteDependencies = {}) {
  const apiKeyLoader = dependencies.apiKeyLoader ?? getApiKey;
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  const cache = dependencies.cache ?? new Map<string, CachedHeadToHead>();

  return async function GET(request: Request) {
    let query: HeadToHeadQuery;
    try {
      query = parseHeadToHeadQuery(new URL(request.url).searchParams);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Invalid head-to-head query" }, { status: 400 });
    }

    const key = cacheKey(query);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      return Response.json(responsePayload(query.fixtureId, cached));
    }

    try {
      const matches = await requestHeadToHead(query, await apiKeyLoader(), fetcher);
      const requestedAt = now();
      const nextCached = {
        expiresAt: requestedAt + CACHE_TTL_MS,
        fetchedAt: new Date(requestedAt).toISOString(),
        matches,
      };
      cacheHeadToHead(cache, key, nextCached);
      return Response.json(responsePayload(query.fixtureId, nextCached));
    } catch (error) {
      const status = error instanceof HeadToHeadProviderError ? error.status : 502;
      return Response.json({ error: "Unable to load head-to-head" }, { status });
    }
  };
}

export const GET = createHeadToHeadGetHandler();
