import {
  mapWithConcurrency,
  type AnonymousSession,
  type BetmanClosedAdapter,
} from "./betman-history-adapter.ts";
import { BetmanHistorySchemaError, parseClosedRoundDocument } from "./betman-history-parser.ts";
import type {
  ClaimedClosedRound,
  ClosedRoundRef,
  OddsHistoryErrorCode,
  SyncCursorData,
  SyncInput,
  SyncPayload,
  SyncProgress,
  SyncRoundError,
  SyncRoundResult,
} from "./betman-history-types.ts";
import {
  decodeSyncCursor,
  encodeSyncCursor,
  OddsHistoryValidationError,
  oddsHistoryErrorResponse,
  parseSyncBody,
} from "./odds-history-contract.ts";
import type { OddsHistoryStore } from "./odds-history-store.ts";

export const MAX_ROUNDS_PER_SYNC = 5 as const;
export const MAX_PARALLEL_DETAILS = 2 as const;
export const MAX_CURSOR_INSPECTIONS_PER_SYNC = 25 as const;

export type OddsHistoryOperationalEvent =
  | {
      event: "odds_history.sync";
      correlationId: string;
      status: SyncPayload["status"] | "error";
      httpStatus: number;
      errorCode: string | null;
      discoveredRounds: number;
      attemptedRounds: number;
      succeededRounds: number;
      partialRounds: number;
      busyRounds: number;
      durationMs: number;
    }
  | {
      event: "odds_history.round";
      correlationId: string;
      roundKey: string;
      status: SyncRoundResult["status"];
      errorCode: string | null;
      durationMs: number;
      providerLatencyMs: number;
    };

export type SyncDependencies = {
  adapter: BetmanClosedAdapter;
  store: OddsHistoryStore;
  createSession: () => Promise<AnonymousSession>;
  parseRound: typeof parseClosedRoundDocument;
  now: () => Date;
  correlationId?: string;
  logger?: (event: OddsHistoryOperationalEvent) => void;
  monotonicNow?: () => number;
};

export type SyncRouteDependencies = {
  run: (input: SyncInput) => Promise<SyncPayload>;
  now: () => Date;
};

type ClassifiedError = {
  code: OddsHistoryErrorCode;
  message: string;
  retryable: boolean;
};

type ClaimResult = Awaited<ReturnType<OddsHistoryStore["claimCandidates"]>>;
type TelemetryContext = {
  correlationId: string;
  logger: SyncDependencies["logger"];
  clock: () => number;
};

const PUBLIC_ERRORS: Record<
  "ROUND_BUSY" | "BETMAN_UNAVAILABLE" | "BETMAN_SCHEMA_CHANGED" | "FINAL_CONFLICT" | "DATABASE_UNAVAILABLE" | "INTERNAL_ERROR",
  Omit<ClassifiedError, "code">
> = {
  ROUND_BUSY: { message: "다른 동기화 요청이 회차를 처리 중입니다.", retryable: true },
  BETMAN_UNAVAILABLE: { message: "Betman에 연결할 수 없습니다.", retryable: true },
  BETMAN_SCHEMA_CHANGED: { message: "Betman 응답 형식을 확인할 수 없습니다.", retryable: false },
  FINAL_CONFLICT: { message: "확정된 배당 기록과 다른 값은 저장하지 않았습니다.", retryable: false },
  DATABASE_UNAVAILABLE: { message: "D1 저장소를 사용할 수 없습니다.", retryable: true },
  INTERNAL_ERROR: { message: "요청을 처리하지 못했습니다.", retryable: false },
};

