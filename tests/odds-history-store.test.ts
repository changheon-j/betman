import assert from "node:assert/strict";
import test from "node:test";
import type {
  ClosedRoundRef,
  ParsedClosedRound,
  ParsedHistoryMatch,
} from "../app/lib/betman-history-types.ts";
import {
  createOddsHistoryStore,
  pendingRetryAt,
} from "../app/lib/odds-history-store.ts";
import { OddsHistoryValidationError } from "../app/lib/odds-history-contract.ts";

type Row = Record<string, unknown>;
const ACTIVE_LEASE_TOKEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

class FakeStatement {
  constructor(
    readonly database: FakeD1,
    readonly query: string,
    readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new FakeStatement(this.database, this.query, values);
  }

  first<T>() {
    this.database.throwSynchronousFailure("first");
    return Promise.resolve(this.database.first(this) as T | null);
  }

  all<T>() {
    this.database.throwSynchronousFailure("all");
    return Promise.resolve({ results: this.database.all(this) as T[], success: true, meta: {} });
  }

  run<T>() {
    this.database.throwSynchronousFailure("run");
    return Promise.resolve(this.database.run(this) as T);
  }
}

class FakeD1 {
  rounds = new Map<string, Row>();
  matches = new Map<string, Row>();
  statements: FakeStatement[] = [];
  executedStatements: FakeStatement[] = [];
  batches: FakeStatement[][] = [];
  beforeNextBatch: (() => void) | null = null;
  beforeNextClaim: (() => void) | null = null;
  failNextBatchAt: number | null = null;
  failNextBatchError: Error | null = null;
  failNextSynchronously: "first" | "all" | "run" | "batch" | null = null;

  constructor(rounds: Row[] = [], matches: Row[] = []) {
    for (const row of rounds) this.rounds.set(String(row.round_key), structuredClone(row));
    for (const row of matches) this.matches.set(String(row.source_key), structuredClone(row));
  }

  prepare(query: string) {
    const statement = new FakeStatement(this, query);
    this.statements.push(statement);
    return statement;
  }

  batch(statements: FakeStatement[]) {
    this.throwSynchronousFailure("batch");
    return this.executeBatch(statements);
  }

  throwSynchronousFailure(method: "first" | "all" | "run" | "batch") {
    if (this.failNextSynchronously !== method) return;
    this.failNextSynchronously = null;
    throw new Error(`raw synchronous D1 ${method} secret`);
  }

  private async executeBatch(statements: FakeStatement[]) {
    if (this.failNextBatchError) {
      const error = this.failNextBatchError;
      this.failNextBatchError = null;
      throw error;
    }
    this.batches.push(statements);
    const beforeBatch = this.beforeNextBatch;
    this.beforeNextBatch = null;
    beforeBatch?.();
    const rounds = structuredClone(this.rounds);
    const matches = structuredClone(this.matches);
    try {
      const results: D1Result<unknown>[] = [];
      for (const [index, statement] of statements.entries()) {
        if (index === this.failNextBatchAt) throw new Error(`Injected batch failure at statement ${index}`);
        const marker = operation(statement.query);
        if (["query-records", "query-archive", "select-round-matches", "select-rematch"].includes(marker)) {
          results.push({ results: this.all(statement), success: true, meta: {} } as unknown as D1Result<unknown>);
        } else if (["query-total", "query-excluded"].includes(marker)) {
          const row = this.first(statement);
          results.push({ results: row ? [row] : [], success: true, meta: {} } as unknown as D1Result<unknown>);
        } else {
          results.push(this.run(statement));
        }
      }
      this.failNextBatchAt = null;
      return results;
    } catch (error) {
      this.failNextBatchAt = null;
      this.rounds = rounds;
      this.matches = matches;
      throw error;
    }
  }

  row(key: string) {
    return this.matches.get(key);
  }

  get deleteStatements() {
    return this.statements.filter(({ query }) => /\bDELETE\b/iu.test(query));
  }

  first(statement: FakeStatement): Row | null {
    this.executedStatements.push(statement);
    const marker = operation(statement.query);
    if (marker === "select-round") return clone(this.rounds.get(String(statement.values[0]))) ?? null;
    if (marker === "select-match") return clone(this.matches.get(String(statement.values[0]))) ?? null;
    if (marker === "select-lease-owner") {
      const [roundKey, leaseToken] = statement.values;
      const row = this.rounds.get(String(roundKey));
      return row?.status === "SYNCING" && row.lease_token === leaseToken ? { round_key: roundKey } : null;
    }
    if (marker === "query-total") return { total: this.filteredMatches(statement).filter((row) => row.display_status === "INCLUDED").length };
    if (marker === "query-excluded") {
      const rows = this.filteredMatches(statement).filter((row) => row.display_status !== "INCLUDED");
      return {
        cancelled: rows.filter((row) => row.display_status === "CANCELLED").length,
        pending_result: rows.filter((row) => row.display_status === "PENDING_RESULT").length,
        missing_odds: rows.filter((row) => row.display_status === "MISSING_ODDS").length,
        team_match_failed: rows.filter((row) => row.display_status === "TEAM_MATCH_FAILED").length,
      };
    }
    throw new Error(`Unsupported fake first operation: ${marker}`);
  }

  all(statement: FakeStatement): Row[] {
    this.executedStatements.push(statement);
    const marker = operation(statement.query);
    if (marker === "select-rematch") {
      const roundKeys = new Set(statement.values.map(String));
      return [...this.matches.values()]
        .filter((row) => roundKeys.has(String(row.round_key)) && row.source_final === 1 && row.display_status === "TEAM_MATCH_FAILED")
        .map((row) => clone(row)!);
    }
    if (marker === "select-round-matches") {
      const roundKey = String(statement.values[0]);
      return [...this.matches.values()].filter((row) => row.round_key === roundKey).map((row) => clone(row)!);
    }
    if (marker === "query-records") {
      const offset = Number(statement.values.at(-1));
      return this.filteredMatches(statement)
        .filter((row) => row.display_status === "INCLUDED")
        .sort((left, right) => compareDesc(left.kickoff_at, right.kickoff_at)
          || compareDesc(left.gm_ts, right.gm_ts)
          || compareDesc(left.match_seq, right.match_seq))
        .slice(offset, offset + 30)
        .map((row) => clone(row)!);
    }
    if (marker === "query-archive") return [...this.rounds.values()].map((row) => clone(row)!);
    throw new Error(`Unsupported fake all operation: ${marker}`);
  }

