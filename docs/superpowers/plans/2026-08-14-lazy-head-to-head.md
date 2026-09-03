# 선택 경기 기반 맞대결 지연 조회 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 경기 목록 API의 예정 경기별 맞대결 fan-out을 제거하고 사용자가 상세분석을 연 경기의 맞대결만 별도 API로 한 번 조회한다.

**Architecture:** 맞대결 입력 검증·정규화·공급자 1회 요청·fixture-scoped 표시 규칙을 `app/lib/head-to-head.ts`에 둔다. 신규 `GET /api/head-to-head`는 이 모듈을 사용해 30분 메모리 캐시를 제공하며, fixtures API는 일정·과거전적·순위만 조회한다. 클라이언트는 선택 경기 ID에 연결된 맞대결 상태만 렌더링한다.

**Tech Stack:** TypeScript, React 19, Vinext API routes, API-Football, Node test runner, black-box harness

## Global Constraints

- 최초 경기 목록 조회에서는 API-Football `fixtures/headtohead`를 호출하지 않는다.
- 상세경기를 명시적으로 선택한 경우에만 해당 경기 맞대결을 조회한다.
- 맞대결 공급자 요청은 cache miss당 정확히 한 번이며 자동 재시도하지 않는다.
- 맞대결 캐시는 서버 메모리에 1800초 유지하고 최대 100개 항목으로 제한한다.
- 맞대결은 선택 경기 kickoff 이전 완료 경기만 최신순 최대 10개 표시한다.
- 경기 전환 또는 상세 닫기 후 이전 경기의 결과·오류를 표시하지 않는다.
- rate-limit 공급자 오류는 HTTP 429, 기타 공급자 오류는 HTTP 502로 반환한다.
- Predictions, pre-match odds, Betman, 확률 저장, 순위와 최근 흐름 동작은 변경하지 않는다.
- `API_FOOTBALL_KEY`를 브라우저·응답·로그·문서·테스트에 노출하지 않는다.

---

## File Structure

- Create `app/lib/head-to-head.ts`: query 검증, 원본 경기 변환, 공급자 단일 요청, 현재 fixture 응답 선택.
- Create `tests/head-to-head.test.ts`: 검증·변환·단일 호출·오류 상태·fixture 격리 단위 테스트.
- Create `app/api/head-to-head/route.ts`: API 키, 30분/100개 캐시, HTTP 응답 경계.
- Modify `app/api/fixtures/route.ts`: 모든 H2H fan-out, concurrency와 retry 제거.
- Modify `app/lib/fixture-data.ts`: 목록 `Match`와 payload에서 H2H 필드 제거.
- Modify `tests/fixture-data.test.ts`: H2H 없는 fixtures 계약 검증.
- Modify `app/page.tsx`: 상세 선택 기반 맞대결 요청과 로딩·오류·빈 결과 UI.
- Modify `harness/src/suites/contracts.mjs`: 신규 H2H 응답 계약 추가, fixtures의 H2H 요구 제거.
- Modify `harness/src/suites/data.mjs`: 선택 fixture 한 건만 H2H 조회하고 데이터 규칙 검증.
- Modify `harness/test/contracts.test.mjs`, `harness/test/data.test.mjs`: 새 계약과 호출 흐름 회귀 테스트.
- Modify `README.md`, `docs/ARCHITECTURE.md`, `docs/DATA-SOURCES.md`, `docs/DECISIONS.md`, `docs/OPERATIONS.md`: 실제 호출 시점·캐시·운영 동작 기록.

---

### Task 1: 맞대결 도메인 모듈과 읽기 전용 API

**Files:**
- Create: `app/lib/head-to-head.ts`
- Create: `tests/head-to-head.test.ts`
- Create: `app/api/head-to-head/route.ts`

