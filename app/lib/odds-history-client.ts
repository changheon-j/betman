import { historyQueryString } from "./odds-history-contract.ts";
import type {
  HistoryLeagueFilter,
  HistoryTeamOption,
  OddsHistoryError,
  OddsHistoryErrorCode,
  OddsHistoryPayload,
  OddsHistoryQuery,
  SyncPayload,
} from "./betman-history-types.ts";

const FALLBACK_MESSAGE = "요청을 처리하지 못했습니다.";

export class OddsHistoryClientError extends Error {
  constructor(
    readonly code: OddsHistoryErrorCode,
    message: string,
    readonly field: string | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = code;
  }
}

export type HistoryRefreshOptions = {
  query: OddsHistoryQuery;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onStored: (payload: OddsHistoryPayload) => void;
  onSync: (payload: SyncPayload) => void;
  onFinal: (payload: OddsHistoryPayload) => void;
  /** Receives a POST failure after the final stored-data GET has been attempted. */
  onSyncError?: (error: OddsHistoryClientError) => void;
};

export type HistoryPageOptions = {
  query: OddsHistoryQuery;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onPage: (payload: OddsHistoryPayload) => void;
};

export async function runOddsHistoryRefresh(options: HistoryRefreshOptions): Promise<void> {
  const stored = await getHistory(options.query, options.fetchImpl, options.signal);
  ensureNotAborted(options.signal);
  if (!options.isCurrent()) return;
  options.onStored(stored);

  let cursor: string | null = null;
  let syncFailure: OddsHistoryClientError | null = null;
  let cumulativeSync: SyncPayload | null = null;
  do {
    ensureNotAborted(options.signal);
    if (!options.isCurrent()) return;
    let sync: SyncPayload;
    try {
      sync = await postSync({ from: options.query.from, to: options.query.to, cursor }, options.fetchImpl, options.signal);
      if (sync.hasMore && (typeof sync.nextCursor !== "string" || sync.nextCursor.length === 0)) {
        throw clientError("INTERNAL_ERROR", "동기화 응답이 올바르지 않습니다.", null, true);
      }
    } catch (error) {
      ensureNotAborted(options.signal, error);
      if (!options.isCurrent()) return;
      syncFailure = asClientError(error);
      break;
    }

    ensureNotAborted(options.signal);
    if (!options.isCurrent()) return;
    cumulativeSync = cumulativeSync ? mergeSyncPayload(cumulativeSync, sync) : sync;
    options.onSync(cumulativeSync);
    cursor = sync.hasMore ? sync.nextCursor : null;
  } while (cursor !== null);

  if (syncFailure) {
    await publishFinalAfterSyncFailure(options, syncFailure);
    return;
  }

  const finalPayload = await getHistory(options.query, options.fetchImpl, options.signal);
  ensureNotAborted(options.signal);
  if (options.isCurrent()) options.onFinal(finalPayload);
}

export function mergeSyncPayload(previous: SyncPayload, current: SyncPayload): SyncPayload {
  return {
    ...current,
    status: previous.status === "partial" || current.status === "partial" ? "partial" : "completed",
    remainingUnresolvedRounds: Math.max(
      previous.remainingUnresolvedRounds,
      current.remainingUnresolvedRounds,
    ),
    deferredPendingRounds: Math.max(
      previous.deferredPendingRounds,
      current.deferredPendingRounds,
    ),
    nextPendingRetryAt: earliestRetry(previous.nextPendingRetryAt, current.nextPendingRetryAt),
  };
}

export async function fetchOddsHistoryPage(options: HistoryPageOptions): Promise<void> {
  const payload = await getHistory(options.query, options.fetchImpl, options.signal);
  ensureNotAborted(options.signal);
  if (options.isCurrent()) options.onPage(payload);
}

export async function getHistory(query: OddsHistoryQuery, fetchImpl: typeof fetch, signal: AbortSignal): Promise<OddsHistoryPayload> {
  ensureNotAborted(signal);
  const response = await fetchImpl(`/api/odds-history?${historyQueryString(query)}`, { signal });
  ensureNotAborted(signal);
  return parseResponse<OddsHistoryPayload>(response, signal);
}