  run(statement: FakeStatement): D1Result<unknown> {
    this.executedStatements.push(statement);
    const marker = operation(statement.query);
    const values = statement.values;
    let changes = 0;
    if (marker === "register-round") {
      for (let index = 0; index < values.length; index += 6) {
        const [roundKey, gmId, gmTs, sourceUrl, createdAt, updatedAt] = values.slice(index, index + 6);
        if (!this.rounds.has(String(roundKey))) {
          this.rounds.set(String(roundKey), roundRow({
            round_key: roundKey, gm_id: gmId, gm_ts: gmTs, source_url: sourceUrl,
            created_at: createdAt, updated_at: updatedAt,
          }));
          changes += 1;
        }
      }
    } else if (marker === "claim-round") {
      const beforeClaim = this.beforeNextClaim;
      this.beforeNextClaim = null;
      beforeClaim?.();
      const usesOwnershipToken = statement.query.includes("lease_token = ?");
      const [lastAttemptAt, leaseExpiresAt] = values;
      const leaseToken = usesOwnershipToken ? values[2] : null;
      const roundKey = usesOwnershipToken ? values[4] : values[2];
      const selectedStatus = usesOwnershipToken ? values[5] : null;
      const cooldownCutoff = usesOwnershipToken ? String(values[6]) : null;
      const now = usesOwnershipToken ? values[8] : values[3];
      const row = this.rounds.get(String(roundKey));
      const cooldownEligible = !usesOwnershipToken
        || row?.status !== "PENDING"
        || ((row.last_success_at === null || String(row.last_success_at) <= cooldownCutoff!)
          && (row.last_attempt_at === null || String(row.last_attempt_at) <= cooldownCutoff!));
      const statusEligible = usesOwnershipToken ? row?.status === selectedStatus : row?.status !== "FINAL";
      if (row && statusEligible && cooldownEligible && (row.lease_expires_at === null || String(row.lease_expires_at) <= String(now))) {
        Object.assign(row, {
          status: "SYNCING",
          attempt_count: Number(row.attempt_count) + 1,
          last_attempt_at: lastAttemptAt,
          lease_expires_at: leaseExpiresAt,
          lease_token: leaseToken,
          updated_at: lastAttemptAt,
        });
        changes = 1;
      }
    } else if (marker === "lease-owner-guard") {
      const [, , , roundKey, leaseToken] = values;
      const row = this.rounds.get(String(roundKey));
      if (row?.status !== "SYNCING" || row.lease_token !== leaseToken) {
        throw new Error("D1 constraint failed: ck_betman_history_round_gm lease owner");
      }
    } else if (marker === "final-conflict-guard") {
      const candidates = JSON.parse(String(values[2])) as Array<Record<string, unknown>>;
      for (const candidate of candidates) {
        const existing = this.matches.get(String(candidate.sourceKey));
        if (existing?.source_final === 1 && !sameFakeFinalSnapshot(existing, candidate)) {
          throw new Error("D1 constraint failed: ck_betman_history_round_gm");
        }
      }
    } else if (marker === "persist-round") {
      const [gmId, gmTs, sourceUrl, status, providerFinal, eventFrom, eventTo, lastSuccessAt, finalizedAt, updatedAt, roundKey, leaseToken] = values;
      const existing = this.rounds.get(String(roundKey));
      if (existing?.status === "SYNCING" && existing.lease_token === leaseToken) {
        Object.assign(existing, {
          gm_id: gmId, gm_ts: gmTs, source_url: sourceUrl, status,
          provider_final: providerFinal, event_from: eventFrom, event_to: eventTo,
          last_success_at: lastSuccessAt, finalized_at: finalizedAt,
          error_code: null, error_message: null, updated_at: updatedAt,
        });
        changes = 1;
      }
    } else if (marker === "persist-match") {
      const columns = [
        "source_key", "round_key", "gm_id", "gm_ts", "match_seq", "league_code", "league_name",
        "betman_league_name", "kickoff_at", "match_date", "home_team_id", "away_team_id",
        "home_team_name", "away_team_name", "betman_home_team", "betman_away_team", "home_score",
        "away_score", "result", "home_odds", "draw_odds", "away_odds", "display_status", "source_final",
        "first_seen_at", "last_seen_at", "finalized_at",
      ];
      const candidate = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
      const existing = this.matches.get(String(candidate.source_key));
      if (!existing) {
        this.matches.set(String(candidate.source_key), candidate);
        changes = 1;
      } else if (existing.source_final === 0) {
        const firstSeenAt = existing.first_seen_at;
        Object.assign(existing, candidate, { first_seen_at: firstSeenAt });
        changes = 1;
      }
    } else if (marker === "record-error") {
      const [code, message, now, roundKey, leaseToken] = values;
      const existing = this.rounds.get(String(roundKey));
      if (existing && existing.lease_token === leaseToken) {
        Object.assign(existing, {
          status: existing.status === "FINAL" ? "FINAL" : "ERROR",
          error_code: code,
          error_message: message,
          updated_at: now,
        });
        changes = 1;
      }
    } else if (marker === "rematch") {
      const [homeId, awayId, homeName, awayName, now, sourceKey] = values;
      const existing = this.matches.get(String(sourceKey));
      if (existing && existing.source_final === 1 && existing.display_status === "TEAM_MATCH_FAILED") {
        Object.assign(existing, {
          home_team_id: homeId, away_team_id: awayId,
          home_team_name: homeName, away_team_name: awayName,
          display_status: "INCLUDED", last_seen_at: now,
        });
        changes = 1;
      }
    } else if (marker === "release-lease") {
      const [roundKey, leaseToken] = values;
      const existing = this.rounds.get(String(roundKey));
      if (existing && existing.lease_token === leaseToken) {
        existing.lease_expires_at = null;
        existing.lease_token = null;
        changes = 1;
      }
    } else {
      throw new Error(`Unsupported fake run operation: ${marker}`);
    }
    return { results: [], success: true, meta: { changes } } as unknown as D1Result<unknown>;
  }

