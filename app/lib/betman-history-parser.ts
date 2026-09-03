import type {
  ClosedRoundDocument,
  ClosedRoundRef,
  HistoryDisplayStatus,
  HistoryResult,
  ParsedClosedRound,
  ParsedHistoryMatch,
} from "./betman-history-types.ts";
import { TEAMS_BY_LEAGUE, teamIdentityForAlias } from "./team-aliases.ts";

type Row = Record<string, unknown>;
type RoundState = "FINAL" | "PENDING";

const EXCLUSION_PRIORITY: HistoryDisplayStatus[] = ["CANCELLED", "PENDING_RESULT", "MISSING_ODDS", "TEAM_MATCH_FAILED"];
const REQUIRED_COLUMNS = [
  "itemCode", "leagueName", "gameKind", "marketName", "condition", "matchSeq", "gameDate",
  "homeName", "awayName", "resultStatus", "homeScore", "awayScore", "result", "options",
] as const;
const LIVE_REQUIRED_COLUMNS = [
  "itemCode", "leagueName", "matchSeq", "gameDate", "homeName", "awayName",
  "winTxt", "winAllot", "drawTxt", "drawAllot", "loseTxt", "loseAllot",
  "handi", "protoStatus", "gameResult", "mchScore", "betTypId", "betTypNm", "betId", "betNm", "prlYn",
] as const;
const K1_ALIASES = new Set(["K1", "K리그1", "K League 1", "K LEAGUE 1", "한국 K리그1"]);
const J1_ALIASES = new Set(["J1", "J1 League", "J리그1", "일본 J1리그"]);
const CANCELLED_STATES = new Set(["CANCELLED", "CANCELED", "VOID", "SPECIAL", "취소", "무효", "적중특례"]);
const COMPLETED_STATES = new Set(["COMPLETED", "FINAL", "CLOSED", "CONFIRMED", "완료", "종료", "확정", "정상완료"]);
const PENDING_STATES = new Set(["PENDING", "OPEN", "SCHEDULED", "미확정", "진행중"]);

export class BetmanHistorySchemaError extends Error {
  readonly code = "BETMAN_SCHEMA_CHANGED" as const;

  constructor(message: string) {
    super(`BETMAN_SCHEMA_CHANGED: ${message}`);
    this.name = "BetmanHistorySchemaError";
  }
}

export function canonicalHistoryLeague(raw: string): "K1" | "J1" | null {
  const normalized = text(raw);
  if (K1_ALIASES.has(normalized)) return "K1";
  if (J1_ALIASES.has(normalized)) return "J1";
  return null;
}

export function parseClosedRoundDocument(
  document: ClosedRoundDocument,
  resolveTeam: typeof teamIdentityForAlias = strictHistoryTeamIdentityForAlias,
): ParsedClosedRound {
  validateDocumentEnvelope(document);
  const rows = expandAndValidateRows(document.payload, document.round);
  assertAllRowMatchSequences(rows);
  const matches = rows.flatMap((row) => {
    const leagueCode = canonicalHistoryLeague(text(row.leagueName));
    if (!isFootball(row) || !leagueCode) return [];
    if (!isNormalMatchWinner(row)) return [];
    const candidate = parseCandidate(normalizeProviderRow(row), document, resolveTeam);
    validateNoResultConflict(candidate);
    return [candidate];
  });
  assertUniqueMatchSequences(matches);
  return {
    round: document.round,
    fetchedAt: document.fetchedAt,
    providerFinal: document.providerFinal,
    ...eventBounds(matches),
    matches,
  };
}

function validateDocumentEnvelope(document: ClosedRoundDocument) {
  if (!document || typeof document !== "object" || !document.round || document.round.gmId !== "G101" || !/^\d+$/.test(document.round.gmTs)) {
    schema("invalid requested round");
  }
  if (!isCanonicalIsoInstant(document.fetchedAt)) schema("invalid fetchedAt");
  if (!isNormalizedBetmanSourceUrl(document.round.sourceUrl)) schema("invalid sourceUrl");
  if (document.round.announcedAt !== null && !isCanonicalIsoInstant(document.round.announcedAt)) schema("invalid announcedAt");
  if (typeof document.providerFinal !== "boolean") schema("ambiguous provider final state");
  if (!isRecord(document.payload)) schema("payload must be an object");
  const payload = document.payload;
  if ((payload.gmId !== undefined && text(payload.gmId) !== document.round.gmId) || text(payload.gmTs) !== document.round.gmTs) {
    schema("payload round does not match requested round");
  }
  if (payload.roundStatus !== undefined) {
    const state = roundState(payload.roundStatus);
    if (!state || document.providerFinal !== (state === "FINAL")) schema("ambiguous official round state");
  } else if (!isRecord(payload.compSchedules) || !Array.isArray(payload.compSchedules.keys) || !payload.compSchedules.keys.includes("protoStatus")) {
    schema("ambiguous official round state");
  }
}

