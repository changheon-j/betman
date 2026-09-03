# Betman Odds History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `배당기록` sample table with a D1-first archive of finalized K1/J1 Betman G101 match-winner results and odds, with bounded background synchronization.

**Architecture:** Keep the existing current-round `/api/betman-odds` path untouched. Add a strict anonymous closed-round adapter, parser, immutable D1 store, separate GET/sync routes, and a client component that renders stored data before walking a cursor-based sync sweep and re-reading D1.

**Tech Stack:** Node.js >=22.13.0, TypeScript 5.9.3 strict mode, React 19.2.6, Next.js 16.2.6 App Router on Vinext 0.0.50/Vite 8.0.13, Cloudflare Workers and D1, Drizzle ORM 0.45.2/Kit 0.31.10, Node test runner through `tsx` 4.23.12.

**Spec:** `docs/superpowers/specs/2026-08-21-betman-odds-history-design.md`

## Global Constraints

- Support only Betman `G101`, K리그1=`K1`, 일본 J1리그=`J1`, game kind `일반`, market `축구 승무패`, and precondition `-`.
- Use only anonymous requests to the fixed `https://www.betman.co.kr` origin; never accept a client-supplied source URL or persist/log cookies or complete provider bodies.
- Apply a 15-second total timeout and 3 MiB body limit to every Betman response; do not retry within one sync request.
- Query dates are inclusive Gregorian `YYYY-MM-DD`; default to the Korean-calendar date today and three calendar months earlier; reject reversed ranges and ranges beyond one calendar year.
- Return only finalized normal matches, newest first, with a fixed page size of 30; report `CANCELLED`, `PENDING_RESULT`, `MISSING_ODDS`, and `TEAM_MATCH_FAILED` separately.
- Match teams only through explicit league-scoped aliases; no fuzzy, partial-string, edit-distance, or AI matching.
- Store canonical team ID/name and untouched Betman team text together.
- One sync request may fetch at most five round details with at most two detail requests in flight; continuation uses `hasMore` and `nextCursor`.
- `PENDING` is network-eligible only at `max(last_success_at, last_attempt_at) + 30 minutes`; a cooldown skip changes neither timestamp nor attempt count.
- `FINAL` rounds and finalized source rows are immutable and are never fetched, deleted, or overwritten because of errors, empty responses, conflicts, range changes, or later sweeps.
- Keep `/api/betman-odds`, `/api/fixtures`, standings, H2H, Predictions, pre-match odds, and `/api/market-predictions` contracts backward compatible.
- Add no scheduler, Queue, Cron, authenticated Betman flow, purchase operation, dependency, or admin mutation UI.
- Tests must not log or commit live cookies or unredacted Betman response bodies.

---

## File Map

### Create

- `app/lib/betman-history-types.ts` — source, parser, persistence, API, and sync boundary types shared without importing routes.
- `app/lib/odds-history-contract.ts` — date/filter/team/cursor parsing, error envelope creation, and API query serialization.
- `tests/odds-history-contract.test.ts` — calendar, team, query, error, and cursor unit tests.
- `drizzle/0004_betman_odds_history.sql` — two D1 tables, checks, foreign key, unique constraints, and query indexes.
- `drizzle/meta/0004_snapshot.json` — generated Drizzle schema snapshot.
- `tests/odds-history-schema.test.ts` — migration/schema parity and immutable-path guard tests.
- `app/lib/betman-history-parser.ts` — strict closed-round document parser and exclusion classification.
- `tests/betman-history-parser.test.ts` — strict-market, result, odds, team, empty, and conflict parser tests.
- `tests/fixtures/betman-history/closed-round-list.html` — redacted anonymous G101 round-index fixture.
- `tests/fixtures/betman-history/closed-round-final.json` — redacted final K1/J1 round fixture.
- `tests/fixtures/betman-history/closed-round-pending.json` — redacted pending/exclusion round fixture.
- `app/lib/betman-history-adapter.ts` — fixed-origin anonymous session, discovery/detail requests, limits, and concurrency helper.
- `tests/betman-history-adapter.test.ts` — cookie, host, timeout, size, discovery, and concurrency tests.
- `scripts/betman-history-smoke.ts` — one-round read-only live smoke command that prints metadata only.
- `app/lib/odds-history-store.ts` — D1 queries, round claims, immutable upserts, cooldown calculations, and rematching.
- `tests/odds-history-store.test.ts` — fake-D1 store behavior and SQL mutation guard tests.
- `app/api/odds-history/route.ts` — D1-only GET route.
- `tests/odds-history-route.test.ts` — dependency-injected GET route tests.
- `app/lib/odds-history-sync.ts` — cursor sweep orchestration and two-worker detail pool.
- `app/api/odds-history/sync/route.ts` — POST sync route and error/status mapping.
- `tests/odds-history-sync.test.ts` — orchestration and POST route tests.
- `app/lib/odds-history-client.ts` — browser-safe stored-first refresh sequence and generation guard.
- `tests/odds-history-client.test.ts` — GET/POST/GET order, stale response, abort, cursor, and page-only tests.
- `app/odds-history.tsx` — filter, state, table, exclusions, pagination, and sync status UI.
- `tests/odds-history-view.test.ts` — server-rendered component structure and pure view helper tests.

### Modify

- `app/lib/team-aliases.ts` — expose canonical league-scoped team definitions while retaining exact alias lookup.
- `tests/betman-matcher.test.ts` — update alias-builder fixtures and protect the current-round matcher contract.
- `db/schema.ts` — add Drizzle declarations matching the history migration.
- `drizzle/meta/_journal.json` — register migration `0004_betman_odds_history`.
- `package.json` — add the explicit read-only `test:betman-history-smoke` command; retain all existing scripts.
- `app/page.tsx` — remove sample odds state/data/markup and mount `OddsHistory`; update header source copy only.
- `app/globals.css` — style league filter/column, status, exclusions, pagination, raw-name text, errors, and responsive layout.
- `tests/rendered-html.test.mjs` — assert archive loading/source copy and absence of sample/demo copy.
- `harness/src/suites/contracts.mjs` — validate `GET /api/odds-history` without invoking sync.
- `harness/src/suites/smoke.mjs` — add the read-only history GET.
- `README.md` — describe the real archive, filters, endpoints, and cache/sync bounds.
- `docs/PRODUCT.md` — replace the sample archive description with the stored-first user flow.
- `docs/ARCHITECTURE.md` — add adapter/parser/store/routes and immutable/cooldown state flow.
- `docs/DATA-SOURCES.md` — document the Betman closed-game source, strict market, and anonymous limits.
- `docs/OPERATIONS.md` — add D1 migration, live smoke, cooldown, and failure diagnostics.
- `docs/ROADMAP.md` — mark the real Betman archive delivered without adding follow-on scope.

## Spec Coverage Matrix

| Design section | Implemented and verified by |
|---|---|
| 1. Purpose | Tasks 6–9 stored-first GET/sync/GET flow and real archive UI |
| 2. Scope and non-goals | Global Constraints; Tasks 3, 4, 7, 9 regression checks |
| 3. Selected architecture | Tasks 3–9 preserve adapter/parser/store/API/UI boundaries |
| 4. Source adapter | Task 4 fixtures, limits, fixed origin, anonymous session, live smoke |
| 5. Strict parsing and matching | Tasks 1 and 3 exact aliases, market selection, result/odds rules, exclusions |
| 6. D1 model and immutability | Tasks 2 and 5 schema, claim, cooldown, atomic immutable upsert |
| 7. GET contract | Tasks 1, 5, and 6 validation, query, pagination, teams, archive metadata |
| 8. Sync contract | Tasks 4, 5, and 7 cursor, five/two limits, partial results, cooldown |
| 9. Errors | Tasks 1, 4, 6, 7, and 9 stable envelopes, redaction, retained UI data |
| 10. UI | Tasks 8 and 9 filters, stale blocking, statuses, table, exclusions, pagination |
| 11. Module boundaries | File Map and Tasks 1–9 exact files/interfaces |
| 12. Tests | Every task's red/green cycle; Task 10 full regression and live smoke |
| 13. Completion criteria | Task 10 complete verification gate |
| 14. Operations | Task 10 harness, docs, metrics, error diagnostics |

### Task 1: Shared contracts, dates, cursor, and canonical teams

**Files:**
- Create: `app/lib/betman-history-types.ts`
- Create: `app/lib/odds-history-contract.ts`
- Create: `tests/odds-history-contract.test.ts`
- Modify: `app/lib/team-aliases.ts`
- Modify: `tests/betman-matcher.test.ts`

**Interfaces:**
- Consumes: `LeagueCode` and `SUPPORTED_LEAGUES` from `app/lib/leagues.ts`; the existing `teamIdForAlias(league: LeagueCode, value: string): number | null` contract.
- Produces: `TeamIdentity`, `HistoryTeamOption`, `ClosedRoundRef`, `ClosedRoundDocument`, `ParsedHistoryMatch`, `ParsedClosedRound`, `OddsHistoryQuery`, `OddsHistoryPayload`, `SyncCursorData`, `SyncPayload`, `OddsHistoryError`; `teamsForLeague(league: "all" | LeagueCode): HistoryTeamOption[]`; `teamIdentityForAlias(league: LeagueCode, raw: string): TeamIdentity | null`; `parseOddsHistoryQuery(url: URL, now?: Date): OddsHistoryQuery`; `parseSyncBody(value: unknown, now?: Date): { from: string; to: string; cursor: string | null }`; `encodeSyncCursor(data: SyncCursorData): string`; `decodeSyncCursor(value, expectedRange, discoveredRoundKeys, now?): SyncCursorData`; `historyQueryString(query): string`.