export async function runOddsHistorySync(input: SyncInput, deps: SyncDependencies): Promise<SyncPayload> {
  const startedAt = canonicalNow(deps.now());
  const telemetry = telemetryContext(deps);
  const requestStarted = telemetry.clock();
  let discoveredRounds = 0;
  const attemptedResults: SyncRoundResult[] = [];
  let busyRounds: ClosedRoundRef[] = [];
  try {
    const session = await deps.createSession();
    const discovered = newestFirst(await deps.adapter.discoverRounds(input.from, input.to, session));
    const discoveredKeys = discovered.map(roundKey);
    discoveredRounds = discovered.length;
    const cursor = input.cursor
      ? decodeSyncCursor(input.cursor, input, discoveredKeys, deps.now())
      : initialCursor(input, discoveredKeys, startedAt);

    if (!input.cursor) await deps.store.registerRounds(discovered, startedAt);
    const inspectionEnd = Math.min(
      cursor.roundKeys.length,
      cursor.nextIndex + MAX_CURSOR_INSPECTIONS_PER_SYNC,
    );
    await deps.store.rematchFinalTeamFailures(
      cursor.roundKeys.slice(cursor.nextIndex, inspectionEnd),
      startedAt,
    );
    const claim: ClaimResult = {
      claimed: [],
      busy: [],
      skippedFinal: 0,
      deferredPending: 0,
      nextPendingRetryAt: null,
      nextIndex: 0,
    };
    let nextIndex = cursor.nextIndex;
    while (nextIndex < inspectionEnd && attemptedResults.length < MAX_ROUNDS_PER_SYNC) {
      const remainingKeys = cursor.roundKeys.slice(nextIndex, inspectionEnd);
      const claimTimestamp = canonicalNow(deps.now());
      const attemptBudget = MAX_ROUNDS_PER_SYNC - attemptedResults.length;
      const waveLimit = Math.min(MAX_PARALLEL_DETAILS, attemptBudget);
      const wave = await deps.store.claimCandidates(remainingKeys, claimTimestamp, waveLimit);
      assertClaimResult(wave, remainingKeys.length, waveLimit);
      claim.claimed.push(...wave.claimed);
      claim.busy.push(...wave.busy);
      claim.skippedFinal += wave.skippedFinal;
      claim.deferredPending += wave.deferredPending;
      claim.nextPendingRetryAt = earliestInstant(claim.nextPendingRetryAt, wave.nextPendingRetryAt);
      claim.nextIndex += wave.nextIndex;
      nextIndex += wave.nextIndex;
      const waveResults = await mapWithConcurrency(
        wave.claimed,
        MAX_PARALLEL_DETAILS,
        (round) => syncOneRound(round, session, deps, telemetry),
      );
      attemptedResults.push(...waveResults);
    }
    busyRounds = claim.busy;
    if (attemptedResults.length === 0 && busyRounds.length > 0
      && claim.skippedFinal === 0 && claim.deferredPending === 0) throw requestError("ROUND_BUSY");
    const hasSafeRound = attemptedResults.some((round) => round.status !== "ERROR")
      || claim.skippedFinal > 0
      || claim.deferredPending > 0;
    if (attemptedResults.length > 0 && !hasSafeRound) throw aggregateRoundFailure(attemptedResults);

    const payload = buildSyncPayload(
      attemptedResults,
      busyRounds,
      claim,
      cursor,
      nextIndex,
      startedAt,
      canonicalNow(deps.now()),
    );
    emitSyncTelemetry(telemetry, payload.status, null, discoveredRounds, attemptedResults, busyRounds.length, requestStarted);
    return payload;
  } catch (error) {
    emitSyncTelemetry(
      telemetry,
      "error",
      telemetryErrorCode(error),
      discoveredRounds,
      attemptedResults,
      busyRounds.length,
      requestStarted,
    );
    throw error;
  }
}

export async function handleOddsHistorySync(request: Request, deps: SyncRouteDependencies): Promise<Response> {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new OddsHistoryValidationError("INVALID_DATE", "요청 본문이 올바르지 않습니다.");
    }
    const input = parseSyncBody(body, deps.now());
    return Response.json(await deps.run(input));
  } catch (error) {
    return syncErrorResponse(error);
  }
}

export function syncErrorResponse(error: unknown): Response {
  if (error instanceof OddsHistoryValidationError) {
    const status = errorStatus(error.code);
    if (status >= 409) return oddsHistoryErrorResponse(normalizedOperationalError(error.code), status);
    return oddsHistoryErrorResponse(error, status);
  }
  return oddsHistoryErrorResponse(requestError("INTERNAL_ERROR"), 500);
}

function initialCursor(input: SyncInput, roundKeys: string[], issuedAt: string): SyncCursorData {
  return {
    version: 1,
    from: input.from,
    to: input.to,
    roundKeys,
    nextIndex: 0,
    issuedAt,
    progress: emptyProgress(),
  };
}