function expandAndValidateRows(payload: unknown, round: ClosedRoundRef): Row[] {
  if (!isRecord(payload) || (payload.gmId !== undefined && text(payload.gmId) !== round.gmId) || text(payload.gmTs) !== round.gmTs) {
    schema("payload round does not match requested round");
  }
  const schedules = payload.compSchedules;
  if (!isRecord(schedules) || !Array.isArray(schedules.keys) || !Array.isArray(schedules.datas)) {
    schema("missing keys or datas");
  }
  const { keys, datas } = schedules;
  if (datas.length === 0) {
    if (payload.zeroGames === true && keys.length === 0) return [];
    schema("unmarked empty round payload");
  }
  if (payload.zeroGames === true) schema("zero-game marker conflicts with rows");
  if (keys.length === 0 || keys.some((key) => typeof key !== "string" || text(key) === "") || new Set(keys).size !== keys.length) {
    schema("invalid key definition");
  }
  const requiredColumns = keys.includes("protoStatus") ? LIVE_REQUIRED_COLUMNS : REQUIRED_COLUMNS;
  for (const required of requiredColumns) {
    if (!keys.includes(required)) schema(`missing required column ${required}`);
  }
  return datas.map((data) => {
    if (!Array.isArray(data) || data.length !== keys.length) schema("keys and row data do not align");
    return Object.fromEntries(keys.map((key, index) => [key, data[index]]));
  });
}

function isNormalMatchWinner(row: Row): boolean {
  if (row.betTypId !== undefined || row.protoStatus !== undefined) {
    return text(row.betTypId) === "1"
      && text(row.betTypNm) === "승무패"
      && text(row.betId) === "1"
      && text(row.betNm) === "축구 승무패"
      && Number(text(row.handi)) === 0
      && text(row.prlYn).toUpperCase() === "N";
  }
  return text(row.gameKind) === "일반" && text(row.marketName) === "축구 승무패" && text(row.condition) === "-";
}

function normalizeProviderRow(row: Row): Row {
  if (row.protoStatus === undefined) return row;
  const scoreParts = /^(\d+)\s*:\s*(\d+)$/u.exec(text(row.mchScore));
  const rejected = [row.gameReject, row.buyReject].some((value) => text(value) !== "" && text(value) !== "0");
  const resultStatus = rejected ? "CANCELLED" : text(row.protoStatus) === "4" ? "COMPLETED" : "PENDING";
  const resultByCode: Record<string, HistoryResult> = { "0": "H", "1": "D", "2": "A" };
  return {
    ...row,
    resultStatus,
    homeScore: scoreParts?.[1] ?? "",
    awayScore: scoreParts?.[2] ?? "",
    result: resultByCode[text(row.gameResult)] ?? "",
    options: [
      { label: text(row.winTxt), odds: row.winAllot },
      { label: text(row.drawTxt), odds: row.drawAllot },
      { label: text(row.loseTxt), odds: row.loseAllot },
    ],
  };
}

function isFootball(row: Row): boolean {
  const code = text(row.itemCode);
  if (code) return code === "SC";
  return text(row.itemName) === "축구" || text(row.sportName) === "축구";
}

function text(value: unknown): string {
  return (typeof value === "string" || typeof value === "number")
    ? String(value).normalize("NFC").trim().replace(/\s+/gu, " ")
    : "";
}

