import {
  buildLeaguePayload,
  extractOfficialStandings,
  mergeLeaguePayloads,
  type ApiFixture,
  type ApiStandingEnvelope,
  type LeaguePayload,
} from "../../lib/fixture-data.ts";
import { resolveLeagueSeason, SUPPORTED_LEAGUES, type LeagueConfig } from "../../lib/leagues.ts";

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

let fixtureCache: { expiresAt: number; payload: unknown } | null = null;

function getKoreanToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KOREA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
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

async function fetchApi<T>(path: string, apiKey: string) {
  const response = await fetch(`${API_BASE}${path}`, { headers: { "x-apisports-key": apiKey } });
  const payload = await response.json() as ApiResponse<T>;
  if (!response.ok) throw new Error(`API-Football 요청 실패 (${response.status})`);
  const errors = payload.errors;
  if (errors && (Array.isArray(errors) ? errors.length : Object.keys(errors).length)) {
    throw new Error(`API-Football 응답 오류: ${JSON.stringify(errors)}`);
  }
  return payload.response ?? [];
}

async function loadLeague(league: LeagueConfig, apiKey: string, dates: LeagueDates): Promise<LeaguePayload> {
  const [upcomingResponse, past, standingResponses] = await Promise.all([
    fetchApi<ApiFixture>(`/fixtures?league=${league.id}&season=${dates.season}&from=${dates.today}&to=${dates.rangeEnd}&timezone=Asia%2FSeoul`, apiKey),
    dates.statsThrough >= dates.seasonStart
      ? fetchApi<ApiFixture>(`/fixtures?league=${league.id}&season=${dates.season}&from=${dates.seasonStart}&to=${dates.statsThrough}&timezone=Asia%2FSeoul`, apiKey)
      : Promise.resolve([]),
    fetchApi<ApiStandingEnvelope>(`/standings?league=${league.id}&season=${dates.season}`, apiKey),
  ]);
  const upcoming = upcomingResponse.filter((item) => ["NS", "TBD"].includes(item.fixture.status.short));
  return buildLeaguePayload(league, upcoming, past, extractOfficialStandings(standingResponses));
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : "경기 일정을 불러오지 못했습니다.";
}

export async function GET() {
  if (fixtureCache && fixtureCache.expiresAt > Date.now()) return Response.json(fixtureCache.payload);
  try {
    const apiKey = await getApiKey();
    const today = getKoreanToday();
    const rangeEnd = addDays(today, FIXTURE_WINDOW_DAYS);
    const statsThrough = addDays(today, -1);
    const leagueContexts = SUPPORTED_LEAGUES.map((league) => ({
      league,
      dates: { ...resolveLeagueSeason(league, today), today, rangeEnd, statsThrough },
    }));
    const results = await Promise.allSettled(leagueContexts.map(async ({ league, dates }) => ({
      status: "fulfilled" as const,
      league,
      ...(await loadLeague(league, apiKey, dates)),
    })));
    const merged = mergeLeaguePayloads(results.map((result, index) => result.status === "fulfilled"
      ? result.value
      : { status: "rejected" as const, league: SUPPORTED_LEAGUES[index], reason: result.reason }));

    if (Object.keys(merged.standingsByLeague).length === 0) {
      return Response.json({ error: "모든 리그의 경기 데이터를 불러오지 못했습니다.", leagueErrors: merged.leagueErrors }, { status: 502 });
    }

    const payload = {
      source: "API-Football",
      leagueId: SUPPORTED_LEAGUES[0].id,
      today,
      rangeEnd,
      statsThrough,
      fetchedAt: new Date().toISOString(),
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
    fixtureCache = { expiresAt: Date.now() + CACHE_TTL_MS, payload };
    return Response.json(payload);
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 502 });
  }
}
