import { OddsHistoryValidationError } from "./odds-history-contract.ts";
import type { ClosedRoundDocument, ClosedRoundRef } from "./betman-history-types.ts";

export const BETMAN_HISTORY_ORIGIN = "https://www.betman.co.kr";
export const BETMAN_TIMEOUT_MS = 15_000;
export const BETMAN_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const BETMAN_MAX_REDIRECTS = 5;

export type AnonymousSession = { cookie: string };

export interface BetmanClosedAdapter {
  discoverRounds(from: string, to: string, session: AnonymousSession): Promise<ClosedRoundRef[]>;
  fetchRound(round: ClosedRoundRef, session: AnonymousSession): Promise<ClosedRoundDocument>;
}

const ENTRY_PATH = "/main/mainPage/gamebuy/closedGameList.do";
const SLIP_PATH = "/main/mainPage/gamebuy/closedGameSlip.do";
const DETAIL_PATH = "/buyPsblGame/gameInfoInq.do";
const CLOSED_LIST_PATH = "/buyPsblGame/closedList.do";
const HTML_ACCEPT = "text/html,application/xhtml+xml";
const JSON_ACCEPT = "application/json, text/javascript, */*; q=0.01";
const FINAL_STATES = new Set(["FINAL", "CLOSED", "COMPLETED", "확정", "마감"]);
const PENDING_STATES = new Set(["PENDING", "OPEN", "미확정", "진행중"]);

type LimitedResponse = { response: Response; bytes: Uint8Array };
type ParsedPage = { rounds: ClosedRoundRef[]; nextPage: URL | null; candidateCount: number; oldestClosedDate: string | null };
type ProviderCode = "BETMAN_UNAVAILABLE" | "BETMAN_SCHEMA_CHANGED";

export async function createAnonymousSession(fetchImpl: typeof fetch = fetch): Promise<AnonymousSession> {
  const { response, bytes } = await limitedFetch(fetchImpl, `${BETMAN_HISTORY_ORIGIN}${ENTRY_PATH}`, {
    headers: { accept: HTML_ACCEPT },
  });
  assertHttpOk(response, "마감게임 화면");
  const page = decodeHtml(response, bytes);
  const finalUrl = new URL(response.url || `${BETMAN_HISTORY_ORIGIN}${ENTRY_PATH}`);
  if (finalUrl.pathname !== ENTRY_PATH) throw providerError("BETMAN_SCHEMA_CHANGED", "마감게임 세션 경로가 바뀌었습니다.");
  assertSafeHtml(page);
  return { cookie: extractSessionCookie(response.headers) };
}

export function createBetmanClosedAdapter(fetchImpl: typeof fetch = fetch): BetmanClosedAdapter {
  return {
    discoverRounds: (from, to, session) => discoverClosedRounds(fetchImpl, from, to, session),
    fetchRound: (round, session) => fetchClosedRound(fetchImpl, round, session),
  };
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: 2,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit !== 2) throw new RangeError("Betman detail concurrency must be exactly 2.");
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function discoverClosedRounds(
  fetchImpl: typeof fetch,
  from: string,
  to: string,
  session: AnonymousSession,
): Promise<ClosedRoundRef[]> {
  assertDateRange(from, to);
  const cookie = sessionCookie(session);
  const discovered = new Map<string, ClosedRoundRef>();
  const visited = new Set<string>();
  let pageNumber = 1;
  const paddedFrom = shiftCalendarDate(from, -7);

  while (pageNumber <= 150) {
    const current = `${BETMAN_HISTORY_ORIGIN}${CLOSED_LIST_PATH}`;
    if (visited.has(current)) throw providerError("BETMAN_SCHEMA_CHANGED", "마감게임 페이지 순환을 감지했습니다.");
    visited.add(`${current}?page=${pageNumber}`);
    const { response, bytes } = await limitedFetch(fetchImpl, current, {
      method: "POST",
      headers: {
        accept: JSON_ACCEPT,
        "content-type": "application/json; charset=UTF-8",
        cookie,
        referer: closedListUrl(pageNumber).toString(),
        "x-requested-with": "XMLHttpRequest",
      },
      body: JSON.stringify({ gmId: "G101", draw: pageNumber, start: (pageNumber - 1) * 10, length: 10, _sbmInfo: { _sbmInfo: { debugMode: "false" } } }),
    });
    assertHttpOk(response, "마감게임 목록");
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const parsed = contentType.includes("json")
      ? parseClosedRoundListPayload(decodeJson(response, bytes), from, to)
      : parseClosedRoundPage(decodeHtml(response, bytes), from, to);
    for (const round of parsed.rounds) discovered.set(`${round.gmId}:${round.gmTs}`, round);
    if (parsed.nextPage) {
      pageNumber += 1;
      continue;
    }
    if ((parsed.oldestClosedDate && parsed.oldestClosedDate < paddedFrom) || parsed.candidateCount < 10) break;
    pageNumber += 1;
  }

  return [...discovered.values()].sort((left, right) => compareNumericStrings(right.gmTs, left.gmTs));
}