  private filteredMatches(statement: FakeStatement) {
    const values = statement.values;
    const from = String(values[0]);
    const to = String(values[1]);
    let index = 2;
    let league: string | null = null;
    let teamLeague: string | null = null;
    let team: number | null = null;
    const hasFilterMarkers = statement.query.includes("/* filter:");
    if (hasFilterMarkers) {
      if (statement.query.includes("/* filter:league */")) league = String(values[index++]);
      if (statement.query.includes("/* filter:team */")) {
        teamLeague = String(values[index++]);
        team = Number(values[index++]);
        index += 1;
      }
    } else {
      if (statement.query.includes("league_code = ?")) league = String(values[index++]);
      if (statement.query.includes("home_team_id = ?")) {
        team = Number(values[index++]);
        index += 1;
      }
    }
    return [...this.matches.values()].filter((row) => {
      if (String(row.match_date) < from || String(row.match_date) > to) return false;
      if (league && row.league_code !== league) return false;
      if (teamLeague && row.league_code !== teamLeague) return false;
      if (team !== null && row.home_team_id !== team && row.away_team_id !== team) return false;
      if (team !== null && statement.query.includes("display_status <> 'TEAM_MATCH_FAILED'") && row.display_status === "TEAM_MATCH_FAILED") return false;
      return true;
    });
  }
}

function sameFakeFinalSnapshot(row: Row, candidate: Record<string, unknown>) {
  const stored = [
    row.round_key, row.gm_id, row.gm_ts, row.match_seq, row.league_code, row.league_name,
    row.betman_league_name, row.kickoff_at, row.match_date, row.betman_home_team,
    row.betman_away_team, row.home_score, row.away_score, row.result, row.home_odds,
    row.draw_odds, row.away_odds,
  ];
  const incoming = [
    candidate.roundKey, candidate.gmId, candidate.gmTs, candidate.matchSeq,
    candidate.leagueCode, candidate.leagueName, candidate.betmanLeagueName,
    candidate.kickoffAt, candidate.matchDate, candidate.betmanHomeTeam,
    candidate.betmanAwayTeam, candidate.homeScore, candidate.awayScore,
    candidate.result, candidate.homeOdds, candidate.drawOdds, candidate.awayOdds,
  ];
  const compatibleDisplay = row.display_status === candidate.displayStatus
    || (["INCLUDED", "TEAM_MATCH_FAILED"].includes(String(row.display_status))
      && ["INCLUDED", "TEAM_MATCH_FAILED"].includes(String(candidate.displayStatus)));
  return stored.every((value, index) => Object.is(value, incoming[index]))
    && compatibleDisplay
    && Object.is(row.source_final, candidate.sourceFinal);
}