- [ ] **Step 1: Write the failing contract and canonical-team tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSyncCursor, defaultHistoryRange, encodeSyncCursor,
  parseOddsHistoryQuery, parseSyncBody,
} from "../app/lib/odds-history-contract.ts";
import { teamIdentityForAlias, teamsForLeague } from "../app/lib/team-aliases.ts";

test("three-month defaults clamp month ends in Asia/Seoul", () => {
  assert.deepEqual(defaultHistoryRange(new Date("2024-05-31T03:00:00Z")), { from: "2024-02-29", to: "2024-05-31" });
});

test("query rejects impossible, reversed, and over-one-year ranges", () => {
  for (const url of [
    "http://local/api/odds-history?from=2026-02-30&to=2026-03-01",
    "http://local/api/odds-history?from=2026-08-22&to=2026-08-21",
    "http://local/api/odds-history?from=2025-08-20&to=2026-08-21",
  ]) assert.throws(() => parseOddsHistoryQuery(new URL(url)), /INVALID_DATE|INVALID_DATE_RANGE/);
});

test("team keys remain league scoped", () => {
  assert.equal(teamIdentityForAlias("J1", "FC도쿄")?.key, "J1:292");
  assert.equal(teamIdentityForAlias("J1", "가시마 시"), null);
  assert.ok(teamsForLeague("K1").every((team) => team.leagueCode === "K1"));
});