**Interfaces:**
- Produces: `HeadToHeadMatch`, `HeadToHeadQuery`, `HeadToHeadPayload`
- Produces: `parseHeadToHeadQuery(searchParams: URLSearchParams): HeadToHeadQuery`
- Produces: `buildHeadToHeadMatches(fixtures: ApiFixture[], query: HeadToHeadQuery): HeadToHeadMatch[]`
- Produces: `requestHeadToHead(query: HeadToHeadQuery, apiKey: string, fetcher?: typeof fetch): Promise<HeadToHeadMatch[]>`
- Produces: `headToHeadForFixture(selectedId: number | undefined, payload: HeadToHeadPayload | null): HeadToHeadMatch[] | null`
- Produces: `headToHeadErrorForFixture(selectedId: number | undefined, error: { fixtureId: number; message: string } | null): string`
- Produces: `GET /api/head-to-head?fixture=&home=&away=&kickoff=`

- [ ] **Step 1: Write failing validation and conversion tests**

Create `tests/head-to-head.test.ts` using `node:test` and `node:assert/strict`. Define completed fixtures with both orientations and assert:

```ts
test("parses a valid selected-fixture head-to-head query", () => {
  const query = parseHeadToHeadQuery(new URLSearchParams({
    fixture: "1507028",
    home: "2763",
    away: "2764",
    kickoff: "2026-08-16T10:00:00+00:00",
  }));
  assert.deepEqual(query, {
    fixtureId: 1507028,
    homeTeamId: 2763,
    awayTeamId: 2764,
    kickoffAt: "2026-08-16T10:00:00+00:00",
  });
});

test("rejects invalid fixture, equal teams, and non-ISO kickoff", () => {
  assert.throws(() => parseHeadToHeadQuery(new URLSearchParams({ fixture: "0", home: "1", away: "2", kickoff: "2026-08-16T10:00:00Z" })), /fixture/i);
  assert.throws(() => parseHeadToHeadQuery(new URLSearchParams({ fixture: "1", home: "2", away: "2", kickoff: "2026-08-16T10:00:00Z" })), /different/i);
  assert.throws(() => parseHeadToHeadQuery(new URLSearchParams({ fixture: "1", home: "2", away: "3", kickoff: "2026-08-16" })), /kickoff/i);
});
```

Add a conversion test with 12 completed fixtures, one post-kickoff fixture, one unfinished fixture, and both home/away orientations. Assert only the newest 10 pre-kickoff completed rows remain and W/D/L is calculated from selected fixture home team `homeTeamId`.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
npm.cmd exec tsx -- --test tests/head-to-head.test.ts
```

Expected: FAIL because `app/lib/head-to-head.ts` does not exist.

- [ ] **Step 3: Implement query validation and conversion**

Create `app/lib/head-to-head.ts`. Export these exact types:

```ts
export type HeadToHeadMatch = [string, boolean, string, "W" | "D" | "L"];

export type HeadToHeadQuery = {
  fixtureId: number;
  homeTeamId: number;
  awayTeamId: number;
  kickoffAt: string;
};

export type HeadToHeadPayload = {
  fixtureId: number;
  fetchedAt?: string;
  cacheSeconds?: number;
  matches: HeadToHeadMatch[];
};
```

Use a strict timezone-bearing ISO date-time expression and `Number.isSafeInteger`. `buildHeadToHeadMatches` must accept only `FT`, `AET`, `PEN` with non-null goals, require fixture time before `kickoffAt`, sort descending, slice 10, and retain the existing tuple format `YYYY.MM.DD`, orientation boolean, `home–away`, selected home-team result.

- [ ] **Step 4: Verify conversion GREEN**

Run the focused test again. Expected: validation and conversion tests PASS.

- [ ] **Step 5: Write failing single-request and error tests**

Add tests using an injected fetch function that counts calls:

```ts
const validQuery = {
  fixtureId: 1507028,
  homeTeamId: 2763,
  awayTeamId: 2764,
  kickoffAt: "2026-08-16T10:00:00+00:00",
};