function operation(query: string) {
  return /\/\* odds-history:([a-z-]+) \*\//u.exec(query)?.[1] ?? "unknown";
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function compareDesc(left: unknown, right: unknown) {
  return String(right).localeCompare(String(left), "en");
}

function roundRef(gmTs = "260098"): ClosedRoundRef {
  return {
    gmId: "G101",
    gmTs,
    sourceUrl: `https://www.betman.co.kr/closed/G101/${gmTs}`,
    announcedAt: "2026-08-21T00:00:00.000Z",
  };
}

function roundRow(overrides: Row = {}): Row {
  const round = roundRef(String(overrides.gm_ts ?? "260098"));
  const row: Row = {
    round_key: `G101:${round.gmTs}`,
    gm_id: round.gmId,
    gm_ts: round.gmTs,
    source_url: round.sourceUrl,
    status: "DISCOVERED",
    provider_final: 0,
    event_from: null,
    event_to: null,
    attempt_count: 0,
    last_attempt_at: null,
    last_success_at: null,
    finalized_at: null,
    error_code: null,
    error_message: null,
    lease_expires_at: null,
    lease_token: null,
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:00:00.000Z",
    ...overrides,
  };
  if (row.status === "SYNCING" && row.lease_token === null) row.lease_token = ACTIVE_LEASE_TOKEN;
  return row;
}

function parsedMatch(overrides: Partial<ParsedHistoryMatch> = {}): ParsedHistoryMatch {
  const gmTs = overrides.gmTs ?? "260098";
  const matchSeq = overrides.matchSeq ?? "5345";
  return {
    sourceKey: `G101:${gmTs}:${matchSeq}`,
    roundKey: `G101:${gmTs}`,
    gmId: "G101",
    gmTs,
    matchSeq,
    leagueCode: "J1",
    leagueName: "J리그1",
    betmanLeagueName: "일본 J1리그",
    kickoffAt: "2026-08-21T19:30:00+09:00",
    matchDate: "2026-08-21",
    homeTeamId: 292,
    awayTeamId: 301,
    homeTeamName: "FC 도쿄",
    awayTeamName: "제프 유나이티드 지바",
    betmanHomeTeam: "FC도쿄",
    betmanAwayTeam: "제프 지바",
    homeScore: 2,
    awayScore: 1,
    result: "H",
    homeOdds: 2.1,
    drawOdds: 3.2,
    awayOdds: 3.4,
    displayStatus: "INCLUDED",
    sourceFinal: true,
    ...overrides,
  };
}

function parsedRound(matches = [parsedMatch()], overrides: Partial<ParsedClosedRound> = {}): ParsedClosedRound {
  const gmTs = overrides.round?.gmTs ?? matches[0]?.gmTs ?? "260098";
  return {
    round: roundRef(gmTs),
    fetchedAt: "2026-08-21T14:00:00.000Z",
    providerFinal: true,
    eventFrom: matches.length ? "2026-08-21" : null,
    eventTo: matches.length ? "2026-08-21" : null,
    matches,
    ...overrides,
  };
}

function matchRow(overrides: Row = {}): Row {
  const parsed = parsedMatch();
  return {
    source_key: parsed.sourceKey,
    round_key: parsed.roundKey,
    gm_id: parsed.gmId,
    gm_ts: parsed.gmTs,
    match_seq: parsed.matchSeq,
    league_code: parsed.leagueCode,
    league_name: parsed.leagueName,
    betman_league_name: parsed.betmanLeagueName,
    kickoff_at: parsed.kickoffAt,
    match_date: parsed.matchDate,
    home_team_id: parsed.homeTeamId,
    away_team_id: parsed.awayTeamId,
    home_team_name: parsed.homeTeamName,
    away_team_name: parsed.awayTeamName,
    betman_home_team: parsed.betmanHomeTeam,
    betman_away_team: parsed.betmanAwayTeam,
    home_score: parsed.homeScore,
    away_score: parsed.awayScore,
    result: parsed.result,
    home_odds: parsed.homeOdds,
    draw_odds: parsed.drawOdds,
    away_odds: parsed.awayOdds,
    display_status: parsed.displayStatus,
    source_final: 1,
    first_seen_at: "2026-08-21T14:00:00.000Z",
    last_seen_at: "2026-08-21T14:00:00.000Z",
    finalized_at: "2026-08-21T14:00:00.000Z",
    ...overrides,
  };
}

const asDatabase = (fake: FakeD1) => fake as unknown as D1Database;

test("pending cooldown uses the newer success/attempt timestamp", () => {
  assert.equal(pendingRetryAt({
    last_success_at: "2026-08-21T00:00:00.000Z",
    last_attempt_at: "2026-08-21T00:10:00.000Z",
  }), "2026-08-21T00:40:00.000Z");
  assert.equal(pendingRetryAt({ last_success_at: null, last_attempt_at: null }), null);
});

test("registers rounds without replacing existing state", async () => {
  const existing = roundRow({ status: "FINAL", provider_final: 1 });
  const fake = new FakeD1([existing]);
  const store = createOddsHistoryStore(asDatabase(fake));

  await store.registerRounds([roundRef("260098"), roundRef("260099")], "2026-08-21T01:00:00.000Z");

  assert.equal(fake.rounds.get("G101:260098")?.status, "FINAL");
  assert.equal(fake.rounds.get("G101:260099")?.status, "DISCOVERED");
  assert.equal(fake.batches[0].length, 1);
});

test("wraps a raw D1 registration batch rejection as retryable database unavailable", async () => {
  const fake = new FakeD1();
  fake.failNextBatchError = new Error("raw D1 register secret");

  await assert.rejects(
    () => createOddsHistoryStore(asDatabase(fake)).registerRounds([roundRef("260098")], "2026-08-21T01:00:00.000Z"),
    databaseUnavailable,
  );
});

const synchronousD1Cases: Array<{
  method: "first" | "all" | "run" | "batch";
  run: (store: ReturnType<typeof createOddsHistoryStore>) => Promise<unknown>;
}> = [
  {
    method: "first",
    run: (store) => store.claimCandidates(["G101:260098"], "2026-08-21T01:00:00.000Z", 1),
  },
  {
    method: "all",
    run: (store) => store.rematchFinalTeamFailures(["G101:260098"], "2026-08-21T01:00:00.000Z"),
  },
  {
    method: "run",
    run: (store) => store.releaseLease("G101:260098", ACTIVE_LEASE_TOKEN),
  },
  {
    method: "batch",
    run: (store) => store.registerRounds([roundRef("260098")], "2026-08-21T01:00:00.000Z"),
  },
];

for (const item of synchronousD1Cases) {
  test(`wraps a synchronous D1 ${item.method} throw as retryable database unavailable`, async () => {
    const fake = new FakeD1([roundRow()]);
    fake.failNextSynchronously = item.method;
    await assert.rejects(() => item.run(createOddsHistoryStore(asDatabase(fake))), databaseUnavailable);
  });
}

test("claim skips pending at 29:59, claims at 30:00, and never claims final", async () => {
  const pending = roundRow({
    status: "PENDING",
    last_success_at: "2026-08-21T00:00:00.000Z",
    last_attempt_at: "2026-08-21T00:10:00.000Z",
    attempt_count: 4,
  });
  const final = roundRow({ round_key: "G101:260099", gm_ts: "260099", status: "FINAL" });
  const fake = new FakeD1([pending, final]);
  const store = createOddsHistoryStore(asDatabase(fake));

  const cooling = await store.claimCandidates(["G101:260098"], "2026-08-21T00:39:59.000Z", 5);
  assert.deepEqual(cooling, {
    claimed: [], busy: [], skippedFinal: 0, deferredPending: 1,
    nextPendingRetryAt: "2026-08-21T00:40:00.000Z", nextIndex: 1,
  });
  assert.equal(fake.rounds.get("G101:260098")?.attempt_count, 4);
  assert.equal(fake.rounds.get("G101:260098")?.last_attempt_at, "2026-08-21T00:10:00.000Z");

  const boundary = await store.claimCandidates(["G101:260098"], "2026-08-21T00:40:00.000Z", 5);
  assert.equal(boundary.claimed.length, 1);
  assert.equal(fake.rounds.get("G101:260098")?.attempt_count, 5);
  assert.equal(fake.rounds.get("G101:260098")?.lease_expires_at, "2026-08-21T00:41:00.000Z");
  const claim = fake.executedStatements.findLast(({ query }) => query.includes("odds-history:claim-round"))!;
  assert.equal(claim.values[0], "2026-08-21T00:40:00.000Z");
  assert.equal(claim.values[1], "2026-08-21T00:41:00.000Z");
  assert.match(String(claim.values[2]), /^[0-9a-f-]{36}$/u);
  assert.deepEqual(claim.values.slice(3), [
    "2026-08-21T00:40:00.000Z",
    "G101:260098",
    "PENDING",
    "2026-08-21T00:10:00.000Z",
    "2026-08-21T00:10:00.000Z",
    "2026-08-21T00:40:00.000Z",
  ]);

  const finalResult = await store.claimCandidates(["G101:260099"], "2026-09-21T00:00:00.000Z", 5);
  assert.equal(finalResult.claimed.length, 0);
  assert.equal(finalResult.skippedFinal, 1);
  assert.equal(fake.rounds.get("G101:260099")?.attempt_count, 0);
});

test("claim respects leases, recovers expired leases, and advances by inspected cursor keys", async () => {
  const rows = Array.from({ length: 8 }, (_, index) => roundRow({
    round_key: `G101:${260100 + index}`,
    gm_ts: String(260100 + index),
    status: index === 0 ? "FINAL" : "DISCOVERED",
    lease_expires_at: index === 1 ? "2026-08-21T00:01:01.000Z" : index === 2 ? "2026-08-21T00:01:00.000Z" : null,
  }));
  const fake = new FakeD1(rows);
  const result = await createOddsHistoryStore(asDatabase(fake)).claimCandidates(
    rows.map((row) => String(row.round_key)),
    "2026-08-21T00:01:00.000Z",
    5,
  );

  assert.deepEqual(result.claimed.map(({ gmTs }) => gmTs), ["260102", "260103", "260104", "260105", "260106"]);
  assert.equal(result.nextIndex, 7);
  assert.equal(fake.rounds.get("G101:260101")?.attempt_count, 0);
});

test("persists one validated round and all candidates in one batch", async () => {
  const fake = new FakeD1([roundRow({ status: "SYNCING" })]);
  const excluded = parsedMatch({
    sourceKey: "G101:260098:5346", matchSeq: "5346", displayStatus: "CANCELLED",
    homeTeamId: null, awayTeamId: null, homeTeamName: null, awayTeamName: null,
    homeScore: null, awayScore: null, result: null,
  });
  const result = await createOddsHistoryStore(asDatabase(fake)).persistRound(
    parsedRound([parsedMatch(), excluded]),
    "2026-08-21T14:01:00.000Z",
    ACTIVE_LEASE_TOKEN,
  );

  assert.deepEqual(result, {
    status: "FINAL", inserted: 2, updatedPending: 0, preservedFinal: 0,
    excluded: { cancelled: 1, pendingResult: 0, missingOdds: 0, teamMatchFailed: 0 },
  });
  assert.equal(fake.batches.at(-1)?.length, 5);
  assert.equal(fake.rounds.get("G101:260098")?.status, "FINAL");
  assert.equal(fake.matches.size, 2);
  assert.equal(fake.deleteStatements.length, 0);
});

test("wraps a raw D1 persistence batch rejection after checking for final conflict", async () => {
  const fake = new FakeD1([roundRow({ status: "SYNCING" })]);
  fake.failNextBatchError = new Error("raw D1 persist secret");

  await assert.rejects(
    () => createOddsHistoryStore(asDatabase(fake)).persistRound(parsedRound(), "2026-08-21T14:01:00.000Z", ACTIVE_LEASE_TOKEN),
    databaseUnavailable,
  );
  assert.equal(fake.matches.size, 0);
});

test("pending rows can be fully replaced while identical final rows are idempotent", async () => {
  const pending = matchRow({ source_final: 0, home_odds: null, display_status: "MISSING_ODDS", finalized_at: null });
  const fake = new FakeD1([roundRow({ status: "SYNCING" })], [pending]);
  const store = createOddsHistoryStore(asDatabase(fake));

  const updated = await store.persistRound(parsedRound(), "2026-08-21T14:01:00.000Z", ACTIVE_LEASE_TOKEN);
  assert.equal(updated.updatedPending, 1);
  assert.equal(fake.row("G101:260098:5345")?.home_odds, 2.1);
  assert.equal(fake.row("G101:260098:5345")?.first_seen_at, "2026-08-21T14:00:00.000Z");

  fake.rounds.get("G101:260098")!.status = "SYNCING";
  const preserved = await store.persistRound(parsedRound(), "2026-08-21T14:02:00.000Z", ACTIVE_LEASE_TOKEN);
  assert.equal(preserved.preservedFinal, 1);
  assert.equal(fake.row("G101:260098:5345")?.last_seen_at, "2026-08-21T14:01:00.000Z");
});

test("final conflict preserves stored values and records FINAL_CONFLICT", async () => {
  const existingFinal = matchRow();
  const fake = new FakeD1([roundRow({ status: "SYNCING" })], [existingFinal]);
  const conflicting = parsedRound([parsedMatch({ homeOdds: 9.9 })]);

  await assert.rejects(
    () => createOddsHistoryStore(asDatabase(fake)).persistRound(conflicting, "2026-08-21T14:01:00.000Z", ACTIVE_LEASE_TOKEN),
    /FINAL_CONFLICT/u,
  );
  assert.equal(fake.row("G101:260098:5345")?.home_odds, existingFinal.home_odds);
  assert.equal(fake.rounds.get("G101:260098")?.error_code, "FINAL_CONFLICT");
  assert.equal(fake.deleteStatements.length, 0);
});

test("a racing finalized conflict aborts the success batch and is classified after rollback", async () => {
  const fake = new FakeD1([roundRow({ status: "SYNCING" })]);
  fake.beforeNextBatch = () => {
    fake.matches.set("G101:260098:5345", matchRow({ home_odds: 9.9 }));
  };

  await assert.rejects(
    () => createOddsHistoryStore(asDatabase(fake)).persistRound(parsedRound(), "2026-08-21T14:01:00.000Z", ACTIVE_LEASE_TOKEN),
    /FINAL_CONFLICT/u,
  );

  assert.equal(fake.row("G101:260098:5345")?.home_odds, 9.9);
  assert.equal(fake.rounds.get("G101:260098")?.status, "ERROR");
  assert.equal(fake.rounds.get("G101:260098")?.error_code, "FINAL_CONFLICT");
  assert.equal(fake.rounds.get("G101:260098")?.last_success_at, null);
});

test("a same-data finalized race is classified as lost lease ownership", async () => {
  const existingFinal = matchRow();
  const fake = new FakeD1([roundRow({ status: "SYNCING" })], [existingFinal]);
  fake.beforeNextBatch = () => {
    fake.rounds.get("G101:260098")!.status = "FINAL";
  };

  await assert.rejects(
    () => createOddsHistoryStore(asDatabase(fake)).persistRound(
      parsedRound(),
      "2026-08-21T14:01:00.000Z",
      ACTIVE_LEASE_TOKEN,
    ),
    (error: unknown) => error instanceof OddsHistoryValidationError && error.code === "ROUND_BUSY",
  );
  assert.equal(fake.rounds.get("G101:260098")?.status, "FINAL");
  assert.deepEqual(fake.row("G101:260098:5345"), existingFinal);
});

test("a finalized non-team display classification change is a conflict", async () => {
  const existingFinal = matchRow({ display_status: "CANCELLED" });
  const fake = new FakeD1([roundRow({ status: "SYNCING" })], [existingFinal]);

  await assert.rejects(
    () => createOddsHistoryStore(asDatabase(fake)).persistRound(parsedRound(), "2026-08-21T14:01:00.000Z", ACTIVE_LEASE_TOKEN),
    /FINAL_CONFLICT/u,
  );
  assert.equal(fake.row("G101:260098:5345")?.display_status, "CANCELLED");
});

test("final guard allows local team identity and rematch-status differences", async () => {
  const rematchableFinal = matchRow({
    home_team_id: null, away_team_id: null, home_team_name: null, away_team_name: null,
    display_status: "TEAM_MATCH_FAILED",
  });
  const fake = new FakeD1([roundRow({ status: "SYNCING" })], [rematchableFinal]);

  const result = await createOddsHistoryStore(asDatabase(fake)).persistRound(
    parsedRound(),
    "2026-08-21T14:01:00.000Z",
    ACTIVE_LEASE_TOKEN,
  );

  assert.equal(result.preservedFinal, 1);
  assert.equal(fake.row("G101:260098:5345")?.display_status, "TEAM_MATCH_FAILED");
  assert.equal(fake.rounds.get("G101:260098")?.status, "FINAL");
});

test("invalid INCLUDED candidate rejects before any batch", async () => {
  const fake = new FakeD1([roundRow({ status: "SYNCING" })]);
  const invalid = parsedRound([parsedMatch({ awayOdds: 0 })]);

  await assert.rejects(
    () => createOddsHistoryStore(asDatabase(fake)).persistRound(invalid, "2026-08-21T14:01:00.000Z", ACTIVE_LEASE_TOKEN),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof OddsHistoryValidationError));
      assert.match(error.message, /INCLUDED/u);
      return true;
    },
  );
  assert.equal(fake.batches.length, 0);
  assert.equal(fake.matches.size, 0);
});