function parseClosedRoundListPayload(payload: unknown, requestedFrom: string, requestedTo: string): ParsedPage {
  if (!isRecord(payload) || !isRecord(payload.schedules) || !Array.isArray(payload.schedules.data)) {
    throw providerError("BETMAN_SCHEMA_CHANGED", "마감게임 목록 JSON 구조가 올바르지 않습니다.");
  }
  const paddedFrom = shiftCalendarDate(requestedFrom, -7);
  const paddedTo = shiftCalendarDate(requestedTo, 2);
  const closedDates: string[] = [];
  const rounds: ClosedRoundRef[] = [];
  for (const value of payload.schedules.data) {
    if (!isRecord(value) || stringValue(value.gmId) !== "G101" || !/^\d+$/u.test(stringValue(value.gmTs))) {
      throw providerError("BETMAN_SCHEMA_CHANGED", "마감게임 목록 회차 식별자가 올바르지 않습니다.");
    }
    const closedDate = koreanDateFromEpoch(value.saleEndDate);
    if (!closedDate) throw providerError("BETMAN_SCHEMA_CHANGED", "마감게임 목록 마감 시각이 올바르지 않습니다.");
    closedDates.push(closedDate);
    if (closedDate >= paddedFrom && closedDate <= paddedTo) {
      const gmTs = stringValue(value.gmTs);
      rounds.push({ gmId: "G101", gmTs, sourceUrl: normalizedSlipUrl(gmTs), announcedAt: new Date(Number(value.saleEndDate)).toISOString() });
    }
  }
  return { rounds, nextPage: null, candidateCount: payload.schedules.data.length, oldestClosedDate: closedDates.sort()[0] ?? null };
}

function parseClosedRoundPage(html: string, requestedFrom: string, requestedTo: string): ParsedPage {
  assertClosedRoundPage(html);
  const rounds: ClosedRoundRef[] = [];
  const blocks = candidateBlocks(html);
  const closedDates: string[] = [];
  for (const block of blocks) {
    const identity = roundIdentity(block);
    if (!identity || identity.gmId !== "G101") continue;
    if (!/^\d+$/u.test(identity.gmTs)) throw providerError("BETMAN_SCHEMA_CHANGED", "마감 회차 식별자가 올바르지 않습니다.");
    const eventFrom = dateAttribute(block, "event-from");
    const eventTo = dateAttribute(block, "event-to");
    const closedDate = closeDateFromBlock(block) ?? eventTo ?? eventFrom;
    if (!closedDate) throw providerError("BETMAN_SCHEMA_CHANGED", "마감 회차 일자를 확인할 수 없습니다.");
    closedDates.push(closedDate);
    const announcedAt = instantAttribute(block, "announced-at") ?? `${closedDate}T00:00:00.000Z`;
    const paddedFrom = shiftCalendarDate(requestedFrom, -7);
    const paddedTo = shiftCalendarDate(requestedTo, 2);
    if (closedDate >= paddedFrom && closedDate <= paddedTo) {
      rounds.push({
        gmId: "G101",
        gmTs: identity.gmTs,
        sourceUrl: normalizedSlipUrl(identity.gmTs),
        announcedAt,
      });
    }
  }
  return {
    rounds,
    nextPage: nextPageUrl(html),
    candidateCount: blocks.length,
    oldestClosedDate: closedDates.sort()[0] ?? null,
  };
}