async function syncOneRound(
  round: ClaimedClosedRound,
  session: AnonymousSession,
  deps: SyncDependencies,
  telemetry: TelemetryContext,
): Promise<SyncRoundResult> {
  const roundStarted = telemetry.clock();
  const providerStarted = telemetry.clock();
  let providerLatencyMs = 0;
  let outcome: SyncRoundResult | null = null;
  let stage: "fetch" | "parse" | "persist" = "fetch";
  try {
    const document = await deps.adapter.fetchRound(round, session);
    providerLatencyMs = elapsedMs(providerStarted, telemetry.clock());
    stage = "parse";
    const parsed = deps.parseRound(document);
    stage = "persist";
    const persisted = await deps.store.persistRound(parsed, canonicalNow(deps.now()), round.leaseToken);
    outcome = {
      gmTs: round.gmTs,
      status: persisted.status,
      inserted: persisted.inserted,
      updatedPending: persisted.updatedPending,
      preservedFinal: persisted.preservedFinal,
      excluded: persisted.excluded,
      error: null,
    };
  } catch (error) {
    if (stage === "fetch") providerLatencyMs = elapsedMs(providerStarted, telemetry.clock());
    let classified = classifyRoundError(error, stage);
    try {
      await deps.store.recordRoundError(
        round,
        classified.code,
        classified.message,
        canonicalNow(deps.now()),
        round.leaseToken,
      );
    } catch (recordError) {
      classified = classifyStoreOperationError(recordError);
    }
    outcome = failedRound(round, classified);
  } finally {
    try {
      await deps.store.releaseLease(roundKey(round), round.leaseToken);
    } catch (releaseError) {
      const leaseError = classifyStoreOperationError(releaseError);
      outcome = outcome
        ? {
            ...outcome,
            error: toRoundError(leaseError),
          }
        : failedRound(round, leaseError);
    }
  }
  const result = outcome ?? failedRound(round, publicError("INTERNAL_ERROR"));
  safeEmit(telemetry.logger, {
    event: "odds_history.round",
    correlationId: telemetry.correlationId,
    roundKey: roundKey(round),
    status: result.status,
    errorCode: result.error?.code ?? null,
    durationMs: elapsedMs(roundStarted, telemetry.clock()),
    providerLatencyMs,
  });
  return result;
}

function buildSyncPayload(
  attemptedRounds: SyncRoundResult[],
  busyRounds: ClosedRoundRef[],
  claim: ClaimResult,
  cursor: SyncCursorData,
  nextIndex: number,
  startedAt: string,
  finishedAt: string,
): SyncPayload {
  const busyResults = busyRounds.map(busyRound);
  const position = new Map(cursor.roundKeys.map((key, index) => [key, index]));
  const rounds = [...attemptedRounds, ...busyResults].sort((left, right) =>
    (position.get(`G101:${left.gmTs}`) ?? Number.MAX_SAFE_INTEGER)
      - (position.get(`G101:${right.gmTs}`) ?? Number.MAX_SAFE_INTEGER));
  const previous = cursor.progress ?? emptyProgress();
  const currentUnresolved = claim.deferredPending
    + busyRounds.length
    + attemptedRounds.filter((round) => round.status === "PENDING" || round.status === "ERROR").length;
  const currentPartial = currentUnresolved > 0 || attemptedRounds.some((round) => round.error !== null);
  const progress: SyncProgress = {
    remainingUnresolvedRounds: previous.remainingUnresolvedRounds + currentUnresolved,
    deferredPendingRounds: previous.deferredPendingRounds + claim.deferredPending,
    nextPendingRetryAt: earliestInstant(previous.nextPendingRetryAt, claim.nextPendingRetryAt),
    hadPartial: previous.hadPartial || currentPartial,
  };
  const hasMore = nextIndex < cursor.roundKeys.length;
  const nextCursor = hasMore ? encodeSyncCursor({ ...cursor, nextIndex, progress }) : null;
  return {
    status: progress.hadPartial ? "partial" : "completed",
    processedRounds: attemptedRounds.length,
    maxRoundsPerRequest: MAX_ROUNDS_PER_SYNC,
    maxParallelDetails: MAX_PARALLEL_DETAILS,
    rounds,
    hasMore,
    nextCursor,
    remainingUnresolvedRounds: progress.remainingUnresolvedRounds,
    deferredPendingRounds: progress.deferredPendingRounds,
    nextPendingRetryAt: progress.nextPendingRetryAt,
    startedAt,
    finishedAt,
  };
}

function newestFirst(rounds: ClosedRoundRef[]): ClosedRoundRef[] {
  const unique = new Map<string, ClosedRoundRef>();
  for (const round of rounds) {
    if (round.gmId !== "G101" || !/^\d+$/u.test(round.gmTs)) {
      throw requestError("BETMAN_SCHEMA_CHANGED");
    }
    unique.set(roundKey(round), round);
  }
  return [...unique.values()].sort((left, right) => {
    const leftValue = BigInt(left.gmTs);
    const rightValue = BigInt(right.gmTs);
    if (leftValue === rightValue) return 0;
    return leftValue > rightValue ? -1 : 1;
  });
}

