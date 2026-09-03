type ApiPredictionResponse = {
  errors?: Record<string, string> | string[];
  response?: Array<{
    predictions?: {
      winner?: { id?: number; name?: string; comment?: string };
      win_or_draw?: boolean;
      under_over?: string;
      goals?: { home?: string; away?: string };
      advice?: string;
      percent?: { home?: string; draw?: string; away?: string };
    };
    teams?: {
      home?: { id?: number; name?: string };
      away?: { id?: number; name?: string };
    };
    comparison?: {
      total?: { home?: string; away?: string };
    };
  }>;
};

import {
  SharedCacheBusyError,
  getOrRefreshShared,
  type SharedCacheResult,
  type SharedCacheStore,
} from "../../lib/shared-api-cache.ts";
import { getD1ApiResponseCache } from "../../../db/api-response-cache.ts";

const API_BASE = "https://v3.football.api-sports.io";
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_STALE_MS = 60 * 60 * 1000;

async function getApiKey() {
  const { env } = await import("cloudflare:workers");
  const value = (env as unknown as Record<string, unknown>).API_FOOTBALL_KEY;
  if (typeof value !== "string" || !value.trim()) throw new Error("API_FOOTBALL_KEY가 설정되지 않았습니다.");
  return value.trim();
}

function hasErrors(errors: ApiPredictionResponse["errors"]) {
  return Boolean(errors && (Array.isArray(errors) ? errors.length : Object.keys(errors).length));
}

export type PredictionsRouteDependencies = {
  cacheStoreLoader?: () => Promise<SharedCacheStore>;
  apiKeyLoader?: () => Promise<string>;
  fetcher?: typeof fetch;
  now?: () => number;
  token?: () => string;
  inFlight?: Map<string, Promise<SharedCacheResult<unknown>>>;
};

export function createPredictionsGetHandler(dependencies: PredictionsRouteDependencies = {}) {
  const cacheStoreLoader = dependencies.cacheStoreLoader ?? getD1ApiResponseCache;
  const apiKeyLoader = dependencies.apiKeyLoader ?? getApiKey;
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;

  return async function GET(request: Request) {
    const fixtureId = Number(new URL(request.url).searchParams.get("fixture"));
    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return Response.json({ error: "올바른 경기 ID가 필요합니다." }, { status: 400 });
    }

    let store: SharedCacheStore;
    try {
      store = await cacheStoreLoader();
    } catch {
      return Response.json({ error: "공유 캐시를 사용할 수 없습니다." }, { status: 503 });
    }

    try {
      const result = await getOrRefreshShared({
        key: `predictions:v1:${fixtureId}`,
        ttlMs: CACHE_TTL_MS,
        staleTtlMs: CACHE_STALE_MS,
        store,
        now,
        token: dependencies.token,
        inFlight: dependencies.inFlight,
        load: async () => {
    const apiKey = await apiKeyLoader();
    const response = await fetcher(`${API_BASE}/predictions?fixture=${fixtureId}`, {
      headers: { "x-apisports-key": apiKey },
    });
    const body = await response.json() as ApiPredictionResponse;
    if (!response.ok) throw new Error(`API-Football Predictions 요청 실패 (${response.status})`);
    if (hasErrors(body.errors)) throw new Error(`API-Football Predictions 응답 오류: ${JSON.stringify(body.errors)}`);

    const item = body.response?.[0];
    const prediction = item?.predictions;
    const payload = {
      source: "API-Football Predictions",
      fixtureId,
      fetchedAt: new Date(now()).toISOString(),
      prediction: prediction ? {
        winner: {
          id: prediction.winner?.id ?? null,
          name: prediction.winner?.name ?? "",
          comment: prediction.winner?.comment ?? "",
        },
        winOrDraw: prediction.win_or_draw ?? false,
        underOver: prediction.under_over ?? "",
        goals: {
          home: prediction.goals?.home ?? "",
          away: prediction.goals?.away ?? "",
        },
        advice: prediction.advice ?? "",
        percent: {
          home: prediction.percent?.home ?? "0%",
          draw: prediction.percent?.draw ?? "0%",
          away: prediction.percent?.away ?? "0%",
        },
        teams: {
          homeId: item.teams?.home?.id ?? null,
          awayId: item.teams?.away?.id ?? null,
        },
        comparison: {
          home: item.comparison?.total?.home ?? "0%",
          away: item.comparison?.total?.away ?? "0%",
        },
      } : null,
    };
          return payload;
        },
      });
      return Response.json(result.value, { headers: { "X-Cache-Status": result.cacheStatus } });
  } catch (error) {
      const status = error instanceof SharedCacheBusyError ? 503 : 502;
      return Response.json({ error: error instanceof Error ? error.message : "경기 예측을 불러오지 못했습니다." }, { status });
    }
  }
}

export const GET = createPredictionsGetHandler();