test("requests API-Football head-to-head exactly once", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (input) => {
    calls += 1;
    assert.match(String(input), /fixtures\/headtohead\?h2h=2763-2764&last=20&timezone=Asia%2FSeoul/);
    return Response.json({ errors: [], response: [] });
  };
  const matches = await requestHeadToHead(validQuery, "secret", fetcher);
  assert.equal(calls, 1);
  assert.deepEqual(matches, []);
});
```

Add a fake `{ errors: { rateLimit: "Too many requests" }, response: [] }` response and assert the thrown error exposes status `429`; add a normal upstream HTTP failure and assert status `502`. Assert each fetcher was called once.

- [ ] **Step 6: Run and verify RED**

Expected: FAIL because `requestHeadToHead` and the provider error class do not exist.

- [ ] **Step 7: Implement the single provider request**

Implement `HeadToHeadProviderError extends Error` with public `status: 429 | 502`. `requestHeadToHead` calls `https://v3.football.api-sports.io/fixtures/headtohead` once, supplies only `x-apisports-key`, parses the body, maps `errors.rateLimit` to 429, other response/upstream errors to 502, and calls `buildHeadToHeadMatches`. Do not add retry, delay, loop, or concurrency logic.

- [ ] **Step 8: Add fixture-scoped state tests and implementation**

Test that a payload or error tagged with fixture 11 is returned for selected fixture 11 but returns `null`/empty string for fixture 22 or no selection. Implement `headToHeadForFixture` and `headToHeadErrorForFixture` minimally.

- [ ] **Step 9: Implement the API route**

Create `app/api/head-to-head/route.ts`:

- parse URL search params before reading the API key;
- return 400 for invalid input;
- cache by `fixtureId:homeTeamId:awayTeamId:kickoffAt` for 1800 seconds;
- cap the insertion-ordered Map at 100 entries by evicting the oldest key;
- call `requestHeadToHead` once on cache miss;
- return `{ fixtureId, fetchedAt, cacheSeconds: 1800, matches }`;
- return the provider error's 429 or 502 status without exposing the API key.

- [ ] **Step 10: Verify and commit Task 1**

Run:

```powershell
git diff --check
npm.cmd run typecheck
npm.cmd exec eslint -- app tests
npm.cmd exec tsx -- --test tests/head-to-head.test.ts
```

Commit only Task 1 files:

```powershell
git add app/lib/head-to-head.ts app/api/head-to-head/route.ts tests/head-to-head.test.ts
git commit -m "feat: add lazy head-to-head API"
```

---

### Task 2: Fixtures fan-out 제거와 상세 UI 연결

**Files:**
- Modify: `app/api/fixtures/route.ts`
- Modify: `app/lib/fixture-data.ts`
- Modify: `tests/fixture-data.test.ts`
- Modify: `app/lib/head-to-head.ts`
- Modify: `app/page.tsx`
- Modify: `harness/src/suites/contracts.mjs`
- Modify: `harness/src/suites/data.mjs`
- Modify: `harness/test/contracts.test.mjs`
- Modify: `harness/test/data.test.mjs`

**Interfaces:**
- Consumes: Task 1 `HeadToHeadPayload`, `headToHeadForFixture`, `headToHeadErrorForFixture`
- Consumes: `GET /api/head-to-head`
- Produces: fixtures payload without `Match.headToHead` and without `h2hFetchFailures`
- Produces: `headToHeadLoadingForFixture(selectedId, payload, error): boolean`
- Produces: detailed match UI with loading, empty, error, and fixture-scoped H2H states

- [ ] **Step 1: Write failing fixtures contract tests**

Update `tests/fixture-data.test.ts` fixtures to omit `headToHead` and fulfilled league results to omit `h2hFetchFailures`. Add assertions that merged payload has no `h2hFetchFailures` property and match rows have no `headToHead` property.

Change the desired `buildLeaguePayload` call to four arguments:

```ts
const payload = buildLeaguePayload(K1, upcoming, past, standings);
assert.equal("headToHead" in payload.matches[0], false);
```

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
npm.cmd exec tsx -- --test tests/fixture-data.test.ts
```

Expected: FAIL because the current function and payload still require H2H data.

- [ ] **Step 3: Remove H2H from fixture data building**

In `app/lib/fixture-data.ts`:

- remove local `HeadToHeadMatch` and `pairKey`;
- remove `Match.headToHead`;
- remove `LeaguePayload.h2hFetchFailures` and `FixturePayload.h2hFetchFailures`;
- remove `h2hByPair` from `buildLeaguePayload`;
- delete the H2H transformation block from each match;
- simplify `mergeLeaguePayloads` so it does not accumulate or return failure count.

- [ ] **Step 4: Remove fixtures route fan-out**

In `app/api/fixtures/route.ts` delete:

- `H2H_CONCURRENCY`, `H2H_MAX_ATTEMPTS`;
- `pairKey`, `wait`, `fetchApiWithRetry`, `mapWithConcurrency`;
- unique pair creation and every `/fixtures/headtohead` call;
- `h2hFetchFailures` handling.

Return `buildLeaguePayload(league, upcoming, past, extractOfficialStandings(standingResponses))` directly. Retain the two-league `Promise.allSettled`, upcoming/past/standings calls, partial-league response, and 10-minute fixtures cache.

- [ ] **Step 5: Verify fixtures GREEN**

Run `tests/fixture-data.test.ts`, typecheck, and lint. Expected: zero failures and no reference to `/fixtures/headtohead` under `app/api/fixtures/route.ts`.

- [ ] **Step 6: Write failing client state tests**

Extend `tests/head-to-head.test.ts` with observable state rules:

- no selection returns `null` and empty error;
- fixture 11 payload is hidden while fixture 22 is selected;
- fixture 11 error is hidden while fixture 22 is selected;
- matching fixture returns rows and matching error returns its message.

These tests should already exercise Task 1 helpers; if they pass, add the missing loading helper:

```ts
headToHeadLoadingForFixture(selectedId, payload, error)
```

Assert `true` only when a fixture is selected and neither matching payload nor matching error exists. Verify RED before implementing it.

- [ ] **Step 7: Implement selection-based client fetching**

In `app/page.tsx`:

- import Task 1 types/helpers;
- remove local `HeadToHeadMatch`, `Match.headToHead`, and `FixturePayload.h2hFetchFailures`;
- add `headToHead`, `headToHeadError` states tagged by fixture ID;
- in an effect keyed by selected ID/team IDs/kickoff, reset the current request state and return early with no fetch when no selection exists;
- request `/api/head-to-head` using `URLSearchParams` with `fixture`, `home`, `away`, `kickoff`;
- use `AbortController` or the existing cancellation pattern so stale responses do not apply;
- render only `headToHeadForFixture(selected?.id, headToHead)`;
- clear the H2H payload when a new selection starts and never render a payload for a different selected ID.

- [ ] **Step 8: Render exact H2H states**

In the existing recent H2H section:

- loading: `최근 맞대결을 불러오는 중입니다.`
- error: `최근 맞대결을 불러오지 못했습니다.`
- successful empty: `최근 맞대결 기록이 없습니다.`
- success rows: retain existing date, venue orientation, teams, score and W/D/L row rendering.

Use an `aria-live="polite"` status container for loading/error/empty copy. Do not hide other detail sections on H2H error.

- [ ] **Step 9: Update black-box contracts first and verify RED**

In `harness/src/suites/contracts.mjs`:

- remove the requirement that each fixture has `headToHead`;
- export `assertHeadToHeadContract(data, fixtureId, kickoffDate)` validating fixture ID, ISO `fetchedAt`, `cacheSeconds === 1800`, maximum 10 rows, and each tuple's date/boolean/score/result.

Add `harness/test/contracts.test.mjs` fixtures for a valid payload and invalid fixture ID/result. Run harness tests and verify failure until the contract is implemented.

- [ ] **Step 10: Update the harness data flow**

In `harness/src/suites/data.mjs`, after fixtures succeed, choose at most the first fixture and call `/api/head-to-head` with its ID, team IDs and kickoff. Validate it with `assertHeadToHeadContract`. Remove iteration over every fixture's embedded H2H and remove the `h2hFetchFailures` assertion.

Update `harness/test/data.test.mjs` fake fixtures to include `kickoffAt`, `homeTeamId`, and `awayTeamId`. Update request assertions so the suite makes one H2H request for one selected fixture with those exact values, never one request per fixture. Keep all harness methods GET-only.

- [ ] **Step 11: Verify and commit Task 2**

Run:

```powershell
git diff --check
npm.cmd run typecheck
npm.cmd exec eslint -- app tests harness
npm.cmd exec tsx -- --test tests/fixture-data.test.ts tests/head-to-head.test.ts tests/fixture-workspace.test.ts
Push-Location harness; npm.cmd test; Pop-Location
```

Commit:

```powershell
git add app/api/fixtures/route.ts app/lib/fixture-data.ts tests/fixture-data.test.ts app/lib/head-to-head.ts app/page.tsx harness/src/suites/contracts.mjs harness/src/suites/data.mjs harness/test/contracts.test.mjs harness/test/data.test.mjs tests/head-to-head.test.ts
git commit -m "feat: load head-to-head on fixture selection"
```

---

### Task 3: 문서 동기화와 전체 검증

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DATA-SOURCES.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/OPERATIONS.md`