function roundKey(round: ClosedRoundRef): string {
  return `${round.gmId}:${round.gmTs}`;
}

function earliestInstant(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

function classifyRoundError(error: unknown, stage: "fetch" | "parse" | "persist"): ClassifiedError {
  if (error instanceof OddsHistoryValidationError) return classifiedValidationError(error);
  if (error instanceof BetmanHistorySchemaError) return publicError("BETMAN_SCHEMA_CHANGED");
  if (hasErrorCode(error, "FINAL_CONFLICT") || hasMessagePrefix(error, "FINAL_CONFLICT")) {
    return publicError("FINAL_CONFLICT");
  }
  if (stage === "fetch") return publicError("BETMAN_UNAVAILABLE");
  if (stage === "parse") return publicError("BETMAN_SCHEMA_CHANGED");
  return publicError("INTERNAL_ERROR");
}

function classifyStoreOperationError(error: unknown): ClassifiedError {
  if (error instanceof OddsHistoryValidationError) return classifiedValidationError(error);
  return publicError("INTERNAL_ERROR");
}

function classifiedValidationError(error: OddsHistoryValidationError): ClassifiedError {
  switch (error.code) {
    case "ROUND_BUSY":
    case "BETMAN_UNAVAILABLE":
    case "BETMAN_SCHEMA_CHANGED":
    case "FINAL_CONFLICT":
    case "DATABASE_UNAVAILABLE":
    case "INTERNAL_ERROR":
      return publicError(error.code);
    default:
      return {
        code: error.code,
        message: "요청을 처리하지 못했습니다.",
        retryable: error.retryable,
      };
  }
}

function aggregateRoundFailure(rounds: SyncRoundResult[]): OddsHistoryValidationError {
  const codes = rounds.map((round) => round.error?.code);
  if (codes.includes("DATABASE_UNAVAILABLE")) return requestError("DATABASE_UNAVAILABLE");
  if (codes.includes("INTERNAL_ERROR")) return requestError("INTERNAL_ERROR");
  if (codes.includes("FINAL_CONFLICT")) return requestError("FINAL_CONFLICT");
  if (codes.includes("BETMAN_SCHEMA_CHANGED")) return requestError("BETMAN_SCHEMA_CHANGED");
  if (codes.includes("BETMAN_UNAVAILABLE")) return requestError("BETMAN_UNAVAILABLE");
  return requestError("INTERNAL_ERROR");
}

function failedRound(round: ClosedRoundRef, error: ClassifiedError): SyncRoundResult {
  return {
    gmTs: round.gmTs,
    status: "ERROR",
    inserted: 0,
    updatedPending: 0,
    preservedFinal: 0,
    excluded: { cancelled: 0, pendingResult: 0, missingOdds: 0, teamMatchFailed: 0 },
    error: toRoundError(error),
  };
}

function busyRound(round: ClosedRoundRef): SyncRoundResult {
  return {
    gmTs: round.gmTs,
    status: "SYNCING",
    inserted: 0,
    updatedPending: 0,
    preservedFinal: 0,
    excluded: { cancelled: 0, pendingResult: 0, missingOdds: 0, teamMatchFailed: 0 },
    error: toRoundError(publicError("ROUND_BUSY")),
  };
}

function toRoundError(error: ClassifiedError): SyncRoundError {
  return { code: error.code, message: error.message };
}

function publicError(
  code: "ROUND_BUSY" | "BETMAN_UNAVAILABLE" | "BETMAN_SCHEMA_CHANGED" | "FINAL_CONFLICT" | "DATABASE_UNAVAILABLE" | "INTERNAL_ERROR",
): ClassifiedError {
  return { code, ...PUBLIC_ERRORS[code] };
}

function requestError(
  code: "ROUND_BUSY" | "BETMAN_UNAVAILABLE" | "BETMAN_SCHEMA_CHANGED" | "FINAL_CONFLICT" | "DATABASE_UNAVAILABLE" | "INTERNAL_ERROR",
): OddsHistoryValidationError {
  const error = publicError(code);
  return new OddsHistoryValidationError(error.code, error.message, null, error.retryable);
}

function normalizedOperationalError(code: OddsHistoryErrorCode): OddsHistoryValidationError {
  switch (code) {
    case "ROUND_BUSY":
    case "BETMAN_UNAVAILABLE":
    case "BETMAN_SCHEMA_CHANGED":
    case "FINAL_CONFLICT":
    case "DATABASE_UNAVAILABLE":
    case "INTERNAL_ERROR":
      return requestError(code);
    default:
      return requestError("INTERNAL_ERROR");
  }
}

function canonicalNow(date: Date): string {
  try {
    return date.toISOString();
  } catch {
    throw requestError("INTERNAL_ERROR");
  }
}

function assertClaimResult(claim: ClaimResult, remainingLength: number, waveLimit: number): void {
  if (
    !Number.isSafeInteger(claim.nextIndex)
    || claim.nextIndex < 0
    || claim.nextIndex > remainingLength
    || claim.claimed.length > waveLimit
    || !Array.isArray(claim.busy)
    || claim.skippedFinal < 0
    || claim.deferredPending < 0
    || claim.claimed.length + claim.busy.length + claim.skippedFinal + claim.deferredPending !== claim.nextIndex
  ) throw requestError("INTERNAL_ERROR");
}

function emptyProgress(): SyncProgress {
  return {
    remainingUnresolvedRounds: 0,
    deferredPendingRounds: 0,
    nextPendingRetryAt: null,
    hadPartial: false,
  };
}

function telemetryContext(deps: SyncDependencies): TelemetryContext {
  const supplied = deps.correlationId;
  const correlationId = supplied && /^[A-Za-z0-9._:-]{1,128}$/u.test(supplied)
    ? supplied
    : crypto.randomUUID();
  return {
    correlationId,
    logger: deps.logger,
    clock: deps.monotonicNow ?? (() => performance.now()),
  };
}

function emitSyncTelemetry(
  telemetry: TelemetryContext,
  status: SyncPayload["status"] | "error",
  errorCode: string | null,
  discoveredRounds: number,
  attemptedRounds: SyncRoundResult[],
  busyRounds: number,
  started: number,
): void {
  const partialRounds = attemptedRounds.filter((round) =>
    round.status === "PENDING" || round.status === "ERROR" || round.error !== null).length;
  safeEmit(telemetry.logger, {
    event: "odds_history.sync",
    correlationId: telemetry.correlationId,
    status,
    httpStatus: status === "error" ? telemetryHttpStatus(errorCode) : 200,
    errorCode,
    discoveredRounds,
    attemptedRounds: attemptedRounds.length,
    succeededRounds: attemptedRounds.length - partialRounds,
    partialRounds: partialRounds + busyRounds,
    busyRounds,
    durationMs: elapsedMs(started, telemetry.clock()),
  });
}

function safeEmit(logger: SyncDependencies["logger"], event: OddsHistoryOperationalEvent): void {
  try {
    logger?.(event);
  } catch {
    // Telemetry must never affect sync behavior.
  }
}

function elapsedMs(started: number, finished: number): number {
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
  return Math.max(0, Math.round(finished - started));
}

function telemetryErrorCode(error: unknown): string {
  if (error instanceof OddsHistoryValidationError) return error.code;
  if (error instanceof BetmanHistorySchemaError) return "BETMAN_SCHEMA_CHANGED";
  return "INTERNAL_ERROR";
}

function telemetryHttpStatus(errorCode: string | null): number {
  if (["INVALID_DATE", "INVALID_DATE_RANGE", "INVALID_LEAGUE", "INVALID_TEAM", "INVALID_PAGE", "INVALID_CURSOR"].includes(errorCode ?? "")) return 400;
  if (errorCode === "ROUND_BUSY") return 409;
  if (["BETMAN_UNAVAILABLE", "BETMAN_SCHEMA_CHANGED", "FINAL_CONFLICT"].includes(errorCode ?? "")) return 502;
  if (errorCode === "DATABASE_UNAVAILABLE") return 503;
  return 500;
}

function errorStatus(code: OddsHistoryErrorCode): number {
  if (["INVALID_DATE", "INVALID_DATE_RANGE", "INVALID_LEAGUE", "INVALID_TEAM", "INVALID_PAGE", "INVALID_CURSOR"].includes(code)) return 400;
  if (code === "ROUND_BUSY") return 409;
  if (code === "BETMAN_UNAVAILABLE" || code === "BETMAN_SCHEMA_CHANGED" || code === "FINAL_CONFLICT") return 502;
  if (code === "DATABASE_UNAVAILABLE") return 503;
  return 500;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

function hasMessagePrefix(error: unknown, prefix: string): boolean {
  return error instanceof Error && error.message.startsWith(`${prefix}:`);
}
