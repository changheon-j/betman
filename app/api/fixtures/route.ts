import {
  buildLeaguePayload,
  extractOfficialStandings,
  mergeLeaguePayloads,
  type ApiFixture,
  type ApiStandingEnvelope,
  type FulfilledLeaguePayload,
  type LeaguePayload,
  type RejectedLeaguePayload,
} from "../../lib/fixture-data.ts";
import { resolveLeagueSeason, SUPPORTED_LEAGUES, type LeagueConfig } from "../../lib/leagues.ts";
import {
  SharedCacheBusyError,
  SharedCacheStorageError,
  getOrRefreshShared,
  type SharedCacheResult,
  type SharedCacheStore,
} from "../../lib/shared-api-cache.ts";
import { getD1ApiResponseCache } from "../../../db/api-response-cache.ts";

type ApiResponse<T> = {
  errors?: Record<string, string> | string[];
  response?: T[];
};

type LeagueDates = {
  season: number;
  seasonStart: string;
  today: string;
  rangeEnd: string;
  statsThrough: string;
};

const API_BASE = "https://v3.football.api-sports.io";
const KOREA_TIME_ZONE = "Asia/Seoul";
const FIXTURE_WINDOW_DAYS = 14;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_STALE_MS = 60 * 60 * 1000;

function getKoreanToday(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KOREA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00+09:00`);
  value.setUTCDate(value.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: KOREA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

async function getApiKey() {
  const { env } = await import("cloudflare:workers");
  const value = (env as unknown as Record<string, unknown>).API_FOOTBALL_KEY;
  if (typeof value !== "string" || !value.trim()) throw new Error("API_FOOTBALL_KEY가 설정되지 않았습니다.");
  return value.trim();
}

async function fetchApi<T>(path: string, apiKey: string, fetcher: typeof fetch) {
  const response = await fetcher(`${API_BASE}${path}`, { headers: { "x-apisports-key": apiKey } });
  const payload = await response.json() as ApiResponse<T>;
  if (!response.ok) throw new Error(`API-Football 요청 실패 (${response.status})`);
  const errors = payload.errors;
  if (errors && (Array.isArray(errors) ? errors.length : Object.keys(errors).length)) {
    throw new Error(`API-Football 응답 오류: ${JSON.stringify(errors)}`);
  }
  return payload.response ?? [];
}

async function loadLeague(league: LeagueConfig, apiKey: string, dates: LeagueDates, fetcher: typeof fetch): Promise<LeaguePayload> {
  const fixtures = await fetchApi<ApiFixture>(
    `/fixtures?league=${league.id}&season=${dates.season}&from=${dates.seasonStart}&to=${dates.rangeEnd}&timezone=Asia%2FSeoul`,
    apiKey,
    fetcher,
  );
  const standingResponses = await fetchApi<ApiStandingEnvelope>(
    `/standings?league=${league.id}&season=${dates.season}`,
    apiKey,
    fetcher,
  );
  const upcoming = fixtures.filter((item) => item.fixture.date.slice(0, 10) >= dates.today
    && ["NS", "TBD"].includes(item.fixture.status.short));
  const past = fixtures.filter((item) => item.fixture.date.slice(0, 10) <= dates.statsThrough);
  return buildLeaguePayload(league, upcoming, past, extractOfficialStandings(standingResponses));
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : "경기 일정을 불러오지 못했습니다.";
}

type FixturesPayload = {
  source: string;
  leagueId: number;
  today: string;
  rangeEnd: string;
  statsThrough: string;
  fetchedAt: string;
  matches: ReturnType<typeof mergeLeaguePayloads>["matches"];
  standingsByLeague: ReturnType<typeof mergeLeaguePayloads>["standingsByLeague"];
  leagueErrors: ReturnType<typeof mergeLeaguePayloads>["leagueErrors"];
  leagues: Array<{ id: number; code: string; name: string; apiName: string; season: number }>;
  standings: LeaguePayload["standings"];
};

export type FixturesRouteDependencies = {
  cacheStoreLoader?: () => Promise<SharedCacheStore>;
  apiKeyLoader?: () => Promise<string>;
  fetcher?: typeof fetch;
  now?: () => number;
  token?: () => string;
  inFlight?: Map<string, Promise<SharedCacheResult<unknown>>>;
};

export function createFixturesGetHandler(dependencies: FixturesRouteDependencies = {}) {
  const cacheStoreLoader = dependencies.cacheStoreLoader ?? getD1ApiResponseCache;
  const apiKeyLoader = dependencies.apiKeyLoader ?? getApiKey;
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;

  return async function GET() {
    const today = getKoreanToday(now());
    let store: SharedCacheStore;
    try {
      store = await cacheStoreLoader();
    } catch {
      return Response.json({ error: "공유 캐시를 사용할 수 없습니다." }, { status: 503 });
    }

    try {
      const result = await getOrRefreshShared<FixturesPayload>({
        key: `fixtures:v1:${today}`,
        ttlMs: CACHE_TTL_MS,
        staleTtlMs: CACHE_STALE_MS,
        store,
        now,
        token: dependencies.token,
        inFlight: dependencies.inFlight,
        canStore: (payload) => Object.keys(payload.leagueErrors).length === 0,
        load: async () => {
          const apiKey = await apiKeyLoader();
    const rangeEnd = addDays(today, FIXTURE_WINDOW_DAYS);
    const statsThrough = addDays(today, -1);
    const leagueContexts = SUPPORTED_LEAGUES.map((league) => ({
      league,
      dates: { ...resolveLeagueSeason(league, today), today, rangeEnd, statsThrough },
    }));
    const results: Array<FulfilledLeaguePayload | RejectedLeaguePayload> = [];
    for (const { league, dates } of leagueContexts) {
      try {
        results.push({ status: "fulfilled", league, ...(await loadLeague(league, apiKey, dates, fetcher)) });
      } catch (reason) {
        results.push({ status: "rejected", league, reason });
      }
    }
    const merged = mergeLeaguePayloads(results);

          return {
      source: "API-Football",
      leagueId: SUPPORTED_LEAGUES[0].id,
      today,
      rangeEnd,
      statsThrough,
      fetchedAt: new Date(now()).toISOString(),
      ...merged,
      leagues: leagueContexts.map(({ league, dates }) => ({
        id: league.id,
        code: league.code,
        name: league.name,
        apiName: league.apiName,
        season: dates.season,
      })),
      standings: merged.standingsByLeague.K1 ?? [],
          };
        },
      });

      if (Object.keys(result.value.standingsByLeague).length === 0) {
        return Response.json({ error: "모든 리그의 경기 데이터를 불러오지 못했습니다.", leagueErrors: result.value.leagueErrors }, { status: 502 });
      }
      return Response.json(result.value, { headers: { "X-Cache-Status": result.cacheStatus } });
  } catch (error) {
      const status = error instanceof SharedCacheBusyError || error instanceof SharedCacheStorageError ? 503 : 502;
      return Response.json({ error: errorMessage(error) }, { status });
    }
  }
}

export const GET = createFixturesGetHandler();