async function fetchClosedRound(
  fetchImpl: typeof fetch,
  round: ClosedRoundRef,
  session: AnonymousSession,
): Promise<ClosedRoundDocument> {
  assertRoundRef(round);
  const cookie = sessionCookie(session);
  const sourceUrl = normalizedSlipUrl(round.gmTs);
  const slipResult = await limitedFetch(fetchImpl, sourceUrl, {
    headers: { accept: HTML_ACCEPT, cookie },
  });
  assertHttpOk(slipResult.response, "마감 회차 화면");
  const slipUrl = new URL(slipResult.response.url);
  if (slipUrl.pathname !== SLIP_PATH) throw providerError("BETMAN_SCHEMA_CHANGED", "마감 회차 화면 경로가 바뀌었습니다.");
  const slipHtml = decodeHtml(slipResult.response, slipResult.bytes);
  assertSafeHtml(slipHtml);
  assertHtmlRound(slipHtml, round);

  const detailResult = await limitedFetch(fetchImpl, `${BETMAN_HISTORY_ORIGIN}${DETAIL_PATH}`, {
    method: "POST",
    headers: {
      accept: JSON_ACCEPT,
      "content-type": "application/json; charset=UTF-8",
      cookie,
      referer: sourceUrl,
      "x-requested-with": "XMLHttpRequest",
    },
    body: JSON.stringify({ gmId: "G101", gmTs: round.gmTs, gameYear: "", _sbmInfo: { _sbmInfo: { debugMode: "false" } } }),
  });
  assertHttpOk(detailResult.response, "마감 회차 상세");
  const payload = decodeJson(detailResult.response, detailResult.bytes);
  const detailState = validateDetailPayload(payload, round);
  return {
    round,
    fetchedAt: new Date().toISOString(),
    providerFinal: detailState === "FINAL",
    payload,
  };
}

async function limitedFetch(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<LimitedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BETMAN_TIMEOUT_MS);
  try {
    let currentUrl = assertBetmanUrl(requestUrl(input));
    let currentInit = { ...init };
    let redirects = 0;
    while (true) {
      const response = await fetchImpl(currentUrl, {
        ...currentInit,
        redirect: "manual",
        signal: controller.signal,
      });
      const responseUrl = response.url ? assertBetmanUrl(response.url) : currentUrl;
      if (!isRedirect(response.status)) {
        return { response, bytes: await readAtMost(response.body, BETMAN_MAX_BODY_BYTES) };
      }
      const location = response.headers.get("location");
      if (!location) throw providerError("BETMAN_UNAVAILABLE", "Betman 리디렉션 위치가 없습니다.");
      if (redirects >= BETMAN_MAX_REDIRECTS) {
        throw providerError("BETMAN_UNAVAILABLE", "Betman 리디렉션 횟수 제한을 초과했습니다.");
      }
      const nextUrl = assertBetmanUrl(new URL(location, responseUrl));
      await response.body?.cancel().catch(() => undefined);
      currentInit = redirectedRequestInit(currentInit, response.status);
      currentUrl = nextUrl;
      redirects += 1;
    }
  } catch (error) {
    if (error instanceof OddsHistoryValidationError) throw error;
    if (controller.signal.aborted) throw providerError("BETMAN_UNAVAILABLE", "Betman 응답 시간이 초과되었습니다.");
    throw providerError("BETMAN_UNAVAILABLE", "Betman에 연결할 수 없습니다.");
  } finally {
    clearTimeout(timer);
  }
}

function requestUrl(input: RequestInfo | URL): string | URL {
  return input instanceof Request ? input.url : input;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function redirectedRequestInit(init: RequestInit, status: number): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  if (status !== 303 && !((status === 301 || status === 302) && method === "POST")) return init;
  const headers = new Headers(init.headers);
  headers.delete("content-length");
  headers.delete("content-type");
  return { ...init, method: "GET", body: undefined, headers };
}

async function readAtMost(body: ReadableStream<Uint8Array> | null, maximumBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw providerError("BETMAN_SCHEMA_CHANGED", "Betman 응답 크기 제한을 초과했습니다.");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function assertBetmanUrl(value: string | URL): URL {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.port !== ""
      || url.username !== ""
      || url.password !== ""
      || !["betman.co.kr", "www.betman.co.kr"].includes(url.hostname.toLowerCase())
    ) throw new Error("origin");
    return url;
  } catch {
    throw providerError("BETMAN_UNAVAILABLE", "Betman 리디렉션 대상이 허용되지 않습니다.");
  }
}

function extractSessionCookie(headers: Headers): string {
  const cookieHeaders = headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = cookieHeaders.getSetCookie?.() ?? splitSetCookie(headers.get("set-cookie"));
  const cookies = setCookies.flatMap((value) => {
    const pair = value.split(";", 1)[0]?.trim() ?? "";
    return validCookiePair(pair) ? [pair] : [];
  });
  if (cookies.length === 0) throw providerError("BETMAN_SCHEMA_CHANGED", "익명 세션 쿠키를 받지 못했습니다.");
  return cookies.join("; ");
}