function rawText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function parseCandidate(
  row: Row,
  document: ClosedRoundDocument,
  resolveTeam: typeof teamIdentityForAlias,
): ParsedHistoryMatch {
  const leagueCode = canonicalHistoryLeague(text(row.leagueName));
  if (!leagueCode) schema("candidate has unsupported league");
  const matchSeq = text(row.matchSeq);
  const kickoff = parseKoreanKickoff(row.gameDate);
  const betmanLeagueName = rawText(row.leagueName);
  const betmanHomeTeam = rawText(row.homeName);
  const betmanAwayTeam = rawText(row.awayName);
  const state = matchState(row.resultStatus);
  if (!state) schema("ambiguous official match state");

  const homeScore = score(row.homeScore);
  const awayScore = score(row.awayScore);
  const result = historyResult(row.result);
  const odds = parseOdds(row.options);
  const homeTeam = resolveTeam(leagueCode, text(row.homeName));
  const awayTeam = resolveTeam(leagueCode, text(row.awayName));
  const completedResult = state === "COMPLETED" && homeScore !== null && awayScore !== null && result !== null;

  const displayStatus = EXCLUSION_PRIORITY.find((status) =>
    (status === "CANCELLED" && state === "CANCELLED")
    || (status === "PENDING_RESULT" && !completedResult)
    || (status === "MISSING_ODDS" && !odds.complete)
    || (status === "TEAM_MATCH_FAILED" && (!homeTeam || !awayTeam)),
  ) ?? "INCLUDED";

  return {
    sourceKey: `${document.round.gmId}:${document.round.gmTs}:${matchSeq}`,
    roundKey: `${document.round.gmId}:${document.round.gmTs}`,
    gmId: document.round.gmId,
    gmTs: document.round.gmTs,
    matchSeq,
    leagueCode,
    leagueName: leagueCode === "K1" ? "K리그1" : "J리그1",
    betmanLeagueName,
    kickoffAt: kickoff.kickoffAt,
    matchDate: kickoff.matchDate,
    homeTeamId: homeTeam?.id ?? null,
    awayTeamId: awayTeam?.id ?? null,
    homeTeamName: homeTeam?.name ?? null,
    awayTeamName: awayTeam?.name ?? null,
    betmanHomeTeam,
    betmanAwayTeam,
    homeScore,
    awayScore,
    result,
    homeOdds: odds.home,
    drawOdds: odds.draw,
    awayOdds: odds.away,
    displayStatus,
    sourceFinal: sourceFinalFor(displayStatus, state, document.providerFinal),
  };
}

function sourceFinalFor(
  displayStatus: HistoryDisplayStatus,
  state: "CANCELLED" | "COMPLETED" | "PENDING",
  providerFinal: boolean,
): boolean {
  if (displayStatus === "PENDING_RESULT") return false;
  if (displayStatus === "INCLUDED" || displayStatus === "TEAM_MATCH_FAILED" || displayStatus === "CANCELLED") return true;
  return displayStatus === "MISSING_ODDS" && state === "COMPLETED" && providerFinal;
}

function validateNoResultConflict(candidate: ParsedHistoryMatch): void {
  if (candidate.homeScore === null || candidate.awayScore === null || candidate.result === null) return;
  const derived: HistoryResult = candidate.homeScore > candidate.awayScore ? "H" : candidate.homeScore < candidate.awayScore ? "A" : "D";
  if (candidate.result !== derived) schema(`score/result conflict for match ${candidate.matchSeq}`);
}

function assertUniqueMatchSequences(matches: ParsedHistoryMatch[]): void {
  const seen = new Set<string>();
  for (const match of matches) {
    if (!/^\d+$/.test(match.matchSeq) || seen.has(match.matchSeq)) schema("missing, non-numeric, or duplicate matchSeq");
    seen.add(match.matchSeq);
  }
}

function assertAllRowMatchSequences(rows: Row[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const matchSeq = text(row.matchSeq);
    if (!/^\d+$/.test(matchSeq) || seen.has(matchSeq)) schema("missing, non-numeric, or duplicate matchSeq");
    seen.add(matchSeq);
  }
}

function eventBounds(matches: ParsedHistoryMatch[]): { eventFrom: string | null; eventTo: string | null } {
  if (matches.length === 0) return { eventFrom: null, eventTo: null };
  const dates = matches.map((match) => match.matchDate).sort();
  return { eventFrom: dates[0], eventTo: dates[dates.length - 1] };
}

function roundState(value: unknown): RoundState | null {
  const state = text(value).toUpperCase();
  if (["FINAL", "CLOSED", "COMPLETED", "확정", "마감"].includes(state)) return "FINAL";
  if (["PENDING", "OPEN", "미확정", "진행중"].includes(state)) return "PENDING";
  return null;
}

function matchState(value: unknown): "CANCELLED" | "COMPLETED" | "PENDING" | null {
  const state = text(value).toUpperCase();
  if (CANCELLED_STATES.has(state)) return "CANCELLED";
  if (COMPLETED_STATES.has(state)) return "COMPLETED";
  if (PENDING_STATES.has(state)) return "PENDING";
  return null;
}

function score(value: unknown): number | null {
  const valueText = text(value);
  return /^\d+$/.test(valueText) && Number.isSafeInteger(Number(valueText)) ? Number(valueText) : null;
}

