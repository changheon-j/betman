"use client";

import { useEffect, useRef, useState } from "react";
import type React from "react";
import {
  defaultHistoryRange,
  OddsHistoryValidationError,
  parseOddsHistoryQuery,
} from "./lib/odds-history-contract";
import {
  fetchOddsHistoryPage,
  pageWindow,
  reconcileHistoryTeam,
  runOddsHistoryRefresh,
} from "./lib/odds-history-client";
import type {
  HistoryLeagueFilter,
  HistoryResult,
  HistoryTeamOption,
  OddsHistoryPayload,
  OddsHistoryQuery,
  SyncPayload,
} from "./lib/betman-history-types";

type HistoryDraft = Pick<OddsHistoryQuery, "league" | "team" | "from" | "to">;
type ValidationErrors = Partial<Record<keyof HistoryDraft, string>>;
type LoadPhase = "loading" | "syncing" | "settled" | "failed";

function defaultQuery(): OddsHistoryQuery {
  const range = defaultHistoryRange();
  return { league: "all", team: null, ...range, page: 1, pageSize: 30 };
}

function validatedQuery(draft: HistoryDraft): OddsHistoryQuery {
  const url = new URL("https://local.test/api/odds-history");
  url.searchParams.set("league", draft.league);
  url.searchParams.set("from", draft.from);
  url.searchParams.set("to", draft.to);
  url.searchParams.set("page", "1");
  if (draft.team) url.searchParams.set("team", draft.team);
  return parseOddsHistoryQuery(url);
}

function isAbortError(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "요청을 처리하지 못했습니다.";
}