**Interfaces:**
- Consumes: Task 1 `/api/head-to-head` contract
- Consumes: Task 2 fixtures contract and client states
- Produces: current implementation matching documentation

- [ ] **Step 1: Update user and architecture documentation**

Document these exact facts:

- fixtures cold 조회는 리그별 upcoming/past/standings, 일반적으로 총 6회이며 H2H fan-out이 없다;
- 상세 선택 시 H2H, Predictions, pre-match odds가 각각 cache miss일 때 한 번 호출된다;
- H2H는 30분 메모리 캐시, 최대 100개, DB 비저장이다;
- H2H는 자동 재시도하지 않고 rate-limit은 해당 상세 영역 오류로만 표시한다;
- fixtures는 10분, Predictions는 10분, pre-match odds는 30분이라는 기존 정책을 유지한다.

Add a decision:

```markdown
## DEC-011: 맞대결은 상세 선택 시 지연 조회

- 상태: 채택
- 날짜: 2026-08-14
- 결정: 경기 목록에서는 맞대결을 조회하지 않고, 상세경기를 선택한 경우에만 해당 팀 조합을 한 번 조회해 30분 캐시한다. rate-limit 오류는 자동 재시도하지 않는다.
- 이유: 한 번의 목록 조회가 예정 경기 수만큼 공급자 호출을 만드는 fan-out과 순간 호출 제한 초과를 제거한다.
```

- [ ] **Step 2: Remove stale documentation claims**

Search current user docs, excluding historical superpowers specs/plans, for claims that fixtures embed H2H or fetch H2H for all fixtures:

```powershell
rg -n "h2hFetchFailures|headToHead|모든.*맞대결|fixtures.*맞대결|맞대결.*fixtures" README.md docs harness -g "!docs/superpowers/**"
```

Every remaining match must describe the new selected-fixture behavior or the new response contract.

- [ ] **Step 3: Run fresh full verification**

Run:

```powershell
git diff --check
npm.cmd run typecheck
npm.cmd exec eslint -- app tests harness
npm.cmd test
Push-Location harness; npm.cmd test; Pop-Location
```

Expected: typecheck, lint, Vinext build, all unit tests, rendered HTML test, and all harness tests exit 0.

- [ ] **Step 4: Live local verification**

With external API access and a cold server process:

1. Open `/` and confirm the list loads without any `head-to-head` browser request.
2. Select one fixture and confirm exactly one `/api/head-to-head` browser request.
3. Confirm loading transitions to rows, empty, or isolated error copy.
4. Select a second fixture and confirm the first fixture's rows never appear in the second detail.
5. Close detail and confirm no new H2H request occurs.
6. Reopen the same fixture within 30 minutes and confirm the server returns the cached payload.

- [ ] **Step 5: Commit documentation**

```powershell
git add README.md docs/ARCHITECTURE.md docs/DATA-SOURCES.md docs/DECISIONS.md docs/OPERATIONS.md
git commit -m "docs: document lazy head-to-head loading"
```
