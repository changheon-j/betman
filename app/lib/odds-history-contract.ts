import type { HistoryLeagueFilter, OddsHistoryErrorCode, OddsHistoryQuery, SyncCursorData, SyncInput } from "./betman-history-types.ts";
import { TEAMS_BY_LEAGUE } from "./team-aliases.ts";
import type { LeagueCode } from "./leagues.ts";

export type { HistoryLeagueFilter, OddsHistoryErrorCode, OddsHistoryQuery, SyncCursorData, SyncInput } from "./betman-history-types.ts";

export const HISTORY_PAGE_SIZE = 30 as const;
export const CURSOR_TTL_MS = 30 * 60 * 1000;
export const MAX_CURSOR_BYTES = 8 * 1024;

export class OddsHistoryValidationError extends Error {
  constructor(readonly code: OddsHistoryErrorCode, message: string, readonly field: string | null = null, readonly retryable = false) {
    super(message);
    this.name = code;
  }
}

export function oddsHistoryErrorResponse(error: unknown, status: number) {
  const known = error instanceof OddsHistoryValidationError
    ? error
    : new OddsHistoryValidationError("INTERNAL_ERROR", "요청을 처리하지 못했습니다.");
  return Response.json({ error: { code: known.code, message: known.message, field: known.field, retryable: known.retryable } }, { status });
}

export function defaultHistoryRange(now = new Date()) {
  const to = koreanDate(now);
  return { from: shiftCalendarMonths(to, -3), to };
}

export function parseOddsHistoryQuery(url: URL, now = new Date()): OddsHistoryQuery {
  const range = parseRange(url.searchParams.get("from"), url.searchParams.get("to"), now);
  const league = parseLeague(url.searchParams.get("league") ?? "all");
  const team = parseTeamKey(url.searchParams.get("team"), league);
  const page = parsePositiveSafeInteger(url.searchParams.get("page") ?? "1", "page", "INVALID_PAGE");
  return { league, team, ...range, page, pageSize: HISTORY_PAGE_SIZE };
}

export function parseSyncBody(value: unknown, now = new Date()): SyncInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validation("INVALID_DATE", "요청 본문이 올바르지 않습니다.");
  }
  const body = value as Record<string, unknown>;
  const range = parseRange(optionalString(body.from), optionalString(body.to), now);
  const cursor = body.cursor === undefined || body.cursor === null ? null : requireString(body.cursor, "INVALID_CURSOR", "cursor");
  return { ...range, cursor };
}

export function encodeSyncCursor(data: SyncCursorData): string {
  const encoded = base64UrlEncode(JSON.stringify(data));
  if (byteLength(encoded) > MAX_CURSOR_BYTES) throw validation("INVALID_CURSOR", "동기화 cursor가 너무 큽니다.");
  return encoded;
}

export function decodeSyncCursor(
  value: unknown,
  expectedRange: { from: string; to: string },
  discoveredRoundKeys: readonly string[],
  now = new Date(),
): SyncCursorData {
  try {
    if (typeof value !== "string" || byteLength(value) > MAX_CURSOR_BYTES) throw new Error("cursor");
    const parsed = JSON.parse(base64UrlDecode(value)) as unknown;
    if (!isSyncCursorData(parsed)) throw new Error("shape");
    if (parsed.from !== expectedRange.from || parsed.to !== expectedRange.to) throw new Error("range");

    const issuedAt = new Date(parsed.issuedAt);
    const age = now.getTime() - issuedAt.getTime();
    if (!Number.isFinite(issuedAt.getTime()) || issuedAt.toISOString() !== parsed.issuedAt || age < 0 || age > CURSOR_TTL_MS) throw new Error("expiry");
    if (!isOrderedDiscoveredSubset(parsed.roundKeys, discoveredRoundKeys)) throw new Error("rounds");

    return parsed;
  } catch {
    throw validation("INVALID_CURSOR", "동기화 cursor가 올바르지 않습니다.", "cursor");
  }
}

export function historyQueryString(query: OddsHistoryQuery): string {
  const params = new URLSearchParams({ league: query.league, from: query.from, to: query.to, page: String(query.page) });
  if (query.team) params.set("team", query.team);
  return params.toString();
}

function koreanDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: "year" | "month" | "day") => parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day) throw new Error("Unable to determine Korean date.");
  return `${year}-${month}-${day}`;
}

