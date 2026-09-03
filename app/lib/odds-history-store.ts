import type {
  ClosedRoundRef,
  ClaimedClosedRound,
  ExcludedCounts,
  HistoryDisplayStatus,
  OddsHistoryPayload,
  OddsHistoryQuery,
  OddsHistoryRecord,
  ParsedClosedRound,
  ParsedHistoryMatch,
  RoundStatus,
} from "./betman-history-types.ts";
import { OddsHistoryValidationError } from "./odds-history-contract.ts";
import { strictHistoryTeamIdentityForAlias } from "./betman-history-parser.ts";
import { teamsForLeague } from "./team-aliases.ts";

type RoundRow = {
  round_key: string;
  gm_id: string;
  gm_ts: string;
  source_url: string;
  status: RoundStatus;
  provider_final: number;
  event_from: string | null;
  event_to: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  finalized_at: string | null;
  error_code: string | null;
  error_message: string | null;
  lease_expires_at: string | null;
  lease_token: string | null;
  created_at: string;
  updated_at: string;
};

type MatchRow = {
  source_key: string;
  round_key: string;
  gm_id: string;
  gm_ts: string;
  match_seq: string;
  league_code: "K1" | "J1";
  league_name: string;
  betman_league_name: string;
  kickoff_at: string;
  match_date: string;
  home_team_id: number | null;
  away_team_id: number | null;
  home_team_name: string | null;
  away_team_name: string | null;
  betman_home_team: string;
  betman_away_team: string;
  home_score: number | null;
  away_score: number | null;
  result: "H" | "D" | "A" | null;
  home_odds: number | null;
  draw_odds: number | null;
  away_odds: number | null;
  display_status: HistoryDisplayStatus;
  source_final: number;
  first_seen_at: string;
  last_seen_at: string;
  finalized_at: string | null;
};

type CountRow = { total: number };
type ExcludedRow = { cancelled: number; pending_result: number; missing_odds: number; team_match_failed: number };

export interface OddsHistoryStore {
  registerRounds(rounds: ClosedRoundRef[], now: string): Promise<void>;
  query(query: OddsHistoryQuery, now: string): Promise<OddsHistoryPayload>;
  claimCandidates(roundKeys: string[], now: string, limit: number): Promise<{
    claimed: ClaimedClosedRound[];
    busy: ClosedRoundRef[];
    skippedFinal: number;
    deferredPending: number;
    nextPendingRetryAt: string | null;
    nextIndex: number;
  }>;
  persistRound(round: ParsedClosedRound, now: string, leaseToken: string): Promise<{
    status: RoundStatus;
    inserted: number;
    updatedPending: number;
    preservedFinal: number;
    excluded: ExcludedCounts;
  }>;
  recordRoundError(round: ClosedRoundRef, code: string, message: string, now: string, leaseToken: string): Promise<void>;
  rematchFinalTeamFailures(roundKeys: string[], now: string): Promise<number>;
  releaseLease(roundKey: string, leaseToken: string): Promise<void>;
}

const COOLDOWN_MS = 30 * 60 * 1000;
const LEASE_MS = 60 * 1000;
const REGISTER_ROWS_PER_STATEMENT = 16;
const REMATCH_KEYS_PER_READ = 50;
const D1_BATCH_STATEMENT_LIMIT = 100;

async function executeD1<T>(operation: () => Promise<T>, beforeWrap?: () => Promise<void>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof OddsHistoryValidationError) throw error;
    await beforeWrap?.();
    throw new OddsHistoryValidationError(
      "DATABASE_UNAVAILABLE",
      "D1 저장소를 사용할 수 없습니다.",
      null,
      true,
    );
  }
}

export function pendingRetryAt(row: { last_success_at: string | null; last_attempt_at: string | null }): string | null {
  const timestamps = [row.last_success_at, row.last_attempt_at]
    .filter((value): value is string => value !== null)
    .map(Date.parse)
    .filter(Number.isFinite);
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps) + COOLDOWN_MS).toISOString();
}