function providerError(code: ProviderCode, message: string): OddsHistoryValidationError {
  return new OddsHistoryValidationError(code, `${code}: ${message}`, null, code === "BETMAN_UNAVAILABLE");
}

function assertHttpOk(response: Response, resource: string): void {
  if (!response.ok) throw providerError("BETMAN_UNAVAILABLE", `${resource} HTTP ${response.status}`);
}

function decodeHtml(response: Response, bytes: Uint8Array): string {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    throw providerError("BETMAN_SCHEMA_CHANGED", "Betman HTML 응답 형식이 올바르지 않습니다.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw providerError("BETMAN_SCHEMA_CHANGED", "Betman HTML 문자 인코딩이 올바르지 않습니다.");
  }
}

function decodeJson(response: Response, bytes: Uint8Array): unknown {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("text/json")) {
    throw providerError("BETMAN_SCHEMA_CHANGED", "Betman JSON 응답 형식이 올바르지 않습니다.");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw providerError("BETMAN_SCHEMA_CHANGED", "Betman JSON 구조가 올바르지 않습니다.");
  }
}

function assertClosedRoundPage(html: string): void {
  assertSafeHtml(html);
  if (!/data-page-kind\s*=\s*["']closed-round-list["']/iu.test(html)
    && !/closedGameList\.do/iu.test(html)) {
    throw providerError("BETMAN_SCHEMA_CHANGED", "마감게임 목록 화면을 확인할 수 없습니다.");
  }
}

function assertSafeHtml(html: string): void {
  if (html.trim() === "") throw providerError("BETMAN_SCHEMA_CHANGED", "빈 Betman HTML 응답을 받았습니다.");
}

function candidateBlocks(html: string): string[] {
  const blocks: string[] = [];
  const pattern = /<(article|tr|li)\b[^>]*>[\s\S]*?<\/\1>/giu;
  for (const matched of html.matchAll(pattern)) {
    if (matched[0].includes(SLIP_PATH) || /name\s*=\s*["']gmId["']/iu.test(matched[0])) blocks.push(matched[0]);
  }
  if (blocks.length > 0) return blocks;
  const forms = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/giu) ?? [];
  return forms.filter((block) => block.includes(SLIP_PATH) || /name\s*=\s*["']gmId["']/iu.test(block));
}

function roundIdentity(block: string): { gmId: string; gmTs: string } | null {
  const encodedLink = attrFromMatchingTag(block, "a", "href", SLIP_PATH);
  if (encodedLink) {
    try {
      const url = new URL(decodeEntities(encodedLink), BETMAN_HISTORY_ORIGIN);
      if (url.pathname !== SLIP_PATH) return null;
      if (url.origin !== BETMAN_HISTORY_ORIGIN || url.username || url.password || url.hash) {
        throw providerError("BETMAN_SCHEMA_CHANGED", "마감 회차 링크가 고정 오리진을 벗어났습니다.");
      }
      return { gmId: url.searchParams.get("gmId") ?? "", gmTs: url.searchParams.get("gmTs") ?? "" };
    } catch {
      throw providerError("BETMAN_SCHEMA_CHANGED", "마감 회차 링크가 올바르지 않습니다.");
    }
  }
  const action = attrFromMatchingTag(block, "form", "action", SLIP_PATH);
  if (!action) return null;
  try {
    const actionUrl = new URL(decodeEntities(action), BETMAN_HISTORY_ORIGIN);
    if (actionUrl.pathname !== SLIP_PATH) return null;
    if (actionUrl.origin !== BETMAN_HISTORY_ORIGIN || actionUrl.username || actionUrl.password || actionUrl.hash) throw new Error("origin");
  } catch {
    throw providerError("BETMAN_SCHEMA_CHANGED", "마감 회차 폼이 올바르지 않습니다.");
  }
  return { gmId: inputValue(block, "gmId") ?? "", gmTs: inputValue(block, "gmTs") ?? "" };
}

function dateAttribute(block: string, role: "event-from" | "event-to"): string | null {
  const value = roleAttribute(block, role) ?? dataAttribute(block, role);
  if (value === null) return null;
  const normalized = value.replace(/\./gu, "-");
  return isCalendarDate(normalized) ? normalized : null;
}

function instantAttribute(block: string, role: "announced-at"): string | null {
  const value = roleAttribute(block, role) ?? dataAttribute(block, role);
  if (value === null) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw providerError("BETMAN_SCHEMA_CHANGED", "회차 발표 시각이 올바르지 않습니다.");
  }
  return value;
}

function nextPageUrl(html: string): URL | null {
  const anchors = html.match(/<a\b[^>]*>/giu) ?? [];
  const next = anchors.find((tag) => {
    const rel = attribute(tag, "rel")?.toLowerCase().split(/\s+/u) ?? [];
    return rel.includes("next");
  });
  if (!next) return null;
  const href = attribute(next, "href");
  if (!href) throw providerError("BETMAN_SCHEMA_CHANGED", "다음 목록 링크가 올바르지 않습니다.");
  try {
    const url = new URL(decodeEntities(href), BETMAN_HISTORY_ORIGIN);
    if (url.origin !== BETMAN_HISTORY_ORIGIN || url.pathname !== ENTRY_PATH || url.username || url.password || url.hash) throw new Error("page");
    return url;
  } catch {
    throw providerError("BETMAN_SCHEMA_CHANGED", "다음 목록 링크가 고정 오리진을 벗어났습니다.");
  }
}

function assertHtmlRound(html: string, round: ClosedRoundRef): void {
  const gmId = inputValue(html, "gmId") ?? dataAttribute(html, "gm-id");
  const gmTs = inputValue(html, "gmTs") ?? dataAttribute(html, "gm-ts");
  if ((gmId !== null || gmTs !== null) && (gmId !== round.gmId || gmTs !== round.gmTs)) {
    throw providerError("BETMAN_SCHEMA_CHANGED", "마감 회차 화면 식별자가 요청과 다릅니다.");
  }
}

function explicitRoundState(value: string): "FINAL" | "PENDING" | null {
  const raw = dataAttribute(value, "round-status") ?? jsonScalar(value, "roundStatus");
  if (!raw) return null;
  const normalized = raw.normalize("NFC").trim().toUpperCase();
  if (FINAL_STATES.has(normalized)) return "FINAL";
  if (PENDING_STATES.has(normalized)) return "PENDING";
  return null;
}

function validateDetailPayload(payload: unknown, round: ClosedRoundRef): "FINAL" | "PENDING" {
  if (!isRecord(payload) || (payload.gmId !== undefined && stringValue(payload.gmId) !== round.gmId) || stringValue(payload.gmTs) !== round.gmTs) {
    throw providerError("BETMAN_SCHEMA_CHANGED", "마감 회차 상세 식별자가 요청과 다릅니다.");
  }
  const schedules = payload.compSchedules;
  if (!isRecord(schedules) || !Array.isArray(schedules.keys) || !Array.isArray(schedules.datas)) {
    throw providerError("BETMAN_SCHEMA_CHANGED", "마감 회차 상세 배열 구조가 올바르지 않습니다.");
  }
  if (schedules.datas.length === 0 && payload.zeroGames !== true) {
    throw providerError("BETMAN_SCHEMA_CHANGED", "빈 회차에 명시적 0경기 표시가 없습니다.");
  }
  if (schedules.datas.length > 0 && schedules.keys.length === 0) {
    throw providerError("BETMAN_SCHEMA_CHANGED", "마감 회차 상세 열 구조가 없습니다.");
  }
  if (payload.roundStatus !== undefined) {
    const state = explicitRoundState(JSON.stringify({ roundStatus: payload.roundStatus }));
    if (!state) throw providerError("BETMAN_SCHEMA_CHANGED", "마감 회차 확정 상태가 명시되지 않았습니다.");
    return state;
  }
  const protoStatusIndex = schedules.keys.indexOf("protoStatus");
  if (protoStatusIndex < 0) throw providerError("BETMAN_SCHEMA_CHANGED", "마감 회차 상태 열이 없습니다.");
  return schedules.datas.every((row) => Array.isArray(row) && stringValue(row[protoStatusIndex]) === "4") ? "FINAL" : "PENDING";
}

function assertRoundRef(round: ClosedRoundRef): void {
  if (round.gmId !== "G101" || !/^\d+$/u.test(round.gmTs) || round.sourceUrl !== normalizedSlipUrl(round.gmTs)) {
    throw providerError("BETMAN_SCHEMA_CHANGED", "요청 회차가 고정 G101 계약과 다릅니다.");
  }
  if (round.announcedAt !== null) {
    const announced = new Date(round.announcedAt);
    if (!Number.isFinite(announced.getTime()) || announced.toISOString() !== round.announcedAt) {
      throw providerError("BETMAN_SCHEMA_CHANGED", "요청 회차 발표 시각이 올바르지 않습니다.");
    }
  }
}

function assertDateRange(from: string, to: string): void {
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) {
    throw providerError("BETMAN_SCHEMA_CHANGED", "목록 경기일 범위가 올바르지 않습니다.");
  }
}

function sessionCookie(session: AnonymousSession): string {
  if (!session || typeof session.cookie !== "string") throw providerError("BETMAN_SCHEMA_CHANGED", "익명 세션이 올바르지 않습니다.");
  const pairs = session.cookie.split(/;\s*/u);
  if (pairs.length === 0 || pairs.some((pair) => !validCookiePair(pair))) {
    throw providerError("BETMAN_SCHEMA_CHANGED", "익명 세션이 올바르지 않습니다.");
  }
  return pairs.join("; ");
}

function validCookiePair(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[\u0021-\u003A\u003C-\u007E]*$/u.test(value) && !/[\r\n]/u.test(value);
}

function splitSetCookie(value: string | null): string[] {
  return value ? value.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/u) : [];
}

function normalizedSlipUrl(gmTs: string): string {
  const url = new URL(SLIP_PATH, BETMAN_HISTORY_ORIGIN);
  url.searchParams.set("gmId", "G101");
  url.searchParams.set("gmTs", gmTs);
  return url.toString();
}

function closedListUrl(page: number): URL {
  const url = new URL(ENTRY_PATH, BETMAN_HISTORY_ORIGIN);
  url.searchParams.set("sbx_gmCase", "PPT");
  url.searchParams.set("sbx_gmType", "G101");
  url.searchParams.set("curPage", String(page));
  url.searchParams.set("perPage", "10");
  return url;
}

function closeDateFromBlock(block: string): string | null {
  const plain = decodeEntities(block.replace(/<[^>]+>/gu, " "));
  const dates = [...plain.matchAll(/(20\d{2})[.\/-](\d{2})[.\/-](\d{2})/gu)]
    .map((match) => `${match[1]}-${match[2]}-${match[3]}`)
    .filter(isCalendarDate)
    .sort();
  return dates.at(-1) ?? null;
}

function shiftCalendarDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

function koreanDateFromEpoch(value: unknown): string | null {
  const epoch = typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(epoch) || epoch <= 0) return null;
  const korean = new Date(epoch + 9 * 60 * 60 * 1000);
  return `${korean.getUTCFullYear()}-${String(korean.getUTCMonth() + 1).padStart(2, "0")}-${String(korean.getUTCDate()).padStart(2, "0")}`;
}

