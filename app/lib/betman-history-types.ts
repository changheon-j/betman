import type { LeagueCode } from "./leagues.ts";

export type RoundStatus = "DISCOVERED" | "SYNCING" | "PENDING" | "FINAL" | "ERROR";
export type HistoryDisplayStatus = "INCLUDED" | "CANCELLED" | "PENDING_RESULT" | "MISSING_ODDS" | "TEAM_MATCH_FAILED";
export type HistoryResult = "H" | "D" | "A";
export type TeamIdentity = { key: `${LeagueCode}:${number}`; leagueCode: LeagueCode; id: number; name: string };
export type HistoryTeamOption = TeamIdentity;
export type HistoryLeagueFilter = "all" | "K1" | "J1";
export type OddsHistoryQuery = { league: HistoryLeagueFilter; team: string | null; from: string; to: string; page: number; pageSize: 30 };
export type SyncProgress = {
  remainingUnresolvedRounds: number;
  deferredPendingRounds: number;
  nextPendingRetryAt: string | null;
  hadPartial: boolean;
};
export type SyncCursorData = {
  version: 1;
  from: string;
  to: string;
  roundKeys: string[];
  nextIndex: number;
  issuedAt: string;
  progress?: SyncProgress;
};
export type SyncInput = { from: string; to: string; cursor: string | null };
export type OddsHistoryErrorCode = "INVALID_DATE" | "INVALID_DATE_RANGE" | "INVALID_LEAGUE" | "INVALID_TEAM" | "INVALID_PAGE" | "INVALID_CURSOR" | "ROUND_BUSY" | "BETMAN_UNAVAILABLE" | "BETMAN_SCHEMA_CHANGED" | "FINAL_CONFLICT" | "DATABASE_UNAVAILABLE" | "INTERNAL_ERROR";
export type ClosedRoundRef = { gmId: "G101"; gmTs: string; sourceUrl: string; announcedAt: string | null };
export type ClaimedClosedRound = ClosedRoundRef & { leaseToken: string };
export type ClosedRoundDocument = { round: ClosedRoundRef; fetchedAt: string; providerFinal: boolean; payload: unknown };
export type ParsedHistoryMatch = {
  sourceKey: string; roundKey: string; gmId: "G101"; gmTs: string; matchSeq: string;
  leagueCode: LeagueCode; leagueName: "K리그1" | "J리그1"; betmanLeagueName: string;
  kickoffAt: string; matchDate: string; homeTeamId: number | null; awayTeamId: number | null;
  homeTeamName: string | null; awayTeamName: string | null; betmanHomeTeam: string; betmanAwayTeam: string;
  homeScore: number | null; awayScore: number | null; result: HistoryResult | null;
  homeOdds: number | null; drawOdds: number | null; awayOdds: number | null;
  displayStatus: HistoryDisplayStatus; sourceFinal: boolean;
};
export type ParsedClosedRound = { round: ClosedRoundRef; fetchedAt: string; providerFinal: boolean; eventFrom: string | null; eventTo: string | null; matches: ParsedHistoryMatch[] };
export type ExcludedCounts = { cancelled: number; pendingResult: number; missingOdds: number; teamMatchFailed: number };
export type OddsHistoryRecord = {
  sourceKey: string; round: string; matchSeq: string; leagueCode: LeagueCode; leagueName: string; kickoffAt: string; date: string;
  homeTeamId: number; awayTeamId: number; homeTeam: string; awayTeam: string; betmanHomeTeam: string; betmanAwayTeam: string;
  score: { home: number; away: number }; result: HistoryResult; odds: { home: number; draw: number; away: number }; finalizedAt: string;
};
export type OddsHistoryPayload = {
  query: OddsHistoryQuery; teams: HistoryTeamOption[]; records: OddsHistoryRecord[];
  pagination: { page: number; pageSize: 30; total: number; totalPages: number };
  excludedCounts: ExcludedCounts;
  archive: { pendingRounds: number; cooldownPendingRounds: number; errorRounds: number; nextPendingRetryAt: string | null; lastSuccessfulSyncAt: string | null };
};
export type SyncRoundError = { code: string; message: string };
export type SyncRoundResult = { gmTs: string; status: RoundStatus; inserted: number; updatedPending: number; preservedFinal: number; excluded: ExcludedCounts; error: SyncRoundError | null };
export type SyncPayload = {
  status: "completed" | "partial"; processedRounds: number; maxRoundsPerRequest: 5; maxParallelDetails: 2;
  rounds: SyncRoundResult[]; hasMore: boolean; nextCursor: string | null; remainingUnresolvedRounds: number;
  deferredPendingRounds: number; nextPendingRetryAt: string | null; startedAt: string; finishedAt: string;
};
export type OddsHistoryError = { error: { code: string; message: string; field: string | null; retryable: boolean } };