function databaseUnavailable(error: unknown): boolean {
  assert.ok(error instanceof OddsHistoryValidationError);
  assert.equal(error.code, "DATABASE_UNAVAILABLE");
  assert.equal(error.message, "D1 저장소를 사용할 수 없습니다.");
  assert.equal(error.retryable, true);
  assert.doesNotMatch(error.message, /secret/u);
  return true;
}

test("a later batch statement failure rolls back the earlier round update", async () => {
  const fake = new FakeD1([roundRow({ status: "SYNCING" })]);
  fake.failNextBatchAt = 2;

  await assert.rejects(
    () => createOddsHistoryStore(asDatabase(fake)).persistRound(parsedRound(), "2026-08-21T14:01:00.000Z", ACTIVE_LEASE_TOKEN),
    databaseUnavailable,
  );

  assert.equal(fake.rounds.get("G101:260098")?.status, "SYNCING");
  assert.equal(fake.rounds.get("G101:260098")?.last_success_at, null);
  assert.equal(fake.matches.size, 0);
});

test("recordRoundError sanitizes messages and never downgrades FINAL", async () => {
  const active = roundRow({ status: "SYNCING" });
  const final = roundRow({ round_key: "G101:260099", gm_ts: "260099", status: "FINAL" });
  const fake = new FakeD1([active, final]);
  const store = createOddsHistoryStore(asDatabase(fake));

  await store.recordRoundError(roundRef("260098"), "BETMAN_UNAVAILABLE", `line one\r\nCookie: session=secret; refresh=also-secret\r\n${"x".repeat(400)}`, "2026-08-21T14:01:00.000Z", ACTIVE_LEASE_TOKEN);
  const message = String(fake.rounds.get("G101:260098")?.error_message);
  assert.ok(message.length <= 300);
  assert.doesNotMatch(message, /[\r\n]/u);
  assert.doesNotMatch(message, /secret/u);
  assert.doesNotMatch(message, /refresh/u);

  await store.recordRoundError(roundRef("260099"), "INTERNAL_ERROR", "ignored", "2026-08-21T14:02:00.000Z", ACTIVE_LEASE_TOKEN);
  assert.equal(fake.rounds.get("G101:260099")?.status, "FINAL");
  assert.equal(fake.rounds.get("G101:260099")?.error_code, null);
});