function compareNumericStrings(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : left.localeCompare(right, "en");
}

function attrFromMatchingTag(block: string, tagName: string, attrName: string, contains: string): string | null {
  const tags = block.match(new RegExp(`<${tagName}\\b[^>]*>`, "giu")) ?? [];
  for (const tag of tags) {
    const value = attribute(tag, attrName);
    if (value && decodeEntities(value).includes(contains)) return value;
  }
  return null;
}

function inputValue(block: string, name: string): string | null {
  const inputs = block.match(/<input\b[^>]*>/giu) ?? [];
  for (const input of inputs) {
    if (attribute(input, "name") === name) return decodeEntities(attribute(input, "value") ?? "");
  }
  return null;
}

function roleAttribute(block: string, role: string): string | null {
  const tags = block.match(/<[^>]+>/gu) ?? [];
  for (const tag of tags) {
    if (attribute(tag, "data-role") === role) return decodeEntities(attribute(tag, "datetime") ?? attribute(tag, "content") ?? "") || null;
  }
  return null;
}

function dataAttribute(block: string, name: string): string | null {
  const tags = block.match(/<[^>]+>/gu) ?? [];
  for (const tag of tags) {
    const value = attribute(tag, `data-${name}`);
    if (value !== null) return decodeEntities(value);
  }
  return null;
}

function attribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matched = new RegExp(`\\b${escaped}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, "iu").exec(tag);
  return matched ? (matched[1] ?? matched[2] ?? matched[3] ?? "") : null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function jsonScalar(value: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matched = new RegExp(`\"${escaped}\"\\s*:\\s*\"([^\"]+)\"`, "u").exec(value);
  return matched?.[1] ?? null;
}

function isCalendarDate(value: string): boolean {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay;
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).normalize("NFC").trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