function shiftCalendarMonths(date: string, months: number): string {
  const { year, month, day } = parseDateParts(date);
  const targetMonthIndex = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = (targetMonthIndex % 12) + 1;
  return formatDate(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

function shiftCalendarYears(date: string, years: number): string {
  const { year, month, day } = parseDateParts(date);
  const targetYear = year + years;
  return formatDate(targetYear, month, Math.min(day, daysInMonth(targetYear, month)));
}

function parseRange(from: string | null, to: string | null, now: Date) {
  if (from === null && to === null) return defaultHistoryRange(now);
  if (from === null || to === null) throw validation("INVALID_DATE", "시작일과 종료일을 모두 입력하세요.", from === null ? "from" : "to");
  ensureDate(from, "from");
  ensureDate(to, "to");
  if (from > to) throw validation("INVALID_DATE_RANGE", "시작일은 종료일보다 늦을 수 없습니다.", "to");
  if (to > shiftCalendarYears(from, 1)) throw validation("INVALID_DATE_RANGE", "조회 기간은 최대 1년입니다.", "to");
  return { from, to };
}

function parseLeague(value: string): HistoryLeagueFilter {
  if (value === "all" || value === "K1" || value === "J1") return value;
  throw validation("INVALID_LEAGUE", "리그 필터가 올바르지 않습니다.", "league");
}

function parseTeamKey(value: string | null, league: HistoryLeagueFilter): string | null {
  if (value === null || value === "") return null;
  const matched = /^(K1|J1):([1-9]\d*)$/u.exec(value);
  if (!matched) throw validation("INVALID_TEAM", "팀 필터가 올바르지 않습니다.", "team");
  const rawLeague = matched[1];
  const rawId = matched[2];
  const teamLeague = rawLeague as LeagueCode;
  if ((league !== "all" && league !== teamLeague) || !TEAMS_BY_LEAGUE[teamLeague].some((team) => team.id === Number(rawId))) {
    throw validation("INVALID_TEAM", "팀 필터가 올바르지 않습니다.", "team");
  }
  return value;
}

function parsePositiveSafeInteger(value: string, field: string, code: OddsHistoryErrorCode): number {
  if (!/^[1-9]\d*$/u.test(value)) throw validation(code, "페이지 번호가 올바르지 않습니다.", field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw validation(code, "페이지 번호가 올바르지 않습니다.", field);
  return parsed;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, "INVALID_DATE");
}

function requireString(value: unknown, code: OddsHistoryErrorCode, field: string | null = null): string {
  if (typeof value !== "string") throw validation(code, "요청 값이 올바르지 않습니다.", field);
  return value;
}

function ensureDate(value: string, field: string) {
  try {
    const parsed = parseDateParts(value);
    if (formatDate(parsed.year, parsed.month, parsed.day) !== value) throw new Error("date");
  } catch {
    throw validation("INVALID_DATE", "날짜가 올바르지 않습니다.", field);
  }
}

function parseDateParts(value: string) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!matched) throw new Error("date");
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw new Error("date");
  return { year, month, day };
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) throw new Error("base64");
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isSyncCursorData(value: unknown): value is SyncCursorData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const nextIndex = data.nextIndex;
  const keys = Object.keys(data).sort();
  if (keys.join(",") !== "from,issuedAt,nextIndex,roundKeys,to,version"
    && keys.join(",") !== "from,issuedAt,nextIndex,progress,roundKeys,to,version") return false;
  return data.version === 1
    && typeof data.from === "string"
    && typeof data.to === "string"
    && Array.isArray(data.roundKeys)
    && data.roundKeys.every((key) => typeof key === "string")
    && typeof nextIndex === "number"
    && Number.isSafeInteger(nextIndex)
    && nextIndex >= 0
    && nextIndex <= data.roundKeys.length
    && typeof data.issuedAt === "string"
    && (data.progress === undefined || isSyncProgress(data.progress, data.roundKeys.length));
}

function isSyncProgress(value: unknown, roundCount: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const progress = value as Record<string, unknown>;
  if (Object.keys(progress).sort().join(",") !== "deferredPendingRounds,hadPartial,nextPendingRetryAt,remainingUnresolvedRounds") return false;
  const remaining = progress.remainingUnresolvedRounds;
  const deferred = progress.deferredPendingRounds;
  return typeof remaining === "number"
    && Number.isSafeInteger(remaining)
    && remaining >= 0
    && remaining <= roundCount
    && typeof deferred === "number"
    && Number.isSafeInteger(deferred)
    && deferred >= 0
    && deferred <= remaining
    && typeof progress.hadPartial === "boolean"
    && (progress.nextPendingRetryAt === null || isCanonicalInstant(progress.nextPendingRetryAt));
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isOrderedDiscoveredSubset(roundKeys: readonly string[], discoveredRoundKeys: readonly string[]): boolean {
  let discoveredIndex = 0;
  for (const key of roundKeys) {
    if (!/^G101:\d+$/u.test(key)) return false;
    while (discoveredIndex < discoveredRoundKeys.length && discoveredRoundKeys[discoveredIndex] !== key) discoveredIndex += 1;
    if (discoveredIndex === discoveredRoundKeys.length) return false;
    discoveredIndex += 1;
  }
  return true;
}

function validation(code: OddsHistoryErrorCode, message: string, field: string | null = null): OddsHistoryValidationError {
  return new OddsHistoryValidationError(code, message, field);
}
