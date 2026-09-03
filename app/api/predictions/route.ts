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

const API_BASE = "https://v3.football.api-sports.io";
const CACHE_TTL_MS = 10 * 60 * 1000;
const predictionCache = new Map<number, { expiresAt: number; payload: unknown }>();

async function getApiKey() {
  const { env } = await import("cloudflare:workers");
  const value = (env as unknown as Record<string, unknown>).API_FOOTBALL_KEY;
  if (typeof value !== "string" || !value.trim()) throw new Error("API_FOOTBALL_KEY가 설정되지 않았습니다.");
  return value.trim();
}

function hasErrors(errors: ApiPredictionResponse["errors"]) {
  return Boolean(errors && (Array.isArray(errors) ? errors.length : Object.keys(errors).length));
}

export async function GET(request: Request) {
  try {
    const fixtureId = Number(new URL(request.url).searchParams.get("fixture"));
    if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
      return Response.json({ error: "올바른 경기 ID가 필요합니다." }, { status: 400 });
    }

    const cached = predictionCache.get(fixtureId);
    if (cached && cached.expiresAt > Date.now()) return Response.json(cached.payload);

    const apiKey = await getApiKey();
    const response = await fetch(`${API_BASE}/predictions?fixture=${fixtureId}`, {
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
      fetchedAt: new Date().toISOString(),
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
    predictionCache.set(fixtureId, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
    return Response.json(payload);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "경기 예측을 불러오지 못했습니다." }, { status: 502 });
  }
}