function historyResult(value: unknown): HistoryResult | null {
  const valueText = text(value).toUpperCase();
  if (["H", "홈승", "승"].includes(valueText)) return "H";
  if (["D", "무", "무승부"].includes(valueText)) return "D";
  if (["A", "원정승", "패"].includes(valueText)) return "A";
  return null;
}

function parseOdds(value: unknown): { home: number | null; draw: number | null; away: number | null; complete: boolean } {
  const values: Record<"승" | "무" | "패", number[]> = { 승: [], 무: [], 패: [] };
  const labels: Record<"승" | "무" | "패", number> = { 승: 0, 무: 0, 패: 0 };
  if (Array.isArray(value)) {
    for (const option of value) {
      if (!isRecord(option)) continue;
      const label = text(option.label);
      if (label !== "승" && label !== "무" && label !== "패") continue;
      labels[label] += 1;
      const decimal = decimalOdds(option.odds);
      if (decimal !== null) values[label].push(decimal);
    }
  }
  for (const label of ["승", "무", "패"] as const) {
    if (values[label].length > 1 && new Set(values[label]).size > 1) schema(`conflicting duplicate odds for ${label}`);
  }
  const [home] = values.승;
  const [draw] = values.무;
  const [away] = values.패;
  return {
    home: home ?? null,
    draw: draw ?? null,
    away: away ?? null,
    complete: labels.승 === 1 && labels.무 === 1 && labels.패 === 1 && values.승.length === 1 && values.무.length === 1 && values.패.length === 1,
  };
}

function decimalOdds(value: unknown): number | null {
  const source = typeof value === "string" || typeof value === "number" ? text(value) : "";
  if (!/^\d+(?:\.\d+)?$/.test(source)) return null;
  const parsed = Number(source);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseKoreanKickoff(value: unknown): { kickoffAt: string; matchDate: string } {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) schema("invalid epoch kickoff");
    const korean = new Date(value + 9 * 60 * 60 * 1000);
    const year = String(korean.getUTCFullYear()).padStart(4, "0");
    const month = String(korean.getUTCMonth() + 1).padStart(2, "0");
    const day = String(korean.getUTCDate()).padStart(2, "0");
    const hour = String(korean.getUTCHours()).padStart(2, "0");
    const minute = String(korean.getUTCMinutes()).padStart(2, "0");
    const seconds = String(korean.getUTCSeconds()).padStart(2, "0");
    const matchDate = `${year}-${month}-${day}`;
    return { matchDate, kickoffAt: `${matchDate}T${hour}:${minute}:${seconds}+09:00` };
  }
  const source = text(value);
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(?:(\d{2}))?$/.exec(source);
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,3})?\+09:00$/.exec(source);
  const parts = compact ?? iso;
  if (!parts) schema("invalid Korean-offset kickoff");
  const [, year, month, day, hour, minute, seconds = "00"] = parts;
  if (!isValidDateTime(year, month, day, hour, minute, seconds)) schema("invalid Korean-offset kickoff");
  const matchDate = `${year}-${month}-${day}`;
  return { matchDate, kickoffAt: `${matchDate}T${hour}:${minute}:${seconds}+09:00` };
}

function isValidDateTime(year: string, month: string, day: string, hour: string, minute: string, seconds: string) {
  const values = [year, month, day, hour, minute, seconds].map(Number);
  const [numericYear, numericMonth, numericDay, numericHour, numericMinute, numericSecond] = values;
  if (numericHour > 23 || numericMinute > 59 || numericSecond > 59) return false;
  const date = new Date(Date.UTC(numericYear, numericMonth - 1, numericDay, numericHour, numericMinute, numericSecond));
  return date.getUTCFullYear() === numericYear && date.getUTCMonth() === numericMonth - 1 && date.getUTCDate() === numericDay;
}

function isRecord(value: unknown): value is Row {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isNormalizedBetmanSourceUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.href === value
      && parsed.protocol === "https:"
      && parsed.hostname === "www.betman.co.kr"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.hash === "";
  } catch {
    return false;
  }
}

export const strictHistoryTeamIdentityForAlias: typeof teamIdentityForAlias = (league, raw) => {
  const normalized = text(raw);
  const team = TEAMS_BY_LEAGUE[league].find((candidate) => candidate.aliases.some((alias) => text(alias) === normalized));
  return team ? { key: `${league}:${team.id}`, leagueCode: league, id: team.id, name: team.name } : null;
};

function schema(message: string): never {
  throw new BetmanHistorySchemaError(message);
}