function koreanDateTime(value: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}.${part("month")}.${part("day")} ${part("hour")}:${part("minute")}`;
}

function earliestRetryAt(sync: SyncPayload | null, archive: OddsHistoryPayload["archive"] | undefined): string | null {
  const candidates = [sync?.nextPendingRetryAt, archive?.nextPendingRetryAt].filter((value): value is string => !!value);
  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, value) => Date.parse(value) < Date.parse(earliest) ? value : earliest);
}

export function syncStatusText(
  sync: SyncPayload | null,
  archive: OddsHistoryPayload["archive"] | undefined,
  options: { syncing?: boolean; failed?: boolean; pageLoading?: boolean } = {},
): string {
  if (options.failed) return "동기화 실패";
  if (options.syncing) return `마감 회차 동기화 중 · 이번 요청 ${sync?.processedRounds ?? 0}/5`;
  const retryAt = earliestRetryAt(sync, archive);
  if (retryAt) return `다음 동기화 가능 ${koreanDateTime(retryAt)}`;
  const unresolved = sync?.remainingUnresolvedRounds ?? ((archive?.pendingRounds ?? 0) + (archive?.errorRounds ?? 0));
  if (sync?.status === "partial" || unresolved > 0) return `일부 회차 미확정 ${unresolved}개`;
  if (sync?.status === "completed") return "동기화 완료";
  if (options.pageLoading) return "페이지를 불러오는 중입니다.";
  return "저장 기록을 불러오는 중입니다.";
}

export function formatHistoryDate(value: string): string {
  return value.replaceAll("-", ".");
}

export function resultLabel(result: HistoryResult): string {
  return result === "H" ? "홈승" : result === "D" ? "무승부" : "원정승";
}

export function canGoPrevious(payload: OddsHistoryPayload | null, pagingDisabled = false): boolean {
  return !pagingDisabled && !!payload && payload.pagination.totalPages > 0 && payload.pagination.page > 1;
}

export function canGoNext(payload: OddsHistoryPayload | null, pagingDisabled = false): boolean {
  return !pagingDisabled && !!payload && payload.pagination.totalPages > 0 && payload.pagination.page < payload.pagination.totalPages;
}

export function mergeHistoryTeamCatalog(
  current: readonly HistoryTeamOption[],
  incoming: readonly HistoryTeamOption[],
): HistoryTeamOption[] {
  const catalog = new Map(current.map((team) => [team.key, team]));
  for (const team of incoming) catalog.set(team.key, team);
  return [...catalog.values()];
}

export function historyTeamsForLeague(
  catalog: readonly HistoryTeamOption[],
  league: HistoryLeagueFilter,
): HistoryTeamOption[] {
  return catalog.filter((team) => league === "all" || team.leagueCode === league);
}

export function historyPayloadForQuery(
  payload: OddsHistoryPayload | null,
  query: OddsHistoryQuery,
): OddsHistoryPayload | null {
  if (!payload) return null;
  const received = payload.query;
  return received.league === query.league
    && received.team === query.team
    && received.from === query.from
    && received.to === query.to
    && received.page === query.page
    && received.pageSize === query.pageSize
    ? payload
    : null;
}

export function shouldShowHistoryRetry(error: string, payload: OddsHistoryPayload | null): boolean {
  return error.length > 0 && payload === null;
}

export function OddsHistory(): React.JSX.Element {
  const [initialQuery] = useState(defaultQuery);
  const [draft, setDraft] = useState<HistoryDraft>({
    league: initialQuery.league,
    team: initialQuery.team,
    from: initialQuery.from,
    to: initialQuery.to,
  });
  const [applied, setApplied] = useState<OddsHistoryQuery>(initialQuery);
  const [refreshRequest, setRefreshRequest] = useState({ query: initialQuery, sequence: 0 });
  const [payload, setPayload] = useState<OddsHistoryPayload | null>(null);
  const [teamCatalog, setTeamCatalog] = useState<HistoryTeamOption[]>([]);
  const [sync, setSync] = useState<SyncPayload | null>(null);
  const [phase, setPhase] = useState<LoadPhase>("loading");
  const [pageLoading, setPageLoading] = useState(false);
  const [error, setError] = useState("");
  const [validationErrors, setValidationErrors] = useState<ValidationErrors>({});
  const generation = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  useEffect(() => {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const requestGeneration = ++generation.current;

    void runOddsHistoryRefresh({
      query: refreshRequest.query,
      fetchImpl: fetch,
      signal: controller.signal,
      isCurrent: () => generation.current === requestGeneration,
      onStored: (stored) => {
        setPayload(stored);
        setTeamCatalog((current) => mergeHistoryTeamCatalog(current, stored.teams));
        setPhase("syncing");
      },
      onSync: (nextSync) => {
        setSync(nextSync);
        setPhase("syncing");
      },
      onFinal: (finalPayload) => {
        setPayload(finalPayload);
        setTeamCatalog((current) => mergeHistoryTeamCatalog(current, finalPayload.teams));
        setPhase("settled");
      },
      onSyncError: (syncError) => {
        setError(syncError.message);
        setPhase("failed");
      },
    }).catch((caught) => {
      if (generation.current !== requestGeneration || isAbortError(caught)) return;
      setError(errorMessage(caught));
      setPhase("failed");
    });

    return () => {
      controller.abort();
      if (activeController.current === controller) activeController.current = null;
    };
  }, [refreshRequest]);

  useEffect(() => () => {
    generation.current += 1;
    activeController.current?.abort();
  }, []);

  const teamOptions = historyTeamsForLeague(teamCatalog, draft.league);
  const visiblePayload = historyPayloadForQuery(payload, applied);
  const pagination = visiblePayload?.pagination ?? null;
  const displayedPage = pagination && pagination.totalPages > 0 ? pagination.page : 1;
  const refreshBusy = phase === "loading" || phase === "syncing";
  const pagingDisabled = refreshBusy || pageLoading;

  function beginRefresh(query: OddsHistoryQuery) {
    setError("");
    setSync(null);
    setPhase("loading");
    setPageLoading(false);
    setApplied(query);
    setRefreshRequest((current) => ({ query, sequence: current.sequence + 1 }));
  }

  function changeLeague(league: HistoryLeagueFilter) {
    setValidationErrors({});
    setDraft((current) => ({
      ...current,
      league,
      team: reconcileHistoryTeam(current.team, league, teamCatalog),
    }));
  }

  function applyFilters() {
    try {
      const query = validatedQuery(draft);
      setValidationErrors({});
      beginRefresh(query);
    } catch (caught) {
      if (caught instanceof OddsHistoryValidationError && caught.field) {
        setValidationErrors({ [caught.field]: caught.message });
        return;
      }
      setError(errorMessage(caught));
    }
  }

  function resetFilters() {
    const query = defaultQuery();
    setDraft({ league: query.league, team: query.team, from: query.from, to: query.to });
    setValidationErrors({});
    beginRefresh(query);
  }

  async function changePage(page: number) {
    if (page < 1 || page === displayedPage || pagingDisabled) return;
    const totalPages = pagination?.totalPages ?? 0;
    if (totalPages === 0 || page > totalPages) return;

    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const requestGeneration = ++generation.current;
    setPageLoading(true);

    try {
      const requestedQuery = { ...applied, page };
      let nextPayload: OddsHistoryPayload | null = null;
      await fetchOddsHistoryPage({
        query: requestedQuery,
        fetchImpl: fetch,
        signal: controller.signal,
        isCurrent: () => generation.current === requestGeneration,
        onPage: (pagePayload) => { nextPayload = pagePayload; },
      });
      if (!nextPayload || generation.current !== requestGeneration) return;

      const received: OddsHistoryPayload = nextPayload;
      if (received.records.length === 0 && received.pagination.totalPages > 0 && page > received.pagination.totalPages) {
        const lastPage = received.pagination.totalPages;
        await fetchOddsHistoryPage({
          query: { ...applied, page: lastPage },
          fetchImpl: fetch,
          signal: controller.signal,
          isCurrent: () => generation.current === requestGeneration,
          onPage: (lastPayload) => { nextPayload = lastPayload; },
        });
      }
      if (!nextPayload || generation.current !== requestGeneration) return;
      setPayload(nextPayload);
      setTeamCatalog((current) => mergeHistoryTeamCatalog(current, nextPayload!.teams));
      setApplied((current) => ({ ...current, page: nextPayload!.pagination.totalPages > 0 ? nextPayload!.pagination.page : 1 }));
    } catch (caught) {
      if (generation.current === requestGeneration && !isAbortError(caught)) setError(errorMessage(caught));
    } finally {
      if (generation.current === requestGeneration) setPageLoading(false);
      if (activeController.current === controller) activeController.current = null;
    }
  }

  const status = syncStatusText(sync, visiblePayload?.archive, {
    syncing: phase === "syncing",
    failed: phase === "failed",
    pageLoading,
  });

  return <section className="odds-page">
    <div className="section-heading odds-heading">
      <div><p className="eyebrow">ODDS ARCHIVE</p><h1>배당기록</h1><p>Betman 마감 경기의 결과와 최종 승·무·패 배당입니다.</p></div>
      <span>Betman 마감게임 · D1 아카이브</span>
    </div>

    <div className="odds-filter-card">
      <label>
        <span>리그</span>
        <select value={draft.league} onChange={(event) => changeLeague(event.target.value as HistoryLeagueFilter)}>
          <option value="all">전체</option><option value="K1">K리그1</option><option value="J1">J리그1</option>
        </select>
      </label>
      <label>
        <span>팀 선택</span>
        <select value={draft.team ?? ""} onChange={(event) => setDraft((current) => ({ ...current, team: event.target.value || null }))}>
          <option value="">전체 팀</option>
          {teamOptions.map((team) => <option key={team.key} value={team.key}>{team.name}</option>)}
        </select>
      </label>
      <div className="date-filter">
        <label>
          <span>시작일</span>
          <input type="date" value={draft.from} aria-invalid={!!validationErrors.from} aria-describedby={validationErrors.from ? "odds-from-error" : undefined} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} />
          {validationErrors.from && <small className="filter-error" id="odds-from-error" role="status">{validationErrors.from}</small>}
        </label>
        <i>—</i>
        <label>
          <span>종료일</span>
          <input type="date" value={draft.to} aria-invalid={!!validationErrors.to} aria-describedby={validationErrors.to ? "odds-to-error" : undefined} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} />
          {validationErrors.to && <small className="filter-error" id="odds-to-error" role="status">{validationErrors.to}</small>}
        </label>
      </div>
      <div className="filter-actions">
        <button type="button" className="search-filter" onClick={applyFilters}>조회</button>
        <button type="button" className="reset-filter" onClick={resetFilters}>초기화</button>
      </div>
    </div>

    {error && <div className="odds-error" role="status">
      <span>{error}</span>
      {shouldShowHistoryRetry(error, visiblePayload) && <button type="button" onClick={() => beginRefresh(applied)}>다시 시도</button>}
    </div>}
    <div className="odds-result-meta" role="status">
      <p>저장 기록 <strong>{visiblePayload?.pagination.total ?? 0}</strong>경기</p>
      <span>{status}</span>
    </div>
    <p className="odds-exclusions">취소 {visiblePayload?.excludedCounts.cancelled ?? 0} · 미정 {visiblePayload?.excludedCounts.pendingResult ?? 0} · 배당누락 {visiblePayload?.excludedCounts.missingOdds ?? 0} · 팀매칭실패 {visiblePayload?.excludedCounts.teamMatchFailed ?? 0}</p>
    {applied.team && <small className="odds-exclusion-help">팀매칭실패는 특정 팀에 안전하게 귀속할 수 없어 전체 팀에서만 집계됩니다.</small>}

    <div className="odds-grid-wrap">
      <table className="odds-grid">
        <thead><tr><th>경기일</th><th>리그</th><th>홈팀</th><th>원정팀</th><th>경기결과</th><th>승 배당</th><th>무 배당</th><th>패 배당</th></tr></thead>
        <tbody>
          {visiblePayload?.records.map((record) => <tr key={record.sourceKey}>
            <td><time>{formatHistoryDate(record.date)}</time><small>회차 {record.round}</small></td>
            <td><span className={`history-league league-${record.leagueCode.toLowerCase()}`}>{record.leagueName}</span></td>
            <td><span className="history-team"><strong>{record.homeTeam}</strong><small>Betman 원문: {record.betmanHomeTeam}</small></span></td>
            <td><span className="history-team"><strong>{record.awayTeam}</strong><small>Betman 원문: {record.betmanAwayTeam}</small></span></td>
            <td><strong className={`result-badge result-${record.result.toLowerCase()}`}>{record.score.home}–{record.score.away}<small>{resultLabel(record.result)}</small></strong></td>
            <td className={record.result === "H" ? "odd-hit odd-hit-h" : ""}>{record.odds.home.toFixed(2)}</td>
            <td className={record.result === "D" ? "odd-hit odd-hit-d" : ""}>{record.odds.draw.toFixed(2)}</td>
            <td className={record.result === "A" ? "odd-hit odd-hit-a" : ""}>{record.odds.away.toFixed(2)}</td>
          </tr>)}
          {visiblePayload && visiblePayload.records.length === 0 && <tr><td className="no-results" colSpan={8}>선택한 조건에 해당하는 확정 경기가 없습니다.</td></tr>}
        </tbody>
      </table>
    </div>

    <nav className="odds-pagination" aria-label="배당기록 페이지">
      <button type="button" onClick={() => void changePage(1)} disabled={!canGoPrevious(visiblePayload, pagingDisabled)}>처음</button>
      <button type="button" onClick={() => void changePage(displayedPage - 1)} disabled={!canGoPrevious(visiblePayload, pagingDisabled)}>이전</button>
      {pageWindow(displayedPage, pagination?.totalPages ?? 0).map((item, index) => item === "ellipsis"
        ? <span key={`ellipsis-${index}`} aria-hidden="true">…</span>
        : <button type="button" key={item} aria-current={item === displayedPage ? "page" : undefined} disabled={pagingDisabled || !pagination || pagination.totalPages === 0 || item === displayedPage} onClick={() => void changePage(item)}>{item}</button>)}
      <button type="button" onClick={() => void changePage(displayedPage + 1)} disabled={!canGoNext(visiblePayload, pagingDisabled)}>다음</button>
      <button type="button" onClick={() => void changePage(pagination?.totalPages || 1)} disabled={!canGoNext(visiblePayload, pagingDisabled)}>마지막</button>
    </nav>
  </section>;
}

export default OddsHistory;