export function createOddsHistoryStore(database: D1Database): OddsHistoryStore {
  return {
    registerRounds: (rounds, now) => registerRounds(database, rounds, now),
    query: (query, now) => queryHistory(database, query, now),
    claimCandidates: (roundKeys, now, limit) => claimCandidates(database, roundKeys, now, limit),
    persistRound: (round, now, leaseToken) => persistRound(database, round, now, leaseToken),
    recordRoundError: (round, code, message, now, leaseToken) => recordRoundError(database, round, code, message, now, leaseToken),
    rematchFinalTeamFailures: (roundKeys, now) => rematchFinalTeamFailures(database, roundKeys, now),
    releaseLease: (roundKey, leaseToken) => releaseLease(database, roundKey, leaseToken),
  };
}

async function registerRounds(database: D1Database, rounds: ClosedRoundRef[], now: string): Promise<void> {
  if (rounds.length === 0) return;
  const statements = chunk(rounds, REGISTER_ROWS_PER_STATEMENT).map((roundChunk) => database.prepare(`
    /* odds-history:register-round */
    INSERT INTO betman_history_rounds (
      round_key, gm_id, gm_ts, source_url, status, provider_final, attempt_count, created_at, updated_at
    ) VALUES ${roundChunk.map(() => "(?, ?, ?, ?, 'DISCOVERED', 0, 0, ?, ?)").join(", ")}
    ON CONFLICT(round_key) DO NOTHING
  `).bind(...roundChunk.flatMap((round) => [roundKey(round), round.gmId, round.gmTs, round.sourceUrl, now, now])));
  await executeD1(() => database.batch(statements));
}

