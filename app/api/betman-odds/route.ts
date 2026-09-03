import { parseBetmanPayload, type BetmanFixture } from "../../lib/betman-parser";
import { replaceCacheAfterPersist } from "../../lib/betman-round-state";

type RoundSource = {
  sourceUrl: string;
  gmId: string;
  gmTs: string;
  updatedAt: string;
};

const BETMAN_ORIGIN = "https://www.betman.co.kr";
const CACHE_TTL_MS = 10 * 60 * 1000;

let roundCache: { sourceKey: string; expiresAt: number; fixtures: BetmanFixture[]; fetchedAt: string } | null = null;

async function getD1() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS betman_round_sources (
      slot INTEGER PRIMARY KEY,
      source_url TEXT NOT NULL,
      gm_id TEXT NOT NULL,
      gm_ts TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  return env.DB;
}

function parseSourceUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Betman 회차 URL을 입력해 주세요.");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("올바른 URL 형식이 아닙니다.");
  }
  if (url.protocol !== "https:" || !["betman.co.kr", "www.betman.co.kr"].includes(url.hostname.toLowerCase())) {
    throw new Error("betman.co.kr의 HTTPS URL만 사용할 수 있습니다.");
  }
  if (url.pathname !== "/main/mainPage/gamebuy/gameSlip.do") {
    throw new Error("프로토 승부식 구매투표지 URL을 입력해 주세요.");
  }
  const gmId = url.searchParams.get("gmId")?.trim() ?? "";
  const gmTs = url.searchParams.get("gmTs")?.trim() ?? "";
  if (gmId !== "G101" || !/^\d+$/.test(gmTs)) throw new Error("프로토 승부식 회차 URL(gmId=G101)이 아닙니다.");
  const normalized = new URL(url.pathname, BETMAN_ORIGIN);
  normalized.searchParams.set("gmId", gmId);
  normalized.searchParams.set("gmTs", gmTs);
  return { sourceUrl: normalized.toString(), gmId, gmTs };
}

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function cookiesFrom(response: Response) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") as string] : []);
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

async function fetchRound(source: RoundSource, cacheResult = true) {
  const sourceKey = `${source.gmId}:${source.gmTs}`;
  if (roundCache?.sourceKey === sourceKey && roundCache.expiresAt > Date.now()) return roundCache;
  let pageResponse: Response;
  try {
    pageResponse = await fetch(source.sourceUrl, { headers: { accept: "text/html,application/xhtml+xml" } });
  } catch (error) {
    throw new Error(`Betman 회차 화면 연결 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!pageResponse.ok) throw new Error(`Betman 회차 화면을 불러오지 못했습니다. (${pageResponse.status})`);
  const cookie = cookiesFrom(pageResponse);
  let response: Response;
  try {
    response = await fetch(`${BETMAN_ORIGIN}/buyPsblGame/gameInfoInq.do`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=UTF-8", accept: "application/json, text/javascript, */*; q=0.01",
        referer: source.sourceUrl, "x-requested-with": "XMLHttpRequest",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ gmId: source.gmId, gmTs: source.gmTs, gameYear: "", _sbmInfo: { _sbmInfo: { debugMode: "false" } } }),
    });
  } catch (error) {
    throw new Error(`Betman 배당 연결 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`Betman 배당 데이터를 불러오지 못했습니다. (${response.status})`);
  const payload = await response.json() as unknown;
  const result = { sourceKey, expiresAt: Date.now() + CACHE_TTL_MS, fixtures: parseBetmanPayload(payload), fetchedAt: new Date().toISOString() };
  if (cacheResult) roundCache = result;
  return result;
}

async function loadSource(database: D1Database) {
  const row = await database.prepare("SELECT source_url, gm_id, gm_ts, updated_at FROM betman_round_sources WHERE slot = 1").first<Record<string, unknown>>();
  if (!row) return null;
  return { sourceUrl: text(row.source_url), gmId: text(row.gm_id), gmTs: text(row.gm_ts), updatedAt: text(row.updated_at) } satisfies RoundSource;
}

export async function GET() {
  try {
    const database = await getD1();
    const source = await loadSource(database);
    if (!source) return Response.json({ configured: false, fixtures: [] });
    const result = await fetchRound(source);
    return Response.json({ configured: true, ...source, fixtures: result.fixtures, fetchedAt: result.fetchedAt, cacheSeconds: CACHE_TTL_MS / 1000 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Betman 배당을 불러오지 못했습니다." }, { status: 502 });
  }
}

export async function PUT(request: Request) {
  try {
    const parsed = parseSourceUrl((await request.json() as { sourceUrl?: unknown }).sourceUrl);
    const database = await getD1();
    const updatedAt = new Date().toISOString();
    const source = { ...parsed, updatedAt };
    const result = await fetchRound(source, false);
    roundCache = await replaceCacheAfterPersist(result, () => database.batch([
      database.prepare("DELETE FROM betman_round_sources WHERE slot = 1"),
      database.prepare("INSERT INTO betman_round_sources (slot, source_url, gm_id, gm_ts, updated_at) VALUES (1, ?, ?, ?, ?)").bind(source.sourceUrl, source.gmId, source.gmTs, source.updatedAt),
    ]));
    return Response.json({ configured: true, ...source, fixtures: result.fixtures, fetchedAt: result.fetchedAt, cacheSeconds: CACHE_TTL_MS / 1000 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "회차 URL을 저장하지 못했습니다." }, { status: 400 });
  }
}