test("local final rematch changes only team identity, status, and last-seen time", async () => {
  const failed = matchRow({
    home_team_id: null, away_team_id: null, home_team_name: null, away_team_name: null,
    betman_home_team: "FC도쿄", betman_away_team: "제프 지바", display_status: "TEAM_MATCH_FAILED",
  });
  const originalSource = {
    home_odds: failed.home_odds,
    betman_home_team: failed.betman_home_team,
    finalized_at: failed.finalized_at,
  };
  const fake = new FakeD1([roundRow({ status: "FINAL", attempt_count: 3 })], [failed]);

  const rematched = await createOddsHistoryStore(asDatabase(fake)).rematchFinalTeamFailures(
    ["G101:260098"],
    "2026-08-21T14:03:00.000Z",
  );

  assert.equal(rematched, 1);
  assert.equal(fake.row("G101:260098:5345")?.display_status, "INCLUDED");
  assert.equal(fake.row("G101:260098:5345")?.home_team_id, 292);
  assert.deepEqual({
    home_odds: fake.row("G101:260098:5345")?.home_odds,
    betman_home_team: fake.row("G101:260098:5345")?.betman_home_team,
    finalized_at: fake.row("G101:260098:5345")?.finalized_at,
  }, originalSource);
  assert.equal(fake.rounds.get("G101:260098")?.attempt_count, 3);
});