async function claimCandidates(
  database: D1Database,
  roundKeys: string[],
  now: string,
  limit: number,
): Promise<{
  claimed: ClaimedClosedRound[];
  busy: ClosedRoundRef[];
  skippedFinal: number;
  deferredPending: number;
  nextPendingRetryAt: string | null;
  nextIndex: number;
}> {
  const claimed: ClaimedClosedRound[] = [];
  const busy: ClosedRoundRef[] = [];
  let skippedFinal = 0;
  let deferredPending = 0;
  let nextPendingRetryAt: string | null = null;
  let nextIndex = 0;
  const leaseExpiresAt = new Date(Date.parse(now) + LEASE_MS).toISOString();
  const cooldownCutoff = new Date(Date.parse(now) - COOLDOWN_MS).toISOString();

  while (nextIndex < roundKeys.length && claimed.length < limit) {
    const key = roundKeys[nextIndex];
    nextIndex += 1;
    const row = await selectRound(database, key);
    if (!row) continue;
    if (row.status === "FINAL") {
      skippedFinal += 1;
      continue;
    }
    if (row.status === "PENDING") {
      const retryAt = pendingRetryAt(row);
      if (retryAt !== null && retryAt > now) {
        deferredPending += 1;
        if (nextPendingRetryAt === null || retryAt < nextPendingRetryAt) nextPendingRetryAt = retryAt;
        continue;
      }
    }

    const leaseToken = crypto.randomUUID();
    const claimStatement = database.prepare(`
      /* odds-history:claim-round */
      UPDATE betman_history_rounds
      SET status = 'SYNCING', attempt_count = attempt_count + 1,
          last_attempt_at = ?, lease_expires_at = ?, lease_token = ?, updated_at = ?
      WHERE round_key = ?
        AND status = ?
        AND status IN ('DISCOVERED', 'PENDING', 'ERROR', 'SYNCING')
        AND (
          status <> 'PENDING'
          OR (
            (last_success_at IS NULL OR last_success_at <= ?)
            AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
          )
        )
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).bind(now, leaseExpiresAt, leaseToken, now, key, row.status, cooldownCutoff, cooldownCutoff, now);
    const result = await executeD1(() => claimStatement.run());
    if (changes(result) === 1) {
      claimed.push({ ...toRoundRef(row), leaseToken });
      continue;
    }
    const latest = await selectRound(database, key);
    if (latest?.status === "FINAL") {
      skippedFinal += 1;
      continue;
    }
    if (latest?.status === "PENDING") {
      const retryAt = pendingRetryAt(latest);
      if (retryAt !== null && retryAt > now) {
        deferredPending += 1;
        if (nextPendingRetryAt === null || retryAt < nextPendingRetryAt) nextPendingRetryAt = retryAt;
        continue;
      }
    }
    busy.push(toRoundRef(latest ?? row));
  }

  return { claimed, busy, skippedFinal, deferredPending, nextPendingRetryAt, nextIndex };
}

async function selectRound(database: D1Database, key: string): Promise<RoundRow | null> {
  const statement = database.prepare(`
    /* odds-history:select-round */
    SELECT * FROM betman_history_rounds WHERE round_key = ?
  `).bind(key);
  return executeD1(() => statement.first<RoundRow>());
}

async function persistRound(
  database: D1Database,
  round: ParsedClosedRound,
  now: string,
  leaseToken: string,
): Promise<{
  status: RoundStatus;
  inserted: number;
  updatedPending: number;
  preservedFinal: number;
  excluded: ExcludedCounts;
}> {
  assertLeaseToken(leaseToken);
  validateRoundForPersistence(round, now);
  const existingRows = await loadRoundMatches(database, roundKey(round.round));
  const existing = new Map(existingRows.map((row) => [row.source_key, row]));
  let inserted = 0;
  let updatedPending = 0;
  let preservedFinal = 0;

  for (const candidate of round.matches) {
    const row = existing.get(candidate.sourceKey);
    if (!row) {
      inserted += 1;
      continue;
    }
    existing.set(candidate.sourceKey, row);
    if (row.source_final === 0) {
      updatedPending += 1;
      continue;
    }
    if (!sameFinalSource(row, candidate)) {
      await recordFinalConflict(database, round.round, candidate.sourceKey, now, leaseToken);
    }
    preservedFinal += 1;
  }

  const incomingKeys = new Set(round.matches.map((match) => match.sourceKey));
  const hasOmittedNonFinal = existingRows.some((row) => row.source_final === 0 && !incomingKeys.has(row.source_key));
  const incomingTerminal = round.matches.length === 0
    ? round.providerFinal
    : round.matches.every((match) => match.sourceFinal);
  const status: RoundStatus = incomingTerminal && !hasOmittedNonFinal ? "FINAL" : "PENDING";
  const finalizedAt = status === "FINAL" ? now : null;
  const statements: D1PreparedStatement[] = [
    leaseOwnerGuard(database, round.round, leaseToken, now),
    finalConflictGuard(database, round.matches, now),
  ];
  statements.push(database.prepare(`
    /* odds-history:persist-round */
    UPDATE betman_history_rounds SET
      gm_id = ?, gm_ts = ?, source_url = ?, status = ?, provider_final = ?,
      event_from = ?, event_to = ?, last_success_at = ?, finalized_at = ?,
      error_code = NULL,
      error_message = NULL,
      updated_at = ?
    WHERE round_key = ? AND status = 'SYNCING' AND lease_token = ?
  `).bind(
    round.round.gmId, round.round.gmTs, round.round.sourceUrl, status,
    round.providerFinal ? 1 : 0, round.eventFrom, round.eventTo,
    now, finalizedAt, now, roundKey(round.round), leaseToken,
  ));

  for (const match of round.matches) {
    const firstSeenAt = existing.get(match.sourceKey)?.first_seen_at ?? now;
    statements.push(database.prepare(`
      /* odds-history:persist-match */
      INSERT INTO betman_history_matches (
        source_key, round_key, gm_id, gm_ts, match_seq, league_code, league_name,
        betman_league_name, kickoff_at, match_date, home_team_id, away_team_id,
        home_team_name, away_team_name, betman_home_team, betman_away_team,
        home_score, away_score, result, home_odds, draw_odds, away_odds,
        display_status, source_final, first_seen_at, last_seen_at, finalized_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        round_key = excluded.round_key,
        gm_id = excluded.gm_id,
        gm_ts = excluded.gm_ts,
        match_seq = excluded.match_seq,
        league_code = excluded.league_code,
        league_name = excluded.league_name,
        betman_league_name = excluded.betman_league_name,
        kickoff_at = excluded.kickoff_at,
        match_date = excluded.match_date,
        home_team_id = excluded.home_team_id,
        away_team_id = excluded.away_team_id,
        home_team_name = excluded.home_team_name,
        away_team_name = excluded.away_team_name,
        betman_home_team = excluded.betman_home_team,
        betman_away_team = excluded.betman_away_team,
        home_score = excluded.home_score,
        away_score = excluded.away_score,
        result = excluded.result,
        home_odds = excluded.home_odds,
        draw_odds = excluded.draw_odds,
        away_odds = excluded.away_odds,
        display_status = excluded.display_status,
        source_final = excluded.source_final,
        last_seen_at = excluded.last_seen_at,
        finalized_at = excluded.finalized_at
      WHERE betman_history_matches.source_final = 0
    `).bind(
      match.sourceKey, match.roundKey, match.gmId, match.gmTs, match.matchSeq,
      match.leagueCode, match.leagueName, match.betmanLeagueName, match.kickoffAt, match.matchDate,
      match.homeTeamId, match.awayTeamId, match.homeTeamName, match.awayTeamName,
      match.betmanHomeTeam, match.betmanAwayTeam, match.homeScore, match.awayScore, match.result,
      match.homeOdds, match.drawOdds, match.awayOdds, match.displayStatus, match.sourceFinal ? 1 : 0,
      firstSeenAt, now, match.sourceFinal ? now : null,
    ));
  }

  await executeD1(() => database.batch(statements), async () => {
    const conflict = await findFinalConflict(database, roundKey(round.round), round.matches);
    if (conflict) await recordFinalConflict(database, round.round, conflict.sourceKey, now, leaseToken);
    if (!await ownsLease(database, roundKey(round.round), leaseToken)) throw leaseLost();
  });
  return { status, inserted, updatedPending, preservedFinal, excluded: excludedCounts(round.matches) };
}

function leaseOwnerGuard(
  database: D1Database,
  round: ClosedRoundRef,
  leaseToken: string,
  now: string,
): D1PreparedStatement {
  return database.prepare(`
    /* odds-history:lease-owner-guard */
    INSERT INTO betman_history_rounds (
      round_key, gm_id, gm_ts, source_url, status, provider_final, attempt_count, created_at, updated_at
    )
    SELECT ?, 'LEASE_LOST', '0', '', 'ERROR', 0, 0, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM betman_history_rounds
      WHERE round_key = ? AND status = 'SYNCING' AND lease_token = ?
    )
  `).bind(`__LEASE_OWNER_GUARD__:${roundKey(round)}`, now, now, roundKey(round), leaseToken);
}

function finalConflictGuard(database: D1Database, matches: ParsedHistoryMatch[], now: string): D1PreparedStatement {
  const serialized = JSON.stringify(matches.map(finalSourceSnapshot));
  return database.prepare(`
    /* odds-history:final-conflict-guard */
    INSERT INTO betman_history_rounds (
      round_key, gm_id, gm_ts, source_url, status, provider_final, attempt_count, created_at, updated_at
    )
    SELECT '__FINAL_CONFLICT_GUARD__', 'FINAL_CONFLICT', '0', '', 'ERROR', 0, 0, ?, ?
    WHERE EXISTS (
      SELECT 1
      FROM betman_history_matches AS stored
      JOIN json_each(?) AS incoming
        ON stored.source_key = json_extract(incoming.value, '$.sourceKey')
      WHERE stored.source_final = 1 AND NOT (
        stored.round_key IS json_extract(incoming.value, '$.roundKey')
        AND stored.gm_id IS json_extract(incoming.value, '$.gmId')
        AND stored.gm_ts IS json_extract(incoming.value, '$.gmTs')
        AND stored.match_seq IS json_extract(incoming.value, '$.matchSeq')
        AND stored.league_code IS json_extract(incoming.value, '$.leagueCode')
        AND stored.league_name IS json_extract(incoming.value, '$.leagueName')
        AND stored.betman_league_name IS json_extract(incoming.value, '$.betmanLeagueName')
        AND stored.kickoff_at IS json_extract(incoming.value, '$.kickoffAt')
        AND stored.match_date IS json_extract(incoming.value, '$.matchDate')
        AND stored.betman_home_team IS json_extract(incoming.value, '$.betmanHomeTeam')
        AND stored.betman_away_team IS json_extract(incoming.value, '$.betmanAwayTeam')
        AND stored.home_score IS json_extract(incoming.value, '$.homeScore')
        AND stored.away_score IS json_extract(incoming.value, '$.awayScore')
        AND stored.result IS json_extract(incoming.value, '$.result')
        AND stored.home_odds IS json_extract(incoming.value, '$.homeOdds')
        AND stored.draw_odds IS json_extract(incoming.value, '$.drawOdds')
        AND stored.away_odds IS json_extract(incoming.value, '$.awayOdds')
        AND (
          stored.display_status IS json_extract(incoming.value, '$.displayStatus')
          OR (
            stored.display_status IN ('INCLUDED', 'TEAM_MATCH_FAILED')
            AND json_extract(incoming.value, '$.displayStatus') IN ('INCLUDED', 'TEAM_MATCH_FAILED')
          )
        )
        AND stored.source_final IS json_extract(incoming.value, '$.sourceFinal')
      )
    )
  `).bind(now, now, serialized);
}

async function findFinalConflict(
  database: D1Database,
  roundKeyValue: string,
  matches: ParsedHistoryMatch[],
): Promise<ParsedHistoryMatch | null> {
  const rows = new Map((await loadRoundMatches(database, roundKeyValue)).map((row) => [row.source_key, row]));
  return matches.find((match) => {
    const row = rows.get(match.sourceKey);
    return row?.source_final === 1 && !sameFinalSource(row, match);
  }) ?? null;
}

async function recordFinalConflict(
  database: D1Database,
  round: ClosedRoundRef,
  sourceKey: string,
  now: string,
  leaseToken: string,
): Promise<never> {
  const message = `Finalized match differs for ${sourceKey}`;
  await recordRoundError(database, round, "FINAL_CONFLICT", message, now, leaseToken);
  throw new Error(`FINAL_CONFLICT: ${message}`);
}

async function recordRoundError(
  database: D1Database,
  round: ClosedRoundRef,
  code: string,
  message: string,
  now: string,
  leaseToken: string,
): Promise<void> {
  assertLeaseToken(leaseToken);
  const statement = database.prepare(`
    /* odds-history:record-error */
    UPDATE betman_history_rounds SET
      status = CASE WHEN status = 'FINAL' THEN 'FINAL' ELSE 'ERROR' END,
      error_code = ?,
      error_message = ?,
      updated_at = ?
    WHERE round_key = ? AND lease_token = ?
  `).bind(
    code, sanitizeErrorMessage(message), now, roundKey(round), leaseToken,
  );
  await executeD1(() => statement.run());
}

async function rematchFinalTeamFailures(database: D1Database, roundKeys: string[], now: string): Promise<number> {
  const updates: D1PreparedStatement[] = [];
  for (const keyChunk of chunk(roundKeys, REMATCH_KEYS_PER_READ)) {
    if (keyChunk.length === 0) continue;
    const selectStatement = database.prepare(`
      /* odds-history:select-rematch */
      SELECT source_key, league_code, betman_home_team, betman_away_team
      FROM betman_history_matches
      WHERE round_key IN (${keyChunk.map(() => "?").join(", ")})
        AND source_final = 1 AND display_status = 'TEAM_MATCH_FAILED'
    `).bind(...keyChunk);
    const result = await executeD1(() => selectStatement.all<Pick<MatchRow, "source_key" | "league_code" | "betman_home_team" | "betman_away_team">>());
    for (const row of result.results) {
      const home = strictHistoryTeamIdentityForAlias(row.league_code, row.betman_home_team);
      const away = strictHistoryTeamIdentityForAlias(row.league_code, row.betman_away_team);
      if (!home || !away) continue;
      updates.push(database.prepare(`
        /* odds-history:rematch */
        UPDATE betman_history_matches
        SET home_team_id = ?, away_team_id = ?, home_team_name = ?, away_team_name = ?,
            display_status = 'INCLUDED', last_seen_at = ?
        WHERE source_key = ? AND source_final = 1 AND display_status = 'TEAM_MATCH_FAILED'
      `).bind(home.id, away.id, home.name, away.name, now, row.source_key));
    }
  }
  if (updates.length === 0) return 0;
  let updated = 0;
  for (const updateChunk of chunk(updates, D1_BATCH_STATEMENT_LIMIT)) {
    const results = await executeD1(() => database.batch(updateChunk));
    updated += results.reduce((total, result) => total + changes(result), 0);
  }
  return updated;
}

async function releaseLease(database: D1Database, roundKey: string, leaseToken: string): Promise<void> {
  assertLeaseToken(leaseToken);
  const statement = database.prepare(`
    /* odds-history:release-lease */
    UPDATE betman_history_rounds SET lease_expires_at = NULL, lease_token = NULL
    WHERE round_key = ? AND lease_token = ?
  `).bind(roundKey, leaseToken);
  await executeD1(() => statement.run());
}

async function queryHistory(database: D1Database, query: OddsHistoryQuery, now: string): Promise<OddsHistoryPayload> {
  const recordFilter = matchFilter(query, false);
  const exclusionFilter = matchFilter(query, query.team !== null);
  const offset = (query.page - 1) * 30;
  const recordsStatement = database.prepare(`
    /* odds-history:query-records */
    SELECT * FROM betman_history_matches
    WHERE display_status = 'INCLUDED' AND ${recordFilter.sql}
      AND NOT EXISTS (
        SELECT 1 FROM betman_history_matches AS canonical_match
        WHERE canonical_match.round_key = betman_history_matches.round_key
          AND canonical_match.home_team_id = betman_history_matches.home_team_id
          AND canonical_match.away_team_id = betman_history_matches.away_team_id
          AND canonical_match.kickoff_at = betman_history_matches.kickoff_at
          AND CAST(canonical_match.match_seq AS INTEGER) < CAST(betman_history_matches.match_seq AS INTEGER)
      )
    ORDER BY kickoff_at DESC, gm_ts DESC, match_seq DESC
    LIMIT 30 OFFSET ?
  `).bind(...recordFilter.values, offset);
  const totalStatement = database.prepare(`
    /* odds-history:query-total */
    SELECT COUNT(*) AS total FROM betman_history_matches
    WHERE display_status = 'INCLUDED' AND ${recordFilter.sql}
      AND NOT EXISTS (
        SELECT 1 FROM betman_history_matches AS canonical_match
        WHERE canonical_match.round_key = betman_history_matches.round_key
          AND canonical_match.home_team_id = betman_history_matches.home_team_id
          AND canonical_match.away_team_id = betman_history_matches.away_team_id
          AND canonical_match.kickoff_at = betman_history_matches.kickoff_at
          AND CAST(canonical_match.match_seq AS INTEGER) < CAST(betman_history_matches.match_seq AS INTEGER)
      )
  `).bind(...recordFilter.values);
  const excludedStatement = database.prepare(`
    /* odds-history:query-excluded */
    SELECT
      COALESCE(SUM(CASE WHEN display_status = 'CANCELLED' THEN 1 ELSE 0 END), 0) AS cancelled,
      COALESCE(SUM(CASE WHEN display_status = 'PENDING_RESULT' THEN 1 ELSE 0 END), 0) AS pending_result,
      COALESCE(SUM(CASE WHEN display_status = 'MISSING_ODDS' THEN 1 ELSE 0 END), 0) AS missing_odds,
      COALESCE(SUM(CASE WHEN display_status = 'TEAM_MATCH_FAILED' THEN 1 ELSE 0 END), 0) AS team_match_failed
    FROM betman_history_matches
    WHERE display_status <> 'INCLUDED' AND ${exclusionFilter.sql}
  `).bind(...exclusionFilter.values);
  const archiveStatement = database.prepare(`
    /* odds-history:query-archive */
    SELECT status, last_success_at, last_attempt_at FROM betman_history_rounds
  `);
  const [recordsResult, totalResult, excludedResult, archiveResult] = await executeD1(() => database.batch([
    recordsStatement,
    totalStatement,
    excludedStatement,
    archiveStatement,
  ]));
  const records = recordsResult.results as MatchRow[];
  const totalRow = totalResult.results[0] as CountRow | undefined;
  const excludedRow = excludedResult.results[0] as ExcludedRow | undefined;
  const archiveRows = archiveResult.results as Array<Pick<RoundRow, "status" | "last_success_at" | "last_attempt_at">>;

  const total = numberValue(totalRow?.total);
  const coolingRetries = archiveRows
    .filter((row) => row.status === "PENDING")
    .map(pendingRetryAt)
    .filter((retry): retry is string => retry !== null && retry > now)
    .sort();
  const successful = archiveRows
    .map((row) => row.last_success_at)
    .filter((value): value is string => value !== null)
    .sort();

  return {
    query,
    teams: teamsForLeague(query.league),
    records: records.map(toHistoryRecord),
    pagination: {
      page: query.page,
      pageSize: 30,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / 30),
    },
    excludedCounts: {
      cancelled: numberValue(excludedRow?.cancelled),
      pendingResult: numberValue(excludedRow?.pending_result),
      missingOdds: numberValue(excludedRow?.missing_odds),
      teamMatchFailed: numberValue(excludedRow?.team_match_failed),
    },
    archive: {
      pendingRounds: archiveRows.filter((row) => row.status === "PENDING").length,
      cooldownPendingRounds: coolingRetries.length,
      errorRounds: archiveRows.filter((row) => row.status === "ERROR").length,
      nextPendingRetryAt: coolingRetries[0] ?? null,
      lastSuccessfulSyncAt: successful.at(-1) ?? null,
    },
  };
}

function matchFilter(query: OddsHistoryQuery, excludeUnattributableTeamFailure: boolean) {
  const clauses = ["match_date BETWEEN ? AND ?"];
  const values: unknown[] = [query.from, query.to];
  if (query.league !== "all") {
    clauses.push("/* filter:league */ league_code = ?");
    values.push(query.league);
  }
  if (query.team !== null) {
    const separator = query.team.indexOf(":");
    const teamLeague = query.team.slice(0, separator);
    const teamId = Number(query.team.slice(separator + 1));
    clauses.push("/* filter:team */ (league_code = ? AND (home_team_id = ? OR away_team_id = ?))");
    values.push(teamLeague, teamId, teamId);
    if (excludeUnattributableTeamFailure) clauses.push("display_status <> 'TEAM_MATCH_FAILED'");
  }
  return { sql: clauses.join(" AND "), values };
}

async function loadRoundMatches(database: D1Database, roundKeyValue: string): Promise<MatchRow[]> {
  const statement = database.prepare(`
    /* odds-history:select-round-matches */
    SELECT * FROM betman_history_matches WHERE round_key = ?
  `).bind(roundKeyValue);
  const result = await executeD1(() => statement.all<MatchRow>());
  return result.results;
}

async function ownsLease(database: D1Database, roundKeyValue: string, leaseToken: string): Promise<boolean> {
  const statement = database.prepare(`
    /* odds-history:select-lease-owner */
    SELECT round_key FROM betman_history_rounds
    WHERE round_key = ? AND status = 'SYNCING' AND lease_token = ?
  `).bind(roundKeyValue, leaseToken);
  return Boolean(await executeD1(() => statement.first<{ round_key: string }>()));
}

function leaseLost(): OddsHistoryValidationError {
  return new OddsHistoryValidationError(
    "ROUND_BUSY",
    "다른 동기화 요청이 회차 소유권을 인수했습니다.",
    null,
    true,
  );
}

function finalSourceSnapshot(match: ParsedHistoryMatch): Record<string, unknown> {
  return {
    sourceKey: match.sourceKey,
    roundKey: match.roundKey,
    gmId: match.gmId,
    gmTs: match.gmTs,
    matchSeq: match.matchSeq,
    leagueCode: match.leagueCode,
    leagueName: match.leagueName,
    betmanLeagueName: match.betmanLeagueName,
    kickoffAt: match.kickoffAt,
    matchDate: match.matchDate,
    betmanHomeTeam: match.betmanHomeTeam,
    betmanAwayTeam: match.betmanAwayTeam,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    result: match.result,
    homeOdds: match.homeOdds,
    drawOdds: match.drawOdds,
    awayOdds: match.awayOdds,
    displayStatus: match.displayStatus,
    sourceFinal: match.sourceFinal ? 1 : 0,
  };
}

function validateRoundForPersistence(round: ParsedClosedRound, now: string): void {
  if (!isCanonicalInstant(now)) throw new Error("Invalid finalized time");
  if (round.round.gmId !== "G101" || roundKey(round.round) !== `G101:${round.round.gmTs}`) throw new Error("Invalid round identity");
  const sourceKeys = new Set<string>();
  for (const match of round.matches) {
    if (sourceKeys.has(match.sourceKey)) throw new Error(`Duplicate source key ${match.sourceKey}`);
    sourceKeys.add(match.sourceKey);
    if (
      match.sourceKey !== `${match.gmId}:${match.gmTs}:${match.matchSeq}`
      || match.roundKey !== roundKey(round.round)
      || match.gmId !== round.round.gmId
      || match.gmTs !== round.round.gmTs
    ) throw new Error(`Invalid match identity ${match.sourceKey}`);
    if (match.displayStatus === "INCLUDED" && !isCompleteIncluded(match, now)) {
      throw new Error(`INCLUDED invariant failed for ${match.sourceKey}`);
    }
  }
}

function isCompleteIncluded(match: ParsedHistoryMatch, finalizedAt: string): boolean {
  return match.homeTeamId !== null
    && match.awayTeamId !== null
    && nonEmpty(match.homeTeamName)
    && nonEmpty(match.awayTeamName)
    && isScore(match.homeScore)
    && isScore(match.awayScore)
    && (match.result === "H" || match.result === "D" || match.result === "A")
    && positive(match.homeOdds)
    && positive(match.drawOdds)
    && positive(match.awayOdds)
    && match.sourceFinal
    && isCanonicalInstant(finalizedAt);
}

function sameFinalSource(row: MatchRow, match: ParsedHistoryMatch): boolean {
  const stored = [
    row.source_key, row.round_key, row.gm_id, row.gm_ts, row.match_seq,
    row.league_code, row.league_name, row.betman_league_name, row.kickoff_at, row.match_date,
    row.betman_home_team, row.betman_away_team, row.home_score, row.away_score, row.result,
    row.home_odds, row.draw_odds, row.away_odds, row.source_final,
  ];
  const incoming = [
    match.sourceKey, match.roundKey, match.gmId, match.gmTs, match.matchSeq,
    match.leagueCode, match.leagueName, match.betmanLeagueName, match.kickoffAt, match.matchDate,
    match.betmanHomeTeam, match.betmanAwayTeam, match.homeScore, match.awayScore, match.result,
    match.homeOdds, match.drawOdds, match.awayOdds, match.sourceFinal ? 1 : 0,
  ];
  return stored.every((value, index) => Object.is(value, incoming[index]))
    && compatibleFinalDisplayStatus(row.display_status, match.displayStatus);
}

function compatibleFinalDisplayStatus(stored: HistoryDisplayStatus, incoming: HistoryDisplayStatus): boolean {
  if (stored === incoming) return true;
  const rematchable = new Set<HistoryDisplayStatus>(["INCLUDED", "TEAM_MATCH_FAILED"]);
  return rematchable.has(stored) && rematchable.has(incoming);
}

function excludedCounts(matches: ParsedHistoryMatch[]): ExcludedCounts {
  return {
    cancelled: matches.filter((match) => match.displayStatus === "CANCELLED").length,
    pendingResult: matches.filter((match) => match.displayStatus === "PENDING_RESULT").length,
    missingOdds: matches.filter((match) => match.displayStatus === "MISSING_ODDS").length,
    teamMatchFailed: matches.filter((match) => match.displayStatus === "TEAM_MATCH_FAILED").length,
  };
}

function toHistoryRecord(row: MatchRow): OddsHistoryRecord {
  if (
    row.home_team_id === null || row.away_team_id === null
    || row.home_team_name === null || row.away_team_name === null
    || row.home_score === null || row.away_score === null || row.result === null
    || row.home_odds === null || row.draw_odds === null || row.away_odds === null
    || row.finalized_at === null
  ) throw new Error(`Stored INCLUDED invariant failed for ${row.source_key}`);
  return {
    sourceKey: row.source_key,
    round: row.gm_ts,
    matchSeq: row.match_seq,
    leagueCode: row.league_code,
    leagueName: row.league_name,
    kickoffAt: row.kickoff_at,
    date: row.match_date,
    homeTeamId: row.home_team_id,
    awayTeamId: row.away_team_id,
    homeTeam: row.home_team_name,
    awayTeam: row.away_team_name,
    betmanHomeTeam: row.betman_home_team,
    betmanAwayTeam: row.betman_away_team,
    score: { home: row.home_score, away: row.away_score },
    result: row.result,
    odds: { home: row.home_odds, draw: row.draw_odds, away: row.away_odds },
    finalizedAt: row.finalized_at,
  };
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/(set-cookie|cookie|authorization)\s*[:=][^\r\n]*/giu, "$1: [redacted]")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

function changes(result: D1Result<unknown>): number {
  return Number(result.meta.changes ?? 0);
}

function roundKey(round: ClosedRoundRef): string {
  return `${round.gmId}:${round.gmTs}`;
}

function toRoundRef(row: RoundRow): ClosedRoundRef {
  return { gmId: "G101", gmTs: row.gm_ts, sourceUrl: row.source_url, announcedAt: null };
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonEmpty(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isScore(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

function positive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function isCanonicalInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertLeaseToken(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw leaseLost();
  }
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