export async function postSync(
  input: { from: string; to: string; cursor: string | null },
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<SyncPayload> {
  ensureNotAborted(signal);
  const response = await fetchImpl("/api/odds-history/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  ensureNotAborted(signal);
  return parseResponse<SyncPayload>(response, signal);
}

export function reconcileHistoryTeam(
  selectedTeam: string | null,
  league: HistoryLeagueFilter,
  teams: readonly HistoryTeamOption[],
): string | null {
  if (!selectedTeam) return null;
  const team = teams.find((candidate) => candidate.key === selectedTeam);
  return team && (league === "all" || team.leagueCode === league) ? team.key : null;
}

export function pageWindow(page: number, totalPages: number): Array<number | "ellipsis"> {
  if (totalPages <= 1) return [1];
  const current = Math.min(Math.max(1, page), totalPages);
  const pages = new Set<number>([1, totalPages]);
  for (let value = current - 2; value <= current + 2; value += 1) {
    if (value > 1 && value < totalPages) pages.add(value);
  }
  const ordered = [...pages].sort((left, right) => left - right);
  return ordered.flatMap((value, index) => index > 0 && value - ordered[index - 1] > 1 ? ["ellipsis" as const, value] : [value]);
}

async function publishFinalAfterSyncFailure(options: HistoryRefreshOptions, syncFailure: OddsHistoryClientError): Promise<void> {
  let finalPayload: OddsHistoryPayload | null = null;
  try {
    finalPayload = await getHistory(options.query, options.fetchImpl, options.signal);
  } catch (error) {
    ensureNotAborted(options.signal, error);
    if (!options.isCurrent()) return;
  }

  if (finalPayload) {
    ensureNotAborted(options.signal);
    if (!options.isCurrent()) return;
    options.onFinal(finalPayload);
  }

  ensureNotAborted(options.signal);
  if (!options.isCurrent()) return;
  if (options.onSyncError) {
    options.onSyncError(syncFailure);
    return;
  }
  throw syncFailure;
}

async function parseResponse<T>(response: Response, signal: AbortSignal): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    ensureNotAborted(signal);
  }
  throw errorFromEnvelope(body);
}

function errorFromEnvelope(body: unknown): OddsHistoryClientError {
  if (isOddsHistoryError(body)) {
    const { code, message, field, retryable } = body.error;
    return clientError(code, message, field, retryable);
  }
  return clientError("INTERNAL_ERROR", FALLBACK_MESSAGE, null, false);
}

function isOddsHistoryError(value: unknown): value is OddsHistoryError {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const error = (value as { error?: unknown }).error;
  return !!error && typeof error === "object" && !Array.isArray(error)
    && typeof (error as { code?: unknown }).code === "string"
    && typeof (error as { message?: unknown }).message === "string"
    && ((error as { field?: unknown }).field === null || typeof (error as { field?: unknown }).field === "string")
    && typeof (error as { retryable?: unknown }).retryable === "boolean";
}

function asClientError(error: unknown): OddsHistoryClientError {
  if (error instanceof OddsHistoryClientError) return error;
  return clientError("INTERNAL_ERROR", FALLBACK_MESSAGE, null, true);
}

function clientError(code: OddsHistoryErrorCode | string, message: string, field: string | null, retryable: boolean): OddsHistoryClientError {
  return new OddsHistoryClientError(isErrorCode(code) ? code : "INTERNAL_ERROR", message, field, retryable);
}

function isErrorCode(value: string): value is OddsHistoryErrorCode {
  return [
    "INVALID_DATE", "INVALID_DATE_RANGE", "INVALID_LEAGUE", "INVALID_TEAM", "INVALID_PAGE", "INVALID_CURSOR", "ROUND_BUSY",
    "BETMAN_UNAVAILABLE", "BETMAN_SCHEMA_CHANGED", "FINAL_CONFLICT", "DATABASE_UNAVAILABLE", "INTERNAL_ERROR",
  ].includes(value);
}

function ensureNotAborted(signal: AbortSignal, error?: unknown): void {
  if (!signal.aborted && !isAbortError(error)) return;
  if (isAbortError(error)) throw error;
  if (signal.reason instanceof DOMException && signal.reason.name === "AbortError") throw signal.reason;
  throw new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(error: unknown): error is Error {
  return !!error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError";
}

function earliestRetry(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}