test("query binds filters, returns only INCLUDED stable pages, exclusions, archive, and registry teams", async () => {
  const rows = [
    matchRow({ source_key: "G101:260098:2", match_seq: "2", kickoff_at: "2026-08-21T19:30:00+09:00" }),
    matchRow({ source_key: "G101:260099:1", gm_ts: "260099", match_seq: "1", kickoff_at: "2026-08-21T19:30:00+09:00" }),
    matchRow({ source_key: "G101:260097:3", gm_ts: "260097", match_seq: "3", match_date: "2026-08-20", display_status: "CANCELLED" }),
    matchRow({ source_key: "G101:260097:4", gm_ts: "260097", match_seq: "4", match_date: "2026-08-20", display_status: "TEAM_MATCH_FAILED", home_team_id: 292, away_team_id: null }),
    matchRow({ source_key: "G101:260097:5", gm_ts: "260097", match_seq: "5", match_date: "2026-08-20", display_status: "MISSING_ODDS", home_team_id: 292 }),
  ];
  const rounds = [
    roundRow({ status: "PENDING", last_success_at: "2026-08-21T00:00:00.000Z", last_attempt_at: "2026-08-21T00:10:00.000Z" }),
    roundRow({ round_key: "G101:260099", gm_ts: "260099", status: "ERROR", last_success_at: "2026-08-21T00:20:00.000Z" }),
  ];
  const fake = new FakeD1(rounds, rows);
  const query = { league: "J1" as const, team: "J1:292", from: "2026-08-20", to: "2026-08-21", page: 1, pageSize: 30 as const };

  const payload = await createOddsHistoryStore(asDatabase(fake)).query(query, "2026-08-21T00:39:59.000Z");

  assert.deepEqual(payload.records.map(({ sourceKey }) => sourceKey), ["G101:260099:1", "G101:260098:2"]);
  assert.deepEqual(payload.excludedCounts, { cancelled: 1, pendingResult: 0, missingOdds: 1, teamMatchFailed: 0 });
  assert.equal(payload.pagination.total, 2);
  assert.ok(payload.teams.some(({ key }) => key === "J1:292"));
  assert.deepEqual(payload.archive, {
    pendingRounds: 1,
    cooldownPendingRounds: 1,
    errorRounds: 1,
    nextPendingRetryAt: "2026-08-21T00:40:00.000Z",
    lastSuccessfulSyncAt: "2026-08-21T00:20:00.000Z",
  });
  const recordSql = fake.executedStatements.find(({ query: sql }) => sql.includes("odds-history:query-records"))!;
  assert.doesNotMatch(recordSql.query, /2026-08-2/u);
  assert.deepEqual(recordSql.values.slice(0, 6), ["2026-08-20", "2026-08-21", "J1", "J1", 292, 292]);
  assert.match(recordSql.query, /ORDER BY kickoff_at DESC, gm_ts DESC, match_seq DESC/u);
  assert.match(recordSql.query, /LIMIT 30/u);
});

test("an all-league team key scopes the same numeric ID to its league", async () => {
  const fake = new FakeD1([], [
    matchRow({ source_key: "G101:260098:1", match_seq: "1", league_code: "J1", home_team_id: 292 }),
    matchRow({ source_key: "G101:260098:2", match_seq: "2", league_code: "K1", league_name: "K리그1", home_team_id: 292 }),
    matchRow({
      source_key: "G101:260098:3", match_seq: "3", league_code: "K1", league_name: "K리그1",
      home_team_id: 292, display_status: "MISSING_ODDS",
    }),
  ]);
  const query = { league: "all" as const, team: "J1:292", from: "2026-08-20", to: "2026-08-21", page: 1, pageSize: 30 as const };

  const payload = await createOddsHistoryStore(asDatabase(fake)).query(query, "2026-08-21T00:00:00.000Z");

  assert.deepEqual(payload.records.map(({ sourceKey }) => sourceKey), ["G101:260098:1"]);
  assert.equal(payload.excludedCounts.missingOdds, 0);
  const statement = fake.executedStatements.find(({ query: sql }) => sql.includes("odds-history:query-records"))!;
  assert.deepEqual(statement.values.slice(0, 5), ["2026-08-20", "2026-08-21", "J1", 292, 292]);
});

test("a stale owner cannot release a successor lease version", async () => {
  const fake = new FakeD1([roundRow()]);
  const store = createOddsHistoryStore(asDatabase(fake));

  const original = await store.claimCandidates(["G101:260098"], "2026-08-21T00:00:00.000Z", 1);
  assert.equal(original.claimed.length, 1);
  const originalToken = original.claimed[0].leaseToken;
  assert.equal(fake.rounds.get("G101:260098")?.lease_expires_at, "2026-08-21T00:01:00.000Z");

  const immediate = await store.claimCandidates(["G101:260098"], "2026-08-21T00:00:59.000Z", 1);
  assert.equal(immediate.claimed.length, 0);

  const successor = await store.claimCandidates(["G101:260098"], "2026-08-21T00:01:00.000Z", 1);
  assert.equal(successor.claimed.length, 1);
  const successorToken = successor.claimed[0].leaseToken;
  assert.notEqual(successorToken, originalToken);
  assert.equal(fake.rounds.get("G101:260098")?.lease_expires_at, "2026-08-21T00:02:00.000Z");

  await store.releaseLease("G101:260098", originalToken);
  assert.equal(fake.rounds.get("G101:260098")?.lease_expires_at, "2026-08-21T00:02:00.000Z");

  await store.releaseLease("G101:260098", successorToken);
  assert.equal(fake.rounds.get("G101:260098")?.lease_expires_at, null);
  const releases = fake.executedStatements.filter(({ query }) => query.includes("odds-history:release-lease"));
  assert.deepEqual(releases.map(({ values }) => values), [
    ["G101:260098", originalToken],
    ["G101:260098", successorToken],
  ]);
});

test("claim repeats cooldown eligibility atomically and returns an opaque ownership token", async () => {
  const fake = new FakeD1([roundRow({
    status: "PENDING",
    last_success_at: "2026-08-21T00:00:00.000Z",
    last_attempt_at: "2026-08-21T00:00:00.000Z",
  })]);
  fake.beforeNextClaim = () => {
    Object.assign(fake.rounds.get("G101:260098")!, {
      status: "PENDING",
      last_attempt_at: "2026-08-21T00:59:59.000Z",
    });
  };

  const result = await createOddsHistoryStore(asDatabase(fake)).claimCandidates(
    ["G101:260098"],
    "2026-08-21T01:00:00.000Z",
    1,
  );

  assert.equal(result.claimed.length, 0);
  assert.deepEqual(result.busy, []);
  assert.equal(result.deferredPending, 1);
  assert.equal(result.nextPendingRetryAt, "2026-08-21T01:29:59.000Z");
  assert.equal(fake.rounds.get("G101:260098")?.attempt_count, 0);

  fake.rounds.get("G101:260098")!.last_attempt_at = "2026-08-21T00:00:00.000Z";
  const claimed = await createOddsHistoryStore(asDatabase(fake)).claimCandidates(
    ["G101:260098"],
    "2026-08-21T01:00:00.000Z",
    1,
  );
  const owner = claimed.claimed[0] as unknown as { leaseToken?: string };
  assert.match(owner.leaseToken ?? "", /^[0-9a-f-]{36}$/u);
  assert.equal(fake.rounds.get("G101:260098")?.lease_token, owner.leaseToken);
  assert.notEqual(owner.leaseToken, "2026-08-21T01:00:00.000Z");
});