test("cursor binds structure, range, expiry, and discovered round order", () => {
  const now = new Date("2026-08-21T00:00:00Z");
  const cursor = encodeSyncCursor({ version: 1, from: "2026-05-21", to: "2026-08-21", roundKeys: ["G101:2", "G101:1"], nextIndex: 1, issuedAt: now.toISOString() });
  assert.equal(decodeSyncCursor(cursor, { from: "2026-05-21", to: "2026-08-21" }, ["G101:2", "G101:1"], now).nextIndex, 1);
  assert.throws(() => decodeSyncCursor(cursor, { from: "2026-05-20", to: "2026-08-21" }, ["G101:2", "G101:1"], now), /INVALID_CURSOR/);
  assert.throws(() => decodeSyncCursor(cursor, { from: "2026-05-21", to: "2026-08-21" }, ["G101:1"], now), /INVALID_CURSOR/);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npx.cmd tsx --test tests/odds-history-contract.test.ts tests/betman-matcher.test.ts`

Expected: FAIL because `odds-history-contract.ts`, the shared types, and canonical team exports do not exist.

- [ ] **Step 3: Write the minimal shared types and validators**

```ts
// app/lib/betman-history-types.ts
import type { LeagueCode } from "./leagues.ts";

export type RoundStatus = "DISCOVERED" | "SYNCING" | "PENDING" | "FINAL" | "ERROR";
export type HistoryDisplayStatus = "INCLUDED" | "CANCELLED" | "PENDING_RESULT" | "MISSING_ODDS" | "TEAM_MATCH_FAILED";
export type HistoryResult = "H" | "D" | "A";
export type TeamIdentity = { key: `${LeagueCode}:${number}`; leagueCode: LeagueCode; id: number; name: string };
export type HistoryTeamOption = TeamIdentity;
export type HistoryLeagueFilter = "all" | "K1" | "J1";
export type OddsHistoryQuery = { league: HistoryLeagueFilter; team: string | null; from: string; to: string; page: number; pageSize: 30 };
export type SyncCursorData = { version: 1; from: string; to: string; roundKeys: string[]; nextIndex: number; issuedAt: string };
export type SyncInput = { from: string; to: string; cursor: string | null };
export type OddsHistoryErrorCode = "INVALID_DATE" | "INVALID_DATE_RANGE" | "INVALID_LEAGUE" | "INVALID_TEAM" | "INVALID_PAGE" | "INVALID_CURSOR" | "ROUND_BUSY" | "BETMAN_UNAVAILABLE" | "BETMAN_SCHEMA_CHANGED" | "FINAL_CONFLICT" | "DATABASE_UNAVAILABLE" | "INTERNAL_ERROR";
export type ClosedRoundRef = { gmId: "G101"; gmTs: string; sourceUrl: string; announcedAt: string | null };
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
```

```ts
// app/lib/odds-history-contract.ts — public surface and exact constants
import type { HistoryLeagueFilter, OddsHistoryErrorCode, OddsHistoryQuery, SyncCursorData, SyncInput } from "./betman-history-types.ts";
export type { HistoryLeagueFilter, OddsHistoryErrorCode, OddsHistoryQuery, SyncCursorData, SyncInput } from "./betman-history-types.ts";

export const HISTORY_PAGE_SIZE = 30 as const;
export const CURSOR_TTL_MS = 30 * 60 * 1000;
export const MAX_CURSOR_BYTES = 8 * 1024;

export class OddsHistoryValidationError extends Error {
  constructor(readonly code: OddsHistoryErrorCode, message: string, readonly field: string | null = null, readonly retryable = false) { super(message); }
}

export function oddsHistoryErrorResponse(error: unknown, status: number) {
  const known = error instanceof OddsHistoryValidationError ? error : new OddsHistoryValidationError("INTERNAL_ERROR", "요청을 처리하지 못했습니다.");
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

export function parseSyncBody(value: unknown, now = new Date()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validation("INVALID_DATE", "요청 본문이 올바르지 않습니다.");
  const body = value as Record<string, unknown>;
  const range = parseRange(asOptionalString(body.from), asOptionalString(body.to), now);
  const cursor = body.cursor === undefined || body.cursor === null ? null : requireString(body.cursor, "INVALID_CURSOR");
  return { ...range, cursor };
}

export function encodeSyncCursor(data: SyncCursorData) {
  return base64UrlEncode(JSON.stringify(data));
}

export function decodeSyncCursor(value: string, range: { from: string; to: string }, discovered: string[], now = new Date()) {
  if (new TextEncoder().encode(value).byteLength > MAX_CURSOR_BYTES) throw validation("INVALID_CURSOR", "동기화 cursor가 올바르지 않습니다.");
  const parsed = JSON.parse(base64UrlDecode(value)) as SyncCursorData;
  const orderedSubset = parsed.roundKeys.every((key, index) => /^G101:\d+$/.test(key) && discovered.indexOf(key) > discovered.indexOf(parsed.roundKeys[index - 1] ?? ""));
  if (parsed.version !== 1 || parsed.from !== range.from || parsed.to !== range.to || !orderedSubset || !Number.isSafeInteger(parsed.nextIndex) || parsed.nextIndex < 0 || parsed.nextIndex > parsed.roundKeys.length || now.getTime() - Date.parse(parsed.issuedAt) > CURSOR_TTL_MS) {
    throw validation("INVALID_CURSOR", "동기화 cursor가 올바르지 않습니다.");
  }
  return parsed;
}

export function historyQueryString(query: OddsHistoryQuery) {
  const params = new URLSearchParams({ league: query.league, from: query.from, to: query.to, page: String(query.page) });
  if (query.team) params.set("team", query.team);
  return params.toString();
}
```

Private helpers in the same file are `koreanDate(Date): string`, `shiftCalendarMonths(string, number): string`, `shiftCalendarYears(string, number): string`, `parseRange(string|null, string|null, Date)`, `parseLeague(string)`, `parseTeamKey(string|null, HistoryLeagueFilter)`, `parsePositiveSafeInteger(string, string, ErrorCode)`, `base64UrlEncode(string)`, and `base64UrlDecode(string)`. `parseRange` round-trips year/month/day through UTC to reject impossible dates, requires both explicit dates or neither, compares `to` against the clamped one-year anniversary of `from`, and returns the default range only when both values are absent. `decodeSyncCursor` catches JSON/base64/date errors and converts all of them to `INVALID_CURSOR`; the ordered-subset check walks `discovered` with a monotonically increasing index rather than accepting `-1`.

Replace tuple aliases with exported `TeamDefinition` objects while preserving normalization and `teamIdForAlias`. Use these exact IDs and canonical names; copy each current alias array unchanged into the matching object:

```ts
export type TeamDefinition = { id: number; name: string; aliases: readonly string[] };
export const TEAMS_BY_LEAGUE: Record<LeagueCode, readonly TeamDefinition[]> = {
  K1: [
    { id: 2759, name: "광주 FC", aliases: ["광주", "광주 FC", "Gwangju FC"] },
    { id: 2764, name: "포항 스틸러스", aliases: ["포항", "포항 스틸러스", "Pohang Steelers"] },
    { id: 2761, name: "제주 SK", aliases: ["제주", "제주 SK", "제주 유나이티드", "Jeju United FC"] },
    { id: 2766, name: "FC 서울", aliases: ["서울", "FC 서울", "서울 FC", "FC Seoul"] },
    { id: 2750, name: "대전 하나", aliases: ["대전", "대전 하나", "Daejeon Citizen"] },
    { id: 2762, name: "전북 현대", aliases: ["전북", "전북 현대", "Jeonbuk Motors"] },
    { id: 2767, name: "울산 HD", aliases: ["울산", "울산 HD", "Ulsan Hyundai FC"] },
    { id: 2746, name: "강원 FC", aliases: ["강원", "강원 FC", "Gangwon FC"] },
    { id: 2748, name: "FC 안양", aliases: ["안양", "FC 안양", "안양 FC", "FC Anyang"] },
    { id: 2745, name: "부천 FC", aliases: ["부천", "부천 FC", "Bucheon FC 1995"] },
    { id: 2763, name: "인천 유나이티드", aliases: ["인천", "인천 유나이티드", "Incheon United"] },
    { id: 2768, name: "김천 상무", aliases: ["김천", "김천 상무", "Gimcheon Sangmu FC"] },
    { id: 2747, name: "대구 FC", aliases: ["대구", "대구 FC", "Daegu FC"] },
    { id: 2756, name: "수원 FC", aliases: ["수원", "수원 FC", "Suwon City FC"] },
    { id: 2765, name: "수원 삼성", aliases: ["수원 삼성", "Suwon Bluewings"] },
  ],
  J1: [
    { id: 316, name: "아비스파 후쿠오카", aliases: ["아비스파 후쿠오카", "Avispa Fukuoka"] },
    { id: 291, name: "세레소 오사카", aliases: ["세레소 오사카", "Cerezo Osaka"] },
    { id: 310, name: "파지아노 오카야마", aliases: ["파지아노 오카야마", "Fagiano Okayama"] },
    { id: 292, name: "FC 도쿄", aliases: ["FC 도쿄", "FC도쿄", "FC Tokyo"] },
    { id: 293, name: "감바 오사카", aliases: ["감바 오사카", "Gamba Osaka"] },
    { id: 301, name: "제프 유나이티드 지바", aliases: ["제프 유나이티드 지바", "제프 유나이티드", "제프 지바", "JEF United Chiba"] },
    { id: 290, name: "가시마 앤틀러스", aliases: ["가시마 앤틀러스", "가시마", "Kashima"] },
    { id: 281, name: "가시와 레이솔", aliases: ["가시와 레이솔", "Kashiwa Reysol"] },
    { id: 294, name: "가와사키 프론탈레", aliases: ["가와사키 프론탈레", "Kawasaki Frontale"] },
    { id: 302, name: "교토 상가", aliases: ["교토 상가", "Kyoto Sanga"] },
    { id: 303, name: "마치다 젤비아", aliases: ["마치다 젤비아", "Machida Zelvia"] },
    { id: 305, name: "미토 홀리호크", aliases: ["미토 홀리호크", "Mito Hollyhock"] },
    { id: 288, name: "나고야 그램퍼스", aliases: ["나고야 그램퍼스", "Nagoya Grampus"] },
    { id: 282, name: "산프레체 히로시마", aliases: ["산프레체 히로시마", "Sanfrecce Hiroshima"] },
    { id: 283, name: "시미즈 에스펄스", aliases: ["시미즈 에스펄스", "Shimizu S-pulse"] },
    { id: 306, name: "도쿄 베르디", aliases: ["도쿄 베르디", "Tokyo Verdy"] },
    { id: 287, name: "우라와 레즈", aliases: ["우라와 레즈", "우라와", "Urawa"] },
    { id: 289, name: "비셀 고베", aliases: ["비셀 고베", "Vissel Kobe"] },
    { id: 285, name: "V-바렌 나가사키", aliases: ["V-바렌 나가사키", "V바렌 나가사키", "V-varen Nagasaki"] },
    { id: 296, name: "요코하마 F. 마리노스", aliases: ["요코하마 F. 마리노스", "요코하마 F마리노스", "Yokohama F. Marinos"] },
  ],
};

export function teamIdentityForAlias(league: LeagueCode, raw: string): TeamIdentity | null {
  const id = teamIdForAlias(league, raw);
  const team = id === null ? undefined : TEAMS_BY_LEAGUE[league].find((candidate) => candidate.id === id);
  return team ? { key: `${league}:${team.id}`, leagueCode: league, id: team.id, name: team.name } : null;
}

export function teamsForLeague(league: "all" | LeagueCode): HistoryTeamOption[] {
  const leagues = league === "all" ? (["K1", "J1"] as const) : [league];
  return leagues.flatMap((code) => TEAMS_BY_LEAGUE[code].map((team) => ({ key: `${code}:${team.id}` as const, leagueCode: code, id: team.id, name: team.name })))
    .sort((a, b) => a.leagueCode.localeCompare(b.leagueCode) || a.name.localeCompare(b.name, "ko"));
}
```

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `npx.cmd tsx --test tests/odds-history-contract.test.ts tests/betman-matcher.test.ts`

Expected: PASS, including the unchanged current-round exact-alias and ambiguity tests.

- [ ] **Step 5: Commit the contract boundary**

```bash
git add app/lib/betman-history-types.ts app/lib/odds-history-contract.ts app/lib/team-aliases.ts tests/odds-history-contract.test.ts tests/betman-matcher.test.ts
git commit -m "feat: define odds history contracts"
```

### Task 2: D1 schema and migration

**Files:**
- Modify: `db/schema.ts`
- Create: `drizzle/0004_betman_odds_history.sql`
- Create: `drizzle/meta/0004_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Create: `tests/odds-history-schema.test.ts`

**Interfaces:**
- Consumes: `RoundStatus` and `HistoryDisplayStatus` string values from Task 1.
- Produces: Drizzle exports `betmanHistoryRounds` and `betmanHistoryMatches`; SQL tables `betman_history_rounds` and `betman_history_matches` with the exact column/index names from design section 6.

- [ ] **Step 1: Write the failing schema parity and immutability tests**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { betmanHistoryMatches, betmanHistoryRounds } from "../db/schema.ts";

test("history schema exports two separate tables", () => {
  assert.equal(betmanHistoryRounds[Symbol.for("drizzle:Name")], "betman_history_rounds");
  assert.equal(betmanHistoryMatches[Symbol.for("drizzle:Name")], "betman_history_matches");
});

test("migration has checks, foreign key, unique keys, and no delete trigger", () => {
  const sql = readFileSync("drizzle/0004_betman_odds_history.sql", "utf8");
  for (const token of ["CHECK", "REFERENCES `betman_history_rounds`", "UNIQUE", "idx_betman_history_matches_league_date"]) assert.match(sql, new RegExp(token));
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+betman_history/i);
});
```

- [ ] **Step 2: Run the schema test and verify it fails**

Run: `npx.cmd tsx --test tests/odds-history-schema.test.ts`

Expected: FAIL because the schema exports and migration do not exist.

- [ ] **Step 3: Write the minimal schema implementation and generate the named migration**

```ts
// db/schema.ts additions; import check, uniqueIndex and sql
export const betmanHistoryRounds = sqliteTable("betman_history_rounds", {
  roundKey: text("round_key").primaryKey(), gmId: text("gm_id").notNull(), gmTs: text("gm_ts").notNull(),
  sourceUrl: text("source_url").notNull(), status: text("status").notNull(), providerFinal: integer("provider_final").notNull().default(0),
  eventFrom: text("event_from"), eventTo: text("event_to"), attemptCount: integer("attempt_count").notNull().default(0),
  lastAttemptAt: text("last_attempt_at"), lastSuccessAt: text("last_success_at"), finalizedAt: text("finalized_at"),
  errorCode: text("error_code"), errorMessage: text("error_message"), leaseExpiresAt: text("lease_expires_at"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("uq_betman_history_round").on(table.gmId, table.gmTs),
  index("idx_betman_history_rounds_status_range").on(table.status, table.eventFrom, table.eventTo),
  check("ck_betman_history_round_gm", sql`${table.gmId} = 'G101'`),
]);

export const betmanHistoryMatches = sqliteTable("betman_history_matches", {
  sourceKey: text("source_key").primaryKey(), roundKey: text("round_key").notNull().references(() => betmanHistoryRounds.roundKey),
  gmId: text("gm_id").notNull(), gmTs: text("gm_ts").notNull(), matchSeq: text("match_seq").notNull(),
  leagueCode: text("league_code").notNull(), leagueName: text("league_name").notNull(), betmanLeagueName: text("betman_league_name").notNull(),
  kickoffAt: text("kickoff_at").notNull(), matchDate: text("match_date").notNull(), homeTeamId: integer("home_team_id"), awayTeamId: integer("away_team_id"),
  homeTeamName: text("home_team_name"), awayTeamName: text("away_team_name"), betmanHomeTeam: text("betman_home_team").notNull(), betmanAwayTeam: text("betman_away_team").notNull(),
  homeScore: integer("home_score"), awayScore: integer("away_score"), result: text("result"),
  homeOdds: real("home_odds"), drawOdds: real("draw_odds"), awayOdds: real("away_odds"),
  displayStatus: text("display_status").notNull(), sourceFinal: integer("source_final").notNull().default(0),
  firstSeenAt: text("first_seen_at").notNull(), lastSeenAt: text("last_seen_at").notNull(), finalizedAt: text("finalized_at"),
}, (table) => [
  uniqueIndex("uq_betman_history_match_source").on(table.gmId, table.gmTs, table.matchSeq),
  index("idx_betman_history_matches_status_date").on(table.displayStatus, table.matchDate, table.kickoffAt),
  index("idx_betman_history_matches_league_date").on(table.leagueCode, table.matchDate, table.kickoffAt),
  index("idx_betman_history_matches_home_date").on(table.leagueCode, table.homeTeamId, table.matchDate),
  index("idx_betman_history_matches_away_date").on(table.leagueCode, table.awayTeamId, table.matchDate),
  index("idx_betman_history_matches_round").on(table.roundKey),
  check("ck_betman_history_match_league", sql`${table.leagueCode} in ('K1', 'J1')`),
  check("ck_betman_history_match_result", sql`${table.result} is null or ${table.result} in ('H', 'D', 'A')`),
  check("ck_betman_history_match_status", sql`${table.displayStatus} in ('INCLUDED', 'CANCELLED', 'PENDING_RESULT', 'MISSING_ODDS', 'TEAM_MATCH_FAILED')`),
]);
```

Run: `npm.cmd run db:generate -- --name betman_odds_history`

Expected: creates `drizzle/0004_betman_odds_history.sql`, `drizzle/meta/0004_snapshot.json`, and a `0004_betman_odds_history` journal entry. Inspect the SQL and add the specified `CHECK` clauses if Drizzle did not emit them.

- [ ] **Step 4: Run schema and type tests and verify they pass**

Run: `npx.cmd tsx --test tests/odds-history-schema.test.ts && npm.cmd run typecheck`

Expected: PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the schema**

```bash
git add db/schema.ts drizzle/0004_betman_odds_history.sql drizzle/meta/0004_snapshot.json drizzle/meta/_journal.json tests/odds-history-schema.test.ts
git commit -m "feat: add Betman history archive schema"
```

### Task 3: Strict closed-round parser

**Files:**
- Create: `app/lib/betman-history-parser.ts`
- Create: `tests/betman-history-parser.test.ts`
- Create: `tests/fixtures/betman-history/closed-round-final.json`
- Create: `tests/fixtures/betman-history/closed-round-pending.json`

**Interfaces:**
- Consumes: `ClosedRoundDocument`, `ParsedClosedRound`, `ParsedHistoryMatch`, and `HistoryDisplayStatus` from Task 1; `teamIdentityForAlias` from `team-aliases.ts`.
- Produces: `parseClosedRoundDocument(document: ClosedRoundDocument, resolveTeam?: typeof teamIdentityForAlias): ParsedClosedRound`; `BetmanHistorySchemaError` with code `BETMAN_SCHEMA_CHANGED`; strict `canonicalHistoryLeague(raw: string): "K1" | "J1" | null`.

- [ ] **Step 1: Write failing parser tests and redacted fixtures**

```ts
test("parses only final normal football match-winner rows", () => {
  const parsed = parseClosedRoundDocument(finalDocumentFixture);
  assert.deepEqual(parsed.matches.map(({ matchSeq, displayStatus, result }) => ({ matchSeq, displayStatus, result })), [
    { matchSeq: "5345", displayStatus: "INCLUDED", result: "H" },
    { matchSeq: "5346", displayStatus: "TEAM_MATCH_FAILED", result: "A" },
  ]);
  assert.equal(parsed.matches[0].betmanHomeTeam, "FC도쿄");
  assert.equal(parsed.matches[0].homeTeamName, "FC 도쿄");
});

test("assigns one exclusion using the required priority", () => {
  const parsed = parseClosedRoundDocument(pendingDocumentFixture);
  assert.deepEqual(parsed.matches.map((row) => row.displayStatus), ["CANCELLED", "PENDING_RESULT", "MISSING_ODDS", "TEAM_MATCH_FAILED"]);
});

test("rejects duplicate matchSeq and score-result conflicts atomically", () => {
  assert.throws(() => parseClosedRoundDocument(duplicateFixture), /BETMAN_SCHEMA_CHANGED/);
  assert.throws(() => parseClosedRoundDocument(conflictingResultFixture), /BETMAN_SCHEMA_CHANGED/);
});
```

Fixtures must contain only synthetic/redacted team, status, score, market, odds, and round fields needed by the parser; do not copy cookies, account fields, or a complete live body.

- [ ] **Step 2: Run the parser test and verify it fails**

Run: `npx.cmd tsx --test tests/betman-history-parser.test.ts`

Expected: FAIL because the strict parser does not exist.

- [ ] **Step 3: Write the minimal strict parser implementation**

```ts
export class BetmanHistorySchemaError extends Error { readonly code = "BETMAN_SCHEMA_CHANGED" as const; }

const EXCLUSION_PRIORITY: HistoryDisplayStatus[] = ["CANCELLED", "PENDING_RESULT", "MISSING_ODDS", "TEAM_MATCH_FAILED"];

export function parseClosedRoundDocument(document: ClosedRoundDocument, resolveTeam = teamIdentityForAlias): ParsedClosedRound {
  const rows = expandAndValidateRows(document.payload, document.round);
  const matches = rows.flatMap((row) => {
    if (!isFootball(row) || !canonicalHistoryLeague(text(row.leagueName))) return [];
    if (text(row.gameKind) !== "일반" || text(row.marketName) !== "축구 승무패" || text(row.condition) !== "-") return [];
    const candidate = parseCandidate(row, document, resolveTeam);
    validateNoResultConflict(candidate);
    return [candidate];
  });
  assertUniqueMatchSequences(matches);
  return { round: document.round, fetchedAt: document.fetchedAt, providerFinal: document.providerFinal, ...eventBounds(matches), matches };
}
```

Define these private helpers in the same file:

```ts
function expandAndValidateRows(payload: unknown, round: ClosedRoundRef): Record<string, unknown>[];
function isFootball(row: Record<string, unknown>): boolean;
function text(value: unknown): string;
function parseCandidate(row: Record<string, unknown>, document: ClosedRoundDocument, resolveTeam: typeof teamIdentityForAlias): ParsedHistoryMatch;
function validateNoResultConflict(candidate: ParsedHistoryMatch): void;
function assertUniqueMatchSequences(matches: ParsedHistoryMatch[]): void;
function eventBounds(matches: ParsedHistoryMatch[]): { eventFrom: string | null; eventTo: string | null };
```

`expandAndValidateRows` accepts only an object whose round IDs match the request and whose `keys`/`datas` arrays align; an explicitly marked zero-game document returns `[]`, while an unmarked empty document throws. `parseCandidate` first preserves raw league/home/away text, reads a Korean-offset ISO kickoff, then calculates exactly one status in cancellation → pending result → missing odds → team mapping order. It sets `sourceFinal=true` only when the provider state is terminal and sets `INCLUDED` only when both canonical teams, non-negative integer scores, consistent H/D/A, and exactly one each of positive `승`, `무`, `패` odds are present. `validateNoResultConflict` compares H/D/A to the score and throws on disagreement; `assertUniqueMatchSequences` throws on a missing, non-numeric, or repeated sequence.

- [ ] **Step 4: Run parser and current Betman tests and verify they pass**

Run: `npx.cmd tsx --test tests/betman-history-parser.test.ts tests/betman-parser.test.ts tests/betman-matcher.test.ts`

Expected: PASS; the new strict parser does not change the current-round parser.

- [ ] **Step 5: Commit the parser**

```bash
git add app/lib/betman-history-parser.ts tests/betman-history-parser.test.ts tests/fixtures/betman-history/closed-round-final.json tests/fixtures/betman-history/closed-round-pending.json
git commit -m "feat: parse finalized Betman history"
```

### Task 4: Anonymous Betman closed-round adapter

**Files:**
- Create: `app/lib/betman-history-adapter.ts`
- Create: `tests/betman-history-adapter.test.ts`
- Create: `tests/fixtures/betman-history/closed-round-list.html`
- Create: `scripts/betman-history-smoke.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `ClosedRoundRef` and `ClosedRoundDocument` from Task 1; strict fixed `G101` source rule.
- Produces: `AnonymousSession = { cookie: string }`; `BetmanClosedAdapter`; `createAnonymousSession(fetchImpl?: typeof fetch): Promise<AnonymousSession>`; `createBetmanClosedAdapter(fetchImpl?: typeof fetch): BetmanClosedAdapter`; `mapWithConcurrency<T,R>(items, limit: 2, worker): Promise<R[]>`; exported constants `BETMAN_HISTORY_ORIGIN`, `BETMAN_TIMEOUT_MS=15000`, `BETMAN_MAX_BODY_BYTES=3*1024*1024`.

- [ ] **Step 1: Write failing adapter tests around a scripted fetch**

```ts
test("keeps anonymous cookies inside one adapter request chain", async () => {
  const calls: Request[] = [];
  const adapter = createBetmanClosedAdapter(scriptedFetch(calls));
  const session = await createAnonymousSession(scriptedFetch(calls));
  const rounds = await adapter.discoverRounds("2026-08-01", "2026-08-21", session);
  await adapter.fetchRound(rounds[0], session);
  assert.match(calls.at(-1)!.headers.get("cookie") ?? "", /JSESSIONID=redacted/);
});

test("rejects off-origin redirects and oversized bodies", async () => {
  await assert.rejects(() => createAnonymousSession(offOriginFetch), /BETMAN_UNAVAILABLE/);
  await assert.rejects(() => createAnonymousSession(oversizedFetch), /BETMAN_SCHEMA_CHANGED/);
});

test("never runs more than two detail workers", async () => {
  let active = 0; let maximum = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => { active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--; return value; });
  assert.equal(maximum, 2);
});
```

- [ ] **Step 2: Run the adapter test and verify it fails**

Run: `npx.cmd tsx --test tests/betman-history-adapter.test.ts`

Expected: FAIL because the adapter and list fixture do not exist.

- [ ] **Step 3: Write the minimal fixed-origin adapter and smoke command**

```ts
export const BETMAN_HISTORY_ORIGIN = "https://www.betman.co.kr";
export const BETMAN_TIMEOUT_MS = 15_000;
export const BETMAN_MAX_BODY_BYTES = 3 * 1024 * 1024;
export type AnonymousSession = { cookie: string };
export interface BetmanClosedAdapter {
  discoverRounds(from: string, to: string, session: AnonymousSession): Promise<ClosedRoundRef[]>;
  fetchRound(round: ClosedRoundRef, session: AnonymousSession): Promise<ClosedRoundDocument>;
}

const ENTRY_PATH = "/main/mainPage/gamebuy/winrstList.do";
const SLIP_PATH = "/main/mainPage/gamebuy/gameSlip.do";
const DETAIL_PATH = "/buyPsblGame/gameInfoInq.do";

export async function createAnonymousSession(fetchImpl = fetch): Promise<AnonymousSession> {
  const { response } = await limitedFetch(fetchImpl, `${BETMAN_HISTORY_ORIGIN}${ENTRY_PATH}`, { headers: { accept: "text/html,application/xhtml+xml" } });
  if (!response.ok) throw providerError("BETMAN_UNAVAILABLE", `Betman 마감게임 화면 HTTP ${response.status}`);
  return { cookie: extractSessionCookie(response.headers) };
}

async function limitedFetch(fetchImpl: typeof fetch, input: RequestInfo, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BETMAN_TIMEOUT_MS);
  try {
    const response = await fetchImpl(input, { ...init, redirect: "follow", signal: controller.signal });
    assertBetmanUrl(response.url);
    return { response, bytes: await readAtMost(response.body, BETMAN_MAX_BODY_BYTES) };
  } finally { clearTimeout(timer); }
}

export function createBetmanClosedAdapter(fetchImpl = fetch): BetmanClosedAdapter {
  return {
    discoverRounds: (from, to, session) => discoverClosedRounds(fetchImpl, from, to, session),
    fetchRound: (round, session) => fetchClosedRound(fetchImpl, round, session),
  };
}
```

Implement these private functions in the same file with the exact signatures and behavior:

```ts
async function discoverClosedRounds(fetchImpl: typeof fetch, from: string, to: string, session: AnonymousSession): Promise<ClosedRoundRef[]>;
function parseClosedRoundPage(html: string, requestedFrom: string, requestedTo: string): { rounds: ClosedRoundRef[]; nextPage: URL | null };
async function fetchClosedRound(fetchImpl: typeof fetch, round: ClosedRoundRef, session: AnonymousSession): Promise<ClosedRoundDocument>;
async function readAtMost(body: ReadableStream<Uint8Array> | null, maximumBytes: number): Promise<Uint8Array>;
function assertBetmanUrl(value: string): URL;
function extractSessionCookie(headers: Headers): string;
function providerError(code: "BETMAN_UNAVAILABLE" | "BETMAN_SCHEMA_CHANGED", message: string): OddsHistoryValidationError;
```

`parseClosedRoundPage` accepts only normalized links/forms whose `gmId` equals `G101`, `gmTs` is digits, and displayed event bounds intersect the inclusive requested range; it follows only a same-origin next-page link, rejects a login/block page, deduplicates on `G101:{gmTs}`, and the caller sorts descending by numeric `gmTs`. `fetchClosedRound` GETs the normalized slip with the session cookie, POSTs JSON `{ gmId: "G101", gmTs: round.gmTs, gameYear: "", _sbmInfo: { _sbmInfo: { debugMode: "false" } } }` to `DETAIL_PATH`, verifies the response IDs and explicit final marker, and returns the parsed JSON as `payload`. `readAtMost` counts streamed bytes and cancels/throws at byte `3 * 1024 * 1024 + 1`.

The smoke script derives the last seven Korean-calendar days, discovers rounds, fetches only the newest `G101` round, invokes the strict parser, and prints `{ gmTs, providerFinal, candidateCount, fetchedAt }`; it never prints cookies or payloads. Add:

```json
"test:betman-history-smoke": "tsx scripts/betman-history-smoke.ts"
```

- [ ] **Step 4: Run adapter tests and verify they pass, then run the read-only smoke**

Run: `npx.cmd tsx --test tests/betman-history-adapter.test.ts`

Expected: PASS.

Run: `npm.cmd run test:betman-history-smoke`

Expected: exit 0 after printing metadata for no more than one `G101` round; no cookie or full body appears. If the provider is unreachable, record `BETMAN_UNAVAILABLE` as an external verification blocker and do not weaken the adapter tests.

- [ ] **Step 5: Commit the adapter**

```bash
git add app/lib/betman-history-adapter.ts tests/betman-history-adapter.test.ts tests/fixtures/betman-history/closed-round-list.html scripts/betman-history-smoke.ts package.json
git commit -m "feat: add anonymous Betman history adapter"
```

### Task 5: Immutable D1 history store and cooldown

**Files:**
- Create: `app/lib/odds-history-store.ts`
- Create: `tests/odds-history-store.test.ts`

**Interfaces:**
- Consumes: `OddsHistoryQuery`, `ParsedClosedRound`, `ClosedRoundRef`, `HistoryDisplayStatus`, canonical team resolver, and the Task 2 tables.
- Produces: `OddsHistoryStore`; `createOddsHistoryStore(database: D1Database): OddsHistoryStore`; `pendingRetryAt(round): string | null`; store methods `registerRounds`, `query`, `claimCandidates`, `persistRound`, `recordRoundError`, `rematchFinalTeamFailures`, and `releaseLease` with the signatures below.

```ts
export interface OddsHistoryStore {
  registerRounds(rounds: ClosedRoundRef[], now: string): Promise<void>;
  query(query: OddsHistoryQuery, now: string): Promise<OddsHistoryPayload>;
  claimCandidates(roundKeys: string[], now: string, limit: 5): Promise<{ claimed: ClosedRoundRef[]; skippedFinal: number; deferredPending: number; nextPendingRetryAt: string | null; nextIndex: number }>;
  persistRound(round: ParsedClosedRound, now: string): Promise<{ status: RoundStatus; inserted: number; updatedPending: number; preservedFinal: number; excluded: ExcludedCounts }>;
  recordRoundError(round: ClosedRoundRef, code: string, message: string, now: string): Promise<void>;
  rematchFinalTeamFailures(roundKeys: string[], now: string): Promise<number>;
  releaseLease(roundKey: string, now: string): Promise<void>;
}
```

- [ ] **Step 1: Write failing store tests with a statement-recording fake D1**

```ts
test("pending cooldown uses the newer success/attempt timestamp", () => {
  assert.equal(pendingRetryAt({ last_success_at: "2026-08-21T00:00:00.000Z", last_attempt_at: "2026-08-21T00:10:00.000Z" }), "2026-08-21T00:40:00.000Z");
});

test("claim skips pending at 29:59, claims at 30:00, and never claims final", async () => {
  const store = createOddsHistoryStore(fakeDatabaseWithRounds([pendingRound, finalRound]));
  assert.equal((await store.claimCandidates([pendingRound.round_key], "2026-08-21T00:39:59.000Z", 5)).claimed.length, 0);
  assert.equal((await store.claimCandidates([pendingRound.round_key], "2026-08-21T00:40:00.000Z", 5)).claimed.length, 1);
  assert.equal((await store.claimCandidates([finalRound.round_key], "2026-09-21T00:00:00.000Z", 5)).claimed.length, 0);
});

test("final conflict preserves stored values and records FINAL_CONFLICT", async () => {
  const fake = fakeDatabaseWithFinalMatch(existingFinal);
  await assert.rejects(() => createOddsHistoryStore(fake).persistRound(conflictingFinal, now), /FINAL_CONFLICT/);
  assert.equal(fake.row("G101:260098:5345").home_odds, existingFinal.home_odds);
  assert.equal(fake.deleteStatements.length, 0);
});
```

- [ ] **Step 2: Run the store test and verify it fails**

Run: `npx.cmd tsx --test tests/odds-history-store.test.ts`

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Write the minimal store implementation**

```ts
export function pendingRetryAt(row: { last_success_at: string | null; last_attempt_at: string | null }) {
  const latest = [row.last_success_at, row.last_attempt_at].filter(Boolean).sort().at(-1);
  return latest ? new Date(Date.parse(latest) + 30 * 60 * 1000).toISOString() : null;
}

export function createOddsHistoryStore(database: D1Database): OddsHistoryStore {
  return {
    claimCandidates: (roundKeys, now, limit) => claimCandidates(database, roundKeys, now, limit),
    persistRound: (round, now) => persistRound(database, round, now),
    query: (query, now) => queryHistory(database, query, now),
    rematchFinalTeamFailures: (roundKeys, now) => rematchFinalTeamFailures(database, roundKeys, now),
    registerRounds: (rounds, now) => registerRounds(database, rounds, now),
    recordRoundError: (round, code, message, now) => recordRoundError(database, round, code, message, now),
    releaseLease: (roundKey, now) => releaseLease(database, roundKey, now),
  };
}
```

Define all seven private functions in the same file. `claimCandidates` reads rows in cursor order and claims with `UPDATE betman_history_rounds SET status='SYNCING', attempt_count=attempt_count+1, last_attempt_at=?, lease_expires_at=? WHERE round_key=? AND status<>'FINAL' AND (lease_expires_at IS NULL OR lease_expires_at<=?)`; it omits cooling `PENDING` rows before this statement. `persistRound` reads existing source keys first, throws `FINAL_CONFLICT` on a differing finalized row, then batches the round update and one insert/upsert per candidate. Its conflict clause ends with `DO UPDATE ... WHERE betman_history_matches.source_final=0`. `queryHistory` builds bound conditions only, selects `INCLUDED`, orders `kickoff_at DESC, gm_ts DESC, match_seq DESC`, uses `LIMIT 30 OFFSET (page-1)*30`, and runs separate total/exclusion/archive counts. `registerRounds` uses `ON CONFLICT(round_key) DO NOTHING`. `recordRoundError` truncates a newline-free message to 300 characters and uses `WHERE status<>'FINAL'`. `releaseLease` clears only `lease_expires_at` for the requested key. `rematchFinalTeamFailures` selects only `source_final=1 AND display_status='TEAM_MATCH_FAILED'`, calls `teamIdentityForAlias` for both raw names, and updates only IDs, canonical names, display status, and `last_seen_at`.

Before `database.batch`, reject an `INCLUDED` row unless team IDs/names, scores, result, three odds, `sourceFinal`, and finalized time are present. The generated SQL for history writes must contain no `DELETE` and must update only rows where `source_final=0`.

- [ ] **Step 4: Run store, schema, and type tests and verify they pass**

Run: `npx.cmd tsx --test tests/odds-history-store.test.ts tests/odds-history-schema.test.ts && npm.cmd run typecheck`

Expected: PASS; cooldown boundary and immutable conflict tests are green.

- [ ] **Step 5: Commit the store**

```bash
git add app/lib/odds-history-store.ts tests/odds-history-store.test.ts
git commit -m "feat: persist immutable odds history"
```

### Task 6: D1-only history GET API

**Files:**
- Create: `app/api/odds-history/route.ts`
- Create: `tests/odds-history-route.test.ts`

**Interfaces:**
- Consumes: `parseOddsHistoryQuery`, `OddsHistoryStore.query`, and `OddsHistoryError`.
- Produces: `handleOddsHistoryGet(request: Request, deps: { store: OddsHistoryStore; now: () => Date }): Promise<Response>` for tests; App Router `GET(request: Request): Promise<Response>` using `env.DB` and `createOddsHistoryStore`.

- [ ] **Step 1: Write failing GET handler tests**

```ts
test("GET returns the exact D1 payload and never calls Betman", async () => {
  const store = fakeStore({ query: async () => historyPayload });
  const response = await handleOddsHistoryGet(new Request("http://local/api/odds-history?league=J1&team=J1%3A292&from=2026-05-21&to=2026-08-21&page=1"), { store, now: fixedNow });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), historyPayload);
});

test("GET maps validation and D1 failures", async () => {
  assert.equal((await handleOddsHistoryGet(new Request("http://local/api/odds-history?from=bad&to=2026-08-21"), deps)).status, 400);
  assert.equal((await handleOddsHistoryGet(validRequest, { store: failingStore, now: fixedNow })).status, 503);
});
```

- [ ] **Step 2: Run the GET route test and verify it fails**

Run: `npx.cmd tsx --test tests/odds-history-route.test.ts`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Write the minimal dependency-injected GET handler**

```ts
export async function handleOddsHistoryGet(request: Request, deps: { store: OddsHistoryStore; now: () => Date }) {
  try {
    const query = parseOddsHistoryQuery(new URL(request.url), deps.now());
    return Response.json(await deps.store.query(query, deps.now().toISOString()));
  } catch (error) {
    return error instanceof OddsHistoryValidationError
      ? oddsHistoryErrorResponse(error, 400)
      : oddsHistoryErrorResponse(databaseUnavailable(), 503);
  }
}

export async function GET(request: Request) {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) return oddsHistoryErrorResponse(databaseUnavailable(), 503);
  return handleOddsHistoryGet(request, { store: createOddsHistoryStore(env.DB), now: () => new Date() });
}

function databaseUnavailable() {
  return new OddsHistoryValidationError("DATABASE_UNAVAILABLE", "D1 저장소를 사용할 수 없습니다.", null, true);
}
```

- [ ] **Step 4: Run GET route and contract tests and verify they pass**

Run: `npx.cmd tsx --test tests/odds-history-route.test.ts tests/odds-history-contract.test.ts`

Expected: PASS for defaults, explicit filters, fixed pagination, response shape, and 400/503 envelopes.

- [ ] **Step 5: Commit the GET API**

```bash
git add app/api/odds-history/route.ts tests/odds-history-route.test.ts
git commit -m "feat: expose stored odds history"
```

### Task 7: Bounded sync engine and POST API

**Files:**
- Create: `app/lib/odds-history-sync.ts`
- Create: `app/api/odds-history/sync/route.ts`
- Create: `tests/odds-history-sync.test.ts`

**Interfaces:**
- Consumes: `BetmanClosedAdapter`, `OddsHistoryStore`, `parseClosedRoundDocument`, cursor functions, `mapWithConcurrency`, max five and max two constants.
- Produces: `runOddsHistorySync(input: { from: string; to: string; cursor: string | null }, deps: SyncDependencies): Promise<SyncPayload>`; `handleOddsHistorySync(request: Request, deps: SyncRouteDependencies): Promise<Response>`; App Router `POST(request: Request): Promise<Response>`.

```ts
export type SyncDependencies = {
  adapter: BetmanClosedAdapter; store: OddsHistoryStore;
  createSession: () => Promise<AnonymousSession>;
  parseRound: typeof parseClosedRoundDocument; now: () => Date;
};
export type SyncRouteDependencies = { run: (input: SyncInput) => Promise<SyncPayload>; now: () => Date };
```

- [ ] **Step 1: Write failing orchestration and route tests**

```ts
test("sync fetches at most five rounds with at most two details active", async () => {
  const result = await runOddsHistorySync({ from, to, cursor: null }, controlledDependencies({ discovered: sevenRounds }));
  assert.equal(result.processedRounds, 5);
  assert.equal(result.maxParallelDetails, 2);
  assert.equal(result.hasMore, true);
  assert.ok(result.nextCursor);
});

test("sync skips FINAL and cooling PENDING while advancing cursor", async () => {
  const result = await runOddsHistorySync(input, controlledDependencies({ final: 1, coolingPending: 1 }));
  assert.equal(result.deferredPendingRounds, 1);
  assert.equal(result.nextPendingRetryAt, "2026-08-21T00:40:00.000Z");
  assert.equal(detailCalls, 0);
  assert.equal(result.hasMore, false);
});

test("partial round errors preserve successful rounds", async () => {
  const response = await handleOddsHistorySync(validPost, dependenciesWithOneFailure);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "partial");
});
```

- [ ] **Step 2: Run the sync test and verify it fails**

Run: `npx.cmd tsx --test tests/odds-history-sync.test.ts`

Expected: FAIL because the sync engine and route do not exist.

- [ ] **Step 3: Write the minimal cursor sweep and POST handler**

```ts
export async function runOddsHistorySync(input: SyncInput, deps: SyncDependencies): Promise<SyncPayload> {
  const startedAt = deps.now().toISOString();
  const session = await deps.createSession();
  const discovered = await deps.adapter.discoverRounds(input.from, input.to, session);
  await deps.store.registerRounds(discovered, startedAt);
  const cursor = input.cursor
    ? decodeSyncCursor(input.cursor, input, discovered.map(roundKey), deps.now())
    : { version: 1, from: input.from, to: input.to, roundKeys: discovered.map(roundKey), nextIndex: 0, issuedAt: startedAt };
  await deps.store.rematchFinalTeamFailures(cursor.roundKeys, startedAt);
  const claim = await deps.store.claimCandidates(cursor.roundKeys.slice(cursor.nextIndex), startedAt, 5);
  const rounds = await mapWithConcurrency(claim.claimed, 2, (round) => syncOneRound(round, session, deps));
  const nextIndex = cursor.nextIndex + claim.nextIndex;
  return buildSyncPayload(rounds, claim, cursor, nextIndex, deps.now().toISOString());
}

export async function handleOddsHistorySync(request: Request, deps: SyncRouteDependencies) {
  try {
    return Response.json(await deps.run(parseSyncBody(await request.json(), deps.now())));
  } catch (error) {
    return syncErrorResponse(error);
  }
}
```

Define `roundKey(round: ClosedRoundRef): string`, `syncOneRound(round, session, deps): Promise<SyncRoundResult>`, `buildSyncPayload(rounds, claim, cursor, nextIndex, finishedAt): SyncPayload`, and `syncErrorResponse(error): Response` in the same module/route pair. `syncOneRound` catches per-round fetch/parser/store errors, calls `recordRoundError`, releases its lease in `finally`, and returns only `{ gmTs, status, inserted, updatedPending, preservedFinal, excluded, error: { code, message } | null }`. `buildSyncPayload` sets `hasMore = nextIndex < cursor.roundKeys.length`, emits an encoded cursor only when true, reports the claim's deferred count/retry time, and returns `partial` when any result is `PENDING`/`ERROR` or any unresolved count is nonzero. `syncErrorResponse` maps invalid JSON/date/cursor to 400, all-busy to 409, no safely processed provider/schema/conflict result to 502, missing D1 to 503, and unexpected errors to 500. The exported App Router `POST` imports `env.DB`, constructs the real adapter/store/parser dependencies, and delegates to `handleOddsHistorySync`.

- [ ] **Step 4: Run sync, adapter, parser, and store tests and verify they pass**

Run: `npx.cmd tsx --test tests/odds-history-sync.test.ts tests/betman-history-adapter.test.ts tests/betman-history-parser.test.ts tests/odds-history-store.test.ts`

Expected: PASS, including cursor advancement, cooldown, final skips, partial success, two-worker maximum, and five-round maximum.

- [ ] **Step 5: Commit the sync API**

```bash
git add app/lib/odds-history-sync.ts app/api/odds-history/sync/route.ts tests/odds-history-sync.test.ts
git commit -m "feat: synchronize Betman history rounds"
```

### Task 8: Stored-first browser orchestration

**Files:**
- Create: `app/lib/odds-history-client.ts`
- Create: `tests/odds-history-client.test.ts`

**Interfaces:**
- Consumes: `OddsHistoryQuery`, `OddsHistoryPayload`, `SyncPayload`, and `historyQueryString`.
- Produces: `runOddsHistoryRefresh(options): Promise<void>`; `fetchOddsHistoryPage(options): Promise<void>`; `reconcileHistoryTeam(selectedTeam, league, teams): string | null`; `pageWindow(page, totalPages): Array<number | "ellipsis">`.

```ts
export type HistoryRefreshOptions = {
  query: OddsHistoryQuery; fetchImpl: typeof fetch; signal: AbortSignal;
  isCurrent: () => boolean;
  onStored: (payload: OddsHistoryPayload) => void;
  onSync: (payload: SyncPayload) => void;
  onFinal: (payload: OddsHistoryPayload) => void;
};
export type HistoryPageOptions = {
  query: OddsHistoryQuery; fetchImpl: typeof fetch; signal: AbortSignal;
  isCurrent: () => boolean; onPage: (payload: OddsHistoryPayload) => void;
};
```

- [ ] **Step 1: Write failing client-flow tests**

```ts
test("refresh renders stored GET before cursor POSTs and final GET", async () => {
  const events: string[] = [];
  await runOddsHistoryRefresh({ ...options,
    fetchImpl: scriptedJsonFetch([storedPayload, { ...syncPayload, hasMore: true, nextCursor: "c2" }, { ...syncPayload, hasMore: false }, finalPayload]),
    onStored: () => events.push("stored"), onSync: () => events.push("sync"), onFinal: () => events.push("final"),
  });
  assert.deepEqual(events, ["stored", "sync", "sync", "final"]);
});

test("stale generation cannot publish late responses", async () => {
  let current = true; const events: string[] = [];
  await runOddsHistoryRefresh({ ...options, isCurrent: () => current, onStored: () => { events.push("stored"); current = false; }, onSync: () => events.push("sync"), onFinal: () => events.push("final") });
  assert.deepEqual(events, ["stored"]);
});

test("page-only fetch performs one GET and no sync", async () => {
  await fetchOddsHistoryPage(pageOptions);
  assert.deepEqual(requests.map((request) => [request.method, new URL(request.url).pathname]), [["GET", "/api/odds-history"]]);
});
```

- [ ] **Step 2: Run client tests and verify they fail**

Run: `npx.cmd tsx --test tests/odds-history-client.test.ts`

Expected: FAIL because the browser orchestration module does not exist.

- [ ] **Step 3: Write the minimal GET → sequential POST cursor → GET flow**

```ts
export async function runOddsHistoryRefresh(options: HistoryRefreshOptions) {
  const stored = await getHistory(options.query, options.fetchImpl, options.signal);
  if (!options.isCurrent()) return;
  options.onStored(stored);
  let cursor: string | null = null;
  do {
    const sync = await postSync({ from: options.query.from, to: options.query.to, cursor }, options.fetchImpl, options.signal);
    if (!options.isCurrent()) return;
    options.onSync(sync);
    cursor = sync.hasMore ? sync.nextCursor : null;
  } while (cursor);
  const finalPayload = await getHistory(options.query, options.fetchImpl, options.signal);
  if (options.isCurrent()) options.onFinal(finalPayload);
}
```

Define `getHistory(query, fetchImpl, signal): Promise<OddsHistoryPayload>` and `postSync(input, fetchImpl, signal): Promise<SyncPayload>` in the same file. Both parse the JSON error envelope and throw an `OddsHistoryClientError` carrying `code`, `message`, `field`, and `retryable` when `response.ok` is false. `postSync` must not sleep until `nextPendingRetryAt`; it stops solely when `hasMore=false`. `fetchOddsHistoryPage` calls only `getHistory` and applies the same `isCurrent` check. `reconcileHistoryTeam` returns null when a selected key is not in the new league list. `pageWindow` emits first/last and current ±2 pages with deduplicated ellipses.

- [ ] **Step 4: Run client and contract tests and verify they pass**

Run: `npx.cmd tsx --test tests/odds-history-client.test.ts tests/odds-history-contract.test.ts`

Expected: PASS for stored-first ordering, cursor continuation, no cooldown polling, abort/stale protection, team reset, and pagination helpers.

- [ ] **Step 5: Commit the client flow**

```bash
git add app/lib/odds-history-client.ts tests/odds-history-client.test.ts
git commit -m "feat: add stored-first odds history flow"
```

### Task 9: Real odds-history UI and page integration

**Files:**
- Create: `app/odds-history.tsx`
- Create: `tests/odds-history-view.test.ts`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: Task 8 refresh/page/team/pagination helpers and Task 1 payload/query types.
- Produces: default export `OddsHistory(): React.JSX.Element`; accessible status, filter, exclusion, table, and pagination markup mounted only for `section === "odds"`.

- [ ] **Step 1: Write failing component and rendered-shell tests**

```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OddsHistory } from "../app/odds-history.tsx";

test("history view exposes league/team/date filters and real table columns", () => {
  const html = renderToStaticMarkup(createElement(OddsHistory));
  for (const text of ["리그", "팀 선택", "시작일", "종료일", "경기일", "리그", "승 배당", "무 배당", "패 배당"]) assert.match(html, new RegExp(text));
  assert.doesNotMatch(html, /샘플|데모 데이터/);
});
```

Extend `tests/rendered-html.test.mjs` with:

```js
assert.match(html, /Betman 마감게임 · D1 아카이브/);
assert.doesNotMatch(html, /샘플 데이터|데모 데이터|화면 기능 검증을 위한 샘플/);
```

- [ ] **Step 2: Run component/render tests and verify they fail**

Run: `npx.cmd tsx --test tests/odds-history-view.test.ts`

Expected: FAIL because `OddsHistory` does not exist.

- [ ] **Step 3: Write the minimal component and replace sample markup**

```tsx
export function OddsHistory() {
  const defaults = defaultHistoryRange();
  const [draft, setDraft] = useState({ league: "all" as const, team: null as string | null, from: defaults.from, to: defaults.to });
  const [applied, setApplied] = useState<OddsHistoryQuery>({ ...draft, page: 1, pageSize: 30 });
  const [payload, setPayload] = useState<OddsHistoryPayload | null>(null);
  const [sync, setSync] = useState<SyncPayload | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    void runOddsHistoryRefresh({ query: applied, fetchImpl: fetch, signal: controller.signal,
      isCurrent: () => generation.current === requestGeneration,
      onStored: setPayload, onSync: setSync, onFinal: setPayload,
    }).catch((error) => { if (generation.current === requestGeneration && error.name !== "AbortError") setError(messageFor(error)); });
    return () => controller.abort();
  }, [applied.league, applied.team, applied.from, applied.to]);

  const teams = payload?.teams.filter((team) => draft.league === "all" || team.leagueCode === draft.league) ?? [];
  return <section className="odds-page">
    <div className="section-heading odds-heading"><div><p className="eyebrow">ODDS ARCHIVE</p><h1>배당기록</h1><p>Betman 마감 경기의 결과와 최종 승·무·패 배당입니다.</p></div><span>Betman 마감게임 · D1 아카이브</span></div>
    <div className="odds-filter-card">
      <label><span>리그</span><select value={draft.league} onChange={(event) => changeLeague(event.target.value as HistoryLeagueFilter)}><option value="all">전체</option><option value="K1">K리그1</option><option value="J1">J리그1</option></select></label>
      <label><span>팀 선택</span><select value={draft.team ?? ""} onChange={(event) => setDraft((value) => ({ ...value, team: event.target.value || null }))}><option value="">전체 팀</option>{teams.map((team) => <option key={team.key} value={team.key}>{team.name}</option>)}</select></label>
      <div className="date-filter"><label><span>시작일</span><input type="date" value={draft.from} onChange={(event) => setDraft((value) => ({ ...value, from: event.target.value }))} /></label><i>—</i><label><span>종료일</span><input type="date" value={draft.to} onChange={(event) => setDraft((value) => ({ ...value, to: event.target.value }))} /></label></div>
      <div className="filter-actions"><button type="button" className="search-filter" onClick={applyFilters}>조회</button><button type="button" className="reset-filter" onClick={resetFilters}>초기화</button></div>
    </div>
    {error && <p className="odds-error" role="status">{error}</p>}
    <div className="odds-result-meta" role="status"><p>저장 기록 <strong>{payload?.pagination.total ?? 0}</strong>경기</p><span>{syncStatusText(sync, payload?.archive)}</span></div>
    <p className="odds-exclusions">취소 {payload?.excludedCounts.cancelled ?? 0} · 미정 {payload?.excludedCounts.pendingResult ?? 0} · 배당누락 {payload?.excludedCounts.missingOdds ?? 0} · 팀매칭실패 {payload?.excludedCounts.teamMatchFailed ?? 0}</p>
    {applied.team && <small className="odds-exclusion-help">팀매칭실패는 특정 팀에 안전하게 귀속할 수 없어 전체 팀에서만 집계됩니다.</small>}
    <div className="odds-grid-wrap"><table className="odds-grid"><thead><tr><th>경기일</th><th>리그</th><th>홈팀</th><th>원정팀</th><th>경기결과</th><th>승 배당</th><th>무 배당</th><th>패 배당</th></tr></thead><tbody>
      {payload?.records.map((record) => <tr key={record.sourceKey}><td><time>{formatHistoryDate(record.date)}</time><small>회차 {record.round}</small></td><td>{record.leagueName}</td><td><strong>{record.homeTeam}</strong><small>Betman 원문: {record.betmanHomeTeam}</small></td><td><strong>{record.awayTeam}</strong><small>Betman 원문: {record.betmanAwayTeam}</small></td><td><strong className={`result-badge result-${record.result.toLowerCase()}`}>{record.score.home}–{record.score.away}<small>{resultLabel(record.result)}</small></strong></td><td className={record.result === "H" ? "odd-hit odd-hit-h" : ""}>{record.odds.home.toFixed(2)}</td><td className={record.result === "D" ? "odd-hit odd-hit-d" : ""}>{record.odds.draw.toFixed(2)}</td><td className={record.result === "A" ? "odd-hit odd-hit-a" : ""}>{record.odds.away.toFixed(2)}</td></tr>)}
      {payload && payload.records.length === 0 && <tr><td className="no-results" colSpan={8}>선택한 조건에 해당하는 확정 경기가 없습니다.</td></tr>}
    </tbody></table></div>
    <nav className="odds-pagination" aria-label="배당기록 페이지"><button type="button" onClick={() => changePage(1)} disabled={!canGoPrevious(payload)}>처음</button><button type="button" onClick={() => changePage(applied.page - 1)} disabled={!canGoPrevious(payload)}>이전</button>{pageWindow(applied.page, payload?.pagination.totalPages ?? 0).map((item, index) => item === "ellipsis" ? <span key={`e-${index}`}>…</span> : <button type="button" key={item} aria-current={item === applied.page ? "page" : undefined} onClick={() => changePage(item)}>{item}</button>)}<button type="button" onClick={() => changePage(applied.page + 1)} disabled={!canGoNext(payload)}>다음</button><button type="button" onClick={() => changePage(payload?.pagination.totalPages || 1)} disabled={!canGoNext(payload)}>마지막</button></nav>
  </section>;
}

export default OddsHistory;
```

Define local helpers `changeLeague`, `applyFilters`, `resetFilters`, and `changePage` with `useCallback` or ordinary closures. `applyFilters` calls the shared validator before setting page 1; `changeLeague` calls `reconcileHistoryTeam`; `changePage` uses `fetchOddsHistoryPage` and, when an out-of-range response has `totalPages>0`, requests that last page once. Pure helpers `syncStatusText`, `formatHistoryDate`, `resultLabel`, `canGoPrevious`, and `canGoNext` must be exported for the view test. `syncStatusText` gives cooldown time precedence over generic partial status and formats it in `Asia/Seoul`.

Move all odds archive state and markup out of `app/page.tsx`; delete `OddsRecord`, `oddsRecords`, `oddsTeams`, `filteredOdds`, the sample footnote, and old odds filter state. Mount `<OddsHistory />`. Change the header source badge to:

```tsx
<div className="demo-pill"><span />{
  section === "matches" || section === "standings" ? `API-Football · ${seasonSummary}`
    : section === "odds" ? "Betman 마감게임 · D1 아카이브" : "D1 저장 데이터"
}</div>
```

Render canonical team names visibly and `Betman 원문: {raw}` in `<small>`. Render only `records`, highlight the result odds cell, use `role="status"` for sync/errors, show four exclusion counts in fixed order, explain team-match-failed counting when a team is selected, and display `nextPendingRetryAt` in Asia/Seoul without scheduling a retry.

- [ ] **Step 4: Run UI, render, type, and lint checks and verify they pass**

Run: `npx.cmd tsx --test tests/odds-history-view.test.ts tests/odds-history-client.test.ts && npm.cmd run build && node --test tests/rendered-html.test.mjs && npm.cmd run lint`

Expected: all commands exit 0; built HTML contains the real archive source copy and no sample/demo copy.

- [ ] **Step 5: Commit the UI**

```bash
git add app/odds-history.tsx app/page.tsx app/globals.css tests/odds-history-view.test.ts tests/rendered-html.test.mjs
git commit -m "feat: replace sample odds history UI"
```

### Task 10: Read-only harness, operational docs, and full regression gate

**Files:**
- Modify: `harness/src/suites/contracts.mjs`
- Modify: `harness/src/suites/smoke.mjs`
- Modify: `README.md`
- Modify: `docs/PRODUCT.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DATA-SOURCES.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/ROADMAP.md`

**Interfaces:**
- Consumes: final `GET /api/odds-history` response, existing package scripts, and all implementation tasks.
- Produces: `assertOddsHistoryContract(data)` in the harness; GET-only smoke coverage; user/operator documentation matching the final routes, D1 model, cooldown, and failure modes.

- [ ] **Step 1: Write the failing harness contract assertions**

```js
export function assertOddsHistoryContract(data) {
  invariant(isObject(data.query) && data.query.pageSize === 30, "odds history query/page size is invalid.");
  invariant(Array.isArray(data.teams) && Array.isArray(data.records), "odds history arrays are required.");
  invariant(isObject(data.pagination) && isObject(data.excludedCounts) && isObject(data.archive), "odds history metadata is required.");
  for (const record of data.records) {
    invariant(["K1", "J1"].includes(record.leagueCode), "unsupported odds history league.");
    invariant(["H", "D", "A"].includes(record.result), "final result is required.");
    invariant(record.odds.home > 0 && record.odds.draw > 0 && record.odds.away > 0, "three positive final odds are required.");
    invariant(isNonEmptyString(record.homeTeam) && isNonEmptyString(record.betmanHomeTeam), "canonical and raw team names are required.");
  }
}
```

Add `/api/odds-history` to smoke and call `assertOddsHistoryContract` in contracts. Do not call `POST /api/odds-history/sync` from the harness.

- [ ] **Step 2: Run the harness unit tests and verify they fail before wiring**

Run: `node --test harness/test/*.test.mjs`

Expected: FAIL until the new assertion is exported, invoked, and the GET path is added to smoke expectations.

- [ ] **Step 3: Write the minimal harness wiring and exact operational documentation**

```js
await report.check("contracts", "stored odds history response contract", async () => {
  const { body } = await client.json("/api/odds-history");
  assertOddsHistoryContract(body);
  return `${body.pagination.total} finalized match(es)`;
});
```

Document these exact facts across the mapped files: `GET /api/odds-history` reads D1; `POST /api/odds-history/sync` reads anonymous Betman G101 closed games; K1/J1 normal match-winner only; 30 rows; five rounds/two details; 30-minute `PENDING` cooldown; `FINAL` immutability; four exclusion counters; current `/api/betman-odds` unchanged; live smoke is read-only and prints metadata only.

- [ ] **Step 4: Run the complete test gate and verify it passes**

Run: `npm.cmd run typecheck`

Expected: exit 0.

Run: `npm.cmd run lint`

Expected: exit 0 with no errors.

Run: `npm.cmd run build`

Expected: exit 0 and Vinext writes the production bundle.

Run: `npm.cmd run test:unit`

Expected: all TypeScript unit tests pass.

Run: `node --test tests/rendered-html.test.mjs harness/test/*.test.mjs`

Expected: all rendered HTML and harness tests pass.

Run against a locally started build: `node harness/src/cli.mjs --base-url http://127.0.0.1:3000`

Expected: smoke/data/contracts suites pass; all harness requests remain GET-only.

Run: `npm.cmd run test:betman-history-smoke`

Expected: one or zero recent G101 round metadata records, no cookie/body output, and no write or purchase request. A provider/network block must be reported separately and cannot be represented as a product test pass.

Finally run: `git diff --check && git status --short`

Expected: no whitespace errors; only files listed in this plan are modified for F-001.

- [ ] **Step 5: Commit harness and documentation**

```bash
git add harness/src/suites/contracts.mjs harness/src/suites/smoke.mjs README.md docs/PRODUCT.md docs/ARCHITECTURE.md docs/DATA-SOURCES.md docs/OPERATIONS.md docs/ROADMAP.md
git commit -m "docs: document Betman odds history operations"
```

After this commit, record the final implementation commit SHA and every verification command/result for the separate test task. Do not merge, push, archive, or change feature scope without the leading task's approval.