test("stale owners cannot persist, record errors, or release a successor lease", async () => {
  const successorToken = "22222222-2222-4222-8222-222222222222";
  const staleToken = "11111111-1111-4111-8111-111111111111";
  const fake = new FakeD1([roundRow({
    status: "SYNCING",
    lease_expires_at: "2026-08-21T14:02:00.000Z",
    lease_token: successorToken,
  })]);
  const store = createOddsHistoryStore(asDatabase(fake));

  await assert.rejects(
    () => store.persistRound(parsedRound(), "2026-08-21T14:01:00.000Z", staleToken),
    /ROUND_BUSY|lease/iu,
  );
  await store.recordRoundError(
    roundRef(),
    "BETMAN_UNAVAILABLE",
    "stale error",
    "2026-08-21T14:01:00.000Z",
    staleToken,
  );
  await store.releaseLease("G101:260098", staleToken);

  assert.equal(fake.matches.size, 0);
  assert.equal(fake.rounds.get("G101:260098")?.status, "SYNCING");
  assert.equal(fake.rounds.get("G101:260098")?.error_code, null);
  assert.equal(fake.rounds.get("G101:260098")?.lease_token, successorToken);
  assert.equal(fake.rounds.get("G101:260098")?.lease_expires_at, "2026-08-21T14:02:00.000Z");
});

test("row-complete provider-pending rounds finalize unless an omitted non-final row remains", async () => {
  const token = "33333333-3333-4333-8333-333333333333";
  const completeRound = roundRow({ status: "SYNCING", lease_token: token, lease_expires_at: "2026-08-21T14:02:00.000Z" });
  const fake = new FakeD1([completeRound]);
  const store = createOddsHistoryStore(asDatabase(fake));

  const complete = await store.persistRound(
    parsedRound([parsedMatch()], { providerFinal: false }),
    "2026-08-21T14:01:00.000Z",
    token,
  );
  assert.equal(complete.status, "FINAL");

  const pendingToken = "44444444-4444-4444-8444-444444444444";
  const pendingMatch = matchRow({
    source_key: "G101:260099:9999",
    round_key: "G101:260099",
    gm_ts: "260099",
    match_seq: "9999",
    source_final: 0,
    display_status: "PENDING_RESULT",
    finalized_at: null,
  });
  const omittedFake = new FakeD1([
    roundRow({
      round_key: "G101:260099",
      gm_ts: "260099",
      status: "SYNCING",
      lease_token: pendingToken,
      lease_expires_at: "2026-08-21T14:02:00.000Z",
    }),
  ], [pendingMatch]);
  const incoming = parsedMatch({ gmTs: "260099", sourceKey: "G101:260099:5345", roundKey: "G101:260099" });
  const omitted = await createOddsHistoryStore(asDatabase(omittedFake)).persistRound(
    parsedRound([incoming], { round: roundRef("260099"), providerFinal: true }),
    "2026-08-21T14:01:00.000Z",
    pendingToken,
  );
  assert.equal(omitted.status, "PENDING");

  omittedFake.rounds.get("G101:260099")!.status = "SYNCING";
  omittedFake.rounds.get("G101:260099")!.lease_token = pendingToken;
  const empty = await createOddsHistoryStore(asDatabase(omittedFake)).persistRound(
    parsedRound([], { round: roundRef("260099"), providerFinal: true }),
    "2026-08-21T14:01:30.000Z",
    pendingToken,
  );
  assert.equal(empty.status, "PENDING");
});

test("FINAL_CONFLICT metadata records on a finalized round without downgrading it", async () => {
  const token = "55555555-5555-4555-8555-555555555555";
  const fake = new FakeD1([
    roundRow({ status: "FINAL", provider_final: 1, lease_token: token, lease_expires_at: "2026-08-21T14:02:00.000Z" }),
  ], [matchRow()]);

  await assert.rejects(
    () => createOddsHistoryStore(asDatabase(fake)).persistRound(
      parsedRound([parsedMatch({ homeOdds: 9.9 })]),
      "2026-08-21T14:01:00.000Z",
      token,
    ),
    /FINAL_CONFLICT/u,
  );
  assert.equal(fake.rounds.get("G101:260098")?.status, "FINAL");
  assert.equal(fake.rounds.get("G101:260098")?.error_code, "FINAL_CONFLICT");
  assert.equal(fake.row("G101:260098:5345")?.home_odds, 2.1);
});

test("local rematch uses the punctuation-sensitive history resolver", async () => {
  const failed = matchRow({
    home_team_id: null,
    away_team_id: null,
    home_team_name: null,
    away_team_name: null,
    betman_home_team: "F.C. 도쿄",
    betman_away_team: "제프 지바",
    display_status: "TEAM_MATCH_FAILED",
  });
  const fake = new FakeD1([roundRow({ status: "FINAL" })], [failed]);
  const rematched = await createOddsHistoryStore(asDatabase(fake)).rematchFinalTeamFailures(
    ["G101:260098"],
    "2026-08-21T14:03:00.000Z",
  );
  assert.equal(rematched, 0);
  assert.equal(fake.row("G101:260098:5345")?.display_status, "TEAM_MATCH_FAILED");
});

test("bulk registration and rematch reads stay bounded for a legal one-year sweep", async () => {
  const refs = Array.from({ length: 365 }, (_, index) => roundRef(String(300000 + index)));
  const fake = new FakeD1();
  const store = createOddsHistoryStore(asDatabase(fake));
  await store.registerRounds(refs, "2026-08-21T01:00:00.000Z");
  assert.ok((fake.batches[0]?.length ?? Number.POSITIVE_INFINITY) <= 25);

  await store.rematchFinalTeamFailures(refs.map((ref) => `G101:${ref.gmTs}`), "2026-08-21T01:00:00.000Z");
  const reads = fake.executedStatements.filter(({ query }) => query.includes("odds-history:select-rematch"));
  assert.ok(reads.length <= 8);
});

test("history records and metadata are read in one D1 batch snapshot", async () => {
  const fake = new FakeD1();
  await createOddsHistoryStore(asDatabase(fake)).query(
    { league: "all", team: null, from: "2026-08-20", to: "2026-08-21", page: 1, pageSize: 30 },
    "2026-08-21T01:00:00.000Z",
  );
  const queryBatch = fake.batches.find((batch) => batch.some(({ query }) => query.includes("odds-history:query-records")));
  assert.equal(queryBatch?.length, 4);
});
