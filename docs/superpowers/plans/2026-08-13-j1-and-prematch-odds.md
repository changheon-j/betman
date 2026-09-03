# J리그1 및 API-Football 사전 배당 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** K리그1과 J리그1의 14일 예정 경기와 공식 순위를 함께 제공하고, 상세경기에서 저장하지 않는 API-Football pre-match odds를 표시한다.

**Architecture:** 서버의 리그 설정, 경기 데이터 조립, Betman 팀 매칭, 사전 배당 정규화를 각각 순수 모듈로 분리한다. `/api/fixtures`는 두 리그를 독립적으로 조회해 부분 성공을 허용하고, `/api/pre-match-odds`는 상세 선택 시에만 API-Football을 호출한다. 화면은 통합 경기 목록, 리그별 순위 탭, 별도 사전 배당 영역을 사용한다.

**Tech Stack:** TypeScript, React, vinext, Cloudflare Workers/Sites, API-Football v3, Node test runner, ESLint

> **Final correction (2026-08-13):** The original shared-calendar-year assumption is superseded. K1 uses the calendar year; J1 uses the season's ending-year API key with a July boundary. Thus 2026-27 J1 is `season=2027`, with `standings=true` and `odds=true`.

## Global Constraints

- K리그1은 API-Football league ID `292`, code `K1`을 사용한다.
- J리그1은 API-Football league ID `98`, code `J1`을 사용한다.
- 2026-27 J리그1은 API `season=2027`을 사용하고, 2026년 7~12월은 다음 연도 시즌 키로 해석한다.
- K리그1은 달력 연도를 시즌 키로 사용한다.
- 경기 목록 범위는 한국시간 오늘부터 14일 뒤까지다.
- 모든 화면 경기 시각은 `Asia/Seoul`로 표시한다.
- 순위는 API-Football 공식 `/standings` 응답을 사용하며 앱에서 재정렬하지 않는다.
- API-Football pre-match odds는 D1에 저장하지 않고 메모리에 30분만 캐시한다.
- Betman 연결은 리그, 날짜, 시작시간 15분 범위, 홈·원정 팀 ID 별칭이 모두 일치할 때만 허용한다.
- 문자열 유사도만으로 Betman 경기를 연결하지 않는다.
- 한 리그 조회 실패가 다른 리그 결과를 막지 않아야 한다.
- 기존 Betman URL 저장, 확률·기대수익 저장, 저장된 경기 조회·삭제 계약을 유지한다.
- 새 런타임 의존성을 추가하지 않는다.
- Windows 명령은 `npm.cmd`를 사용한다.

---

## 파일 구조

- `app/lib/leagues.ts`: 지원 리그 설정과 리그 코드 타입
- `app/lib/fixture-data.ts`: API-Football 경기·순위 타입과 순수 변환 함수
- `app/api/fixtures/route.ts`: 두 리그 외부 호출, H2H 수집, 부분 성공, 캐시
- `app/lib/pre-match-odds.ts`: odds 입력 검증과 응답 정규화
- `app/api/pre-match-odds/route.ts`: 읽기 전용 API-Football odds 프록시와 30분 캐시
- `app/lib/team-aliases.ts`: API 팀 ID 중심 K1/J1 별칭 레지스트리
- `app/lib/betman-matcher.ts`: Betman 경기와 API 경기의 결정적 매칭
- `app/page.tsx`: 통합 목록, 리그 배지, 순위 탭, 사전 배당 상태와 표시
- `app/globals.css`: 신규 배지·탭·사전 배당 스타일
- `tests/*.test.ts`: 순수 모듈 단위 테스트
- `harness/src/suites/*.mjs`: 다중 리그와 신규 API 읽기 전용 계약
- `README.md`, `docs/*.md`: 제품·구조·데이터·운영 문서

---

### Task 1: 다중 리그 경기와 공식 순위 API

**Files:**
- Create: `app/lib/leagues.ts`
- Create: `app/lib/fixture-data.ts`
- Modify: `app/api/fixtures/route.ts`
- Create: `tests/fixture-data.test.ts`

**Interfaces:**
- Produces: `type LeagueCode = "K1" | "J1"`
- Produces: `SUPPORTED_LEAGUES: readonly LeagueConfig[]`
- Produces: `mergeLeaguePayloads(results): FixturePayload`
- Produces response fields `matches`, `standingsByLeague`, `leagues` (each with its own `season`), `leagueErrors`, `today`, `rangeEnd`, `statsThrough`, `fetchedAt`, `h2hFetchFailures`
- Each match includes `leagueId`, `leagueCode`, `leagueName`, `kickoffAt`, `homeTeamId`, `awayTeamId`

- [ ] **Step 1: 지원 리그와 병합 계약의 실패 테스트 작성**

`tests/fixture-data.test.ts`에 다음을 검증한다.

```ts
assert.deepEqual(SUPPORTED_LEAGUES.map(({ id, code }) => ({ id, code })), [
  { id: 292, code: "K1" },
  { id: 98, code: "J1" },
]);

const merged = mergeLeaguePayloads([
  { status: "fulfilled", league: K1, matches: [lateMatch], standings: [kStanding], h2hFetchFailures: 0 },
  { status: "fulfilled", league: J1, matches: [earlyMatch], standings: [jStanding], h2hFetchFailures: 1 },
]);
assert.deepEqual(merged.matches.map((match) => match.id), [earlyMatch.id, lateMatch.id]);
assert.deepEqual(Object.keys(merged.standingsByLeague), ["K1", "J1"]);
```

부분 실패 입력에서는 성공 리그 데이터와 `leagueErrors.J1`이 함께 남는지 검증한다.

- [ ] **Step 2: 테스트가 미구현 export로 실패하는지 확인**

Run: `npm.cmd run test:unit -- tests/fixture-data.test.ts`  
Expected: FAIL because `app/lib/leagues.ts` or exported functions do not exist.

- [ ] **Step 3: 리그 설정과 순수 변환 모듈 구현**

`app/lib/leagues.ts`에 고정 설정을 만든다.

```ts
export type LeagueCode = "K1" | "J1";
export type LeagueConfig = { id: number; code: LeagueCode; name: string; apiName: string; seasonYear: "calendar" | "ending"; seasonStartMonth: number };
export const SUPPORTED_LEAGUES = [
  { id: 292, code: "K1", name: "K리그1", apiName: "K League 1", seasonYear: "calendar", seasonStartMonth: 1 },
  { id: 98, code: "J1", name: "J리그1", apiName: "J1 League", seasonYear: "ending", seasonStartMonth: 7 },
] as const satisfies readonly LeagueConfig[];
```

`fixture-data.ts`는 현재 route의 통계와 경기 변환을 옮기되 리그 설정을 인자로 받고, 공식 standings 행의 `rank`, `points`, `all.played/win/draw/lose/goals`, `goalsDiff`를 그대로 화면 계약으로 변환한다. 최근 5경기, 시즌 득실, 최근 맞대결은 기존 완료 경기/H2H 데이터로 유지한다.

- [ ] **Step 4: fixtures route를 리그별 독립 호출로 변경**

각 리그에 대해 예정 경기, 시즌 완료 경기, 공식 standings를 병렬 호출한다.

```text
/fixtures?league={id}&season={leagueSeason}&from={today}&to={rangeEnd}&timezone=Asia%2FSeoul
/fixtures?league={id}&season={leagueSeason}&from={leagueSeasonStart}&to={statsThrough}&timezone=Asia%2FSeoul
/standings?league={id}&season={leagueSeason}
```

리그 단위 작업은 `Promise.allSettled`로 합치고, 최소 한 리그가 성공하면 HTTP 200을 반환한다. 두 리그 모두 실패했을 때만 502를 반환한다. 공식 순위의 팀 ID로 상세경기의 `homeRank`/`awayRank`를 채운다. 성공한 부분 응답도 10분 캐시하되 `leagueErrors`를 포함한다.

- [ ] **Step 5: 단위 테스트와 기존 타입 검사 실행**

Run: `npm.cmd run test:unit`  
Expected: all unit tests PASS.

Run: `npm.cmd run typecheck`  
Expected: PASS.

- [ ] **Step 6: 커밋**

```powershell
git add app/lib/leagues.ts app/lib/fixture-data.ts app/api/fixtures/route.ts tests/fixture-data.test.ts
git commit -m "feat: add J1 fixtures and official standings"
```

---

### Task 2: API-Football pre-match odds 읽기 API

**Files:**
- Create: `app/lib/pre-match-odds.ts`
- Create: `app/api/pre-match-odds/route.ts`
- Create: `tests/pre-match-odds.test.ts`
- Modify: `cloudflare-env.d.ts` only if the existing environment declaration lacks `API_FOOTBALL_KEY`

**Interfaces:**
- Produces: `parseFixtureId(value: string | null): number`
- Produces: `normalizePreMatchOdds(fixtureId: number, response: unknown[]): PreMatchOddsPayload`
- Produces: `GET /api/pre-match-odds?fixture={id}`
- Payload contains `fixtureId`, `fetchedAt`, `cacheSeconds: 1800`, `bookmakers`

- [ ] **Step 1: 입력 및 정규화 실패 테스트 작성**

`tests/pre-match-odds.test.ts`에서 다음을 검증한다.

```ts
assert.equal(parseFixtureId("1507031"), 1507031);
for (const value of [null, "", "0", "-1", "1.5", "abc", "9007199254740992"]) {
  assert.throws(() => parseFixtureId(value), /fixture/);
}
assert.deepEqual(normalizePreMatchOdds(1, []), {
  fixtureId: 1,
  bookmakers: [],
});
```

실제 API 구조 모형에서 bookmaker ID/name, bet ID/name, value/odd가 숫자 배당으로 정규화되고 잘못된 배당은 제거되는지 검증한다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm.cmd run test:unit -- tests/pre-match-odds.test.ts`  
Expected: FAIL because the module does not exist.

- [ ] **Step 3: 순수 odds 정규화 구현**

외부 응답 `response[].bookmakers[].bets[].values[]`를 다음 계약으로 변환한다.

```ts
type PreMatchOddsPayload = {
  fixtureId: number;
  bookmakers: Array<{
    id: number;
    name: string;
    markets: Array<{
      id: number;
      name: string;
      values: Array<{ label: string; odds: number }>;
    }>;
  }>;
};
```

빈 response는 정상 빈 배열이다. 북메이커·마켓·선택지는 API 순서를 유지하고 중복 ID는 첫 번째 유효 항목만 사용한다.

- [ ] **Step 4: 읽기 전용 route와 30분 캐시 구현**

route는 `/odds?fixture={fixtureId}`를 호출한다. API-Football HTTP/응답 오류는 502, 잘못된 fixture는 400으로 반환한다. 캐시는 `Map<number, { expiresAt, payload, fetchedAt }>`이며 최대 100경기를 넘으면 가장 오래된 항목을 제거한다. DB와 `market_predictions`는 호출하지 않는다.

- [ ] **Step 5: 검증 및 커밋**

Run: `npm.cmd run test:unit`  
Run: `npm.cmd run typecheck`  
Expected: PASS.

```powershell
git add app/lib/pre-match-odds.ts app/api/pre-match-odds/route.ts tests/pre-match-odds.test.ts cloudflare-env.d.ts
git commit -m "feat: add on-demand pre-match odds API"
```

---

### Task 3: K1/J1 Betman 팀 별칭과 안전한 경기 매칭

**Files:**
- Create: `app/lib/team-aliases.ts`
- Create: `app/lib/betman-matcher.ts`
- Modify: `app/lib/betman-parser.ts`
- Create: `tests/betman-matcher.test.ts`
- Modify: `tests/betman-parser.test.ts`

**Interfaces:**
- Consumes API match fields `leagueCode`, `date`, `kickoffAt`, `homeTeamId`, `awayTeamId`
- Consumes `BetmanFixture` fields `leagueName`, `date`, `kickoffAt`, `homeTeam`, `awayTeam`
- Produces: `canonicalLeague(value: string): LeagueCode | null`
- Produces: `teamIdForAlias(league: LeagueCode, value: string): number | null`
- Produces: `findBetmanFixture(match, fixtures): BetmanFixture | undefined`

- [ ] **Step 1: J리그 한글 별칭과 오매칭 방지 테스트 작성**

테스트는 현재 API-Football `/teams?league=98&season=2027` 응답에서 확인한 팀 ID/영문명을 fixture로 고정하고, Betman에서 사용하는 한글 표기를 별칭으로 검증한다. 최소 다음 행위를 포함한다.

```ts
assert.equal(canonicalLeague("J1 League"), "J1");
assert.equal(canonicalLeague("일본 J리그"), "J1");
assert.equal(teamIdForAlias("J1", "가시마 앤틀러스"), 290);
assert.equal(teamIdForAlias("J1", "Kashima"), 290);
```

같은 날짜·시간이라도 한 팀이 불명확한 경우, 홈·원정이 뒤바뀐 경우, 16분 이상 차이, 다른 리그는 `undefined`인지 검증한다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm.cmd run test:unit -- tests/betman-matcher.test.ts`  
Expected: FAIL because matcher exports do not exist.

- [ ] **Step 3: 현재 2026-27 J리그1 팀 목록을 API `season=2027`로 확인해 별칭 레지스트리 작성**

API 팀 ID를 키로 사용하고 아래 2026-27 J리그1 팀과 한글 표기를 등록한다. 정규화된 같은 별칭이 같은 팀 ID에 반복되는 것은 허용하지만 다른 팀 ID와 충돌하면 초기화를 결정적으로 실패시킨다.

```text
316 Avispa Fukuoka = 아비스파 후쿠오카
291 Cerezo Osaka = 세레소 오사카
310 Fagiano Okayama = 파지아노 오카야마
292 FC Tokyo = FC 도쿄, FC도쿄
293 Gamba Osaka = 감바 오사카
301 JEF United Chiba = 제프 유나이티드 지바, 제프 지바
290 Kashima = 가시마 앤틀러스, 가시마
281 Kashiwa Reysol = 가시와 레이솔
294 Kawasaki Frontale = 가와사키 프론탈레
302 Kyoto Sanga = 교토 상가
303 Machida Zelvia = 마치다 젤비아
305 Mito Hollyhock = 미토 홀리호크
288 Nagoya Grampus = 나고야 그램퍼스
282 Sanfrecce Hiroshima = 산프레체 히로시마
283 Shimizu S-pulse = 시미즈 에스펄스
306 Tokyo Verdy = 도쿄 베르디
287 Urawa = 우라와 레즈, 우라와
289 Vissel Kobe = 비셀 고베
285 V-varen Nagasaki = V-바렌 나가사키, V바렌 나가사키
296 Yokohama F. Marinos = 요코하마 F. 마리노스, 요코하마 F마리노스
```

K리그 기존 정규화도 같은 레지스트리로 옮긴다. 정규화는 Unicode 정규화, 소문자, 공백·구두점 제거, 독립된 `fc` 접두·접미 차이만 처리한다. 유사도 또는 부분 포함 fallback은 만들지 않는다.

- [ ] **Step 4: 결정적 매처 구현 및 parser 책임 축소**

Betman parser는 원문 팀명과 정확한 kickoff를 보존한다. 매처는 `canonicalLeague`, 날짜, kickoff 차이 `<= 15분`, 양 팀 alias의 API 팀 ID가 모두 같을 때만 반환한다. 후보가 두 개 이상이면 반환하지 않는다.

- [ ] **Step 5: 검증 및 커밋**

Run: `npm.cmd run test:unit`  
Run: `npm.cmd run typecheck`  
Expected: PASS.

```powershell
git add app/lib/team-aliases.ts app/lib/betman-matcher.ts app/lib/betman-parser.ts tests/betman-matcher.test.ts tests/betman-parser.test.ts
git commit -m "feat: match Korean Betman names to K1 and J1 teams"
```

---

### Task 4: 통합 경기 목록, 순위 탭, 상세 사전 배당 UI

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Modify: `app/layout.tsx`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes Task 1 `/api/fixtures` response and Task 3 `findBetmanFixture`
- Consumes Task 2 `/api/pre-match-odds` response
- Produces K1/J1 unified match UI, league tabs, bookmaker selector and odds table

- [ ] **Step 1: 렌더링 계약 실패 테스트 갱신**

`tests/rendered-html.test.mjs`에서 제목과 로딩 문구가 두 리그를 포함하는지 확인한다.

```js
assert.match(html, /K리그1 · J리그1 경기 가이드/);
assert.match(html, /K리그1과 J리그1 경기 일정을 불러오는 중입니다/);
```

- [ ] **Step 2: UI 테스트 실패 확인**

Run: `node --test --test-name-pattern="renders" tests/rendered-html.test.mjs`  
Expected: FAIL on the old K League-only title/copy.

- [ ] **Step 3: page 응답 타입과 경기·순위 상태 변경**

`FixturePayload`를 `standingsByLeague`, `leagueErrors`, 리그별 `leagues[].season` 계약으로 바꾸고 `standingLeague` 상태 기본값을 `K1`로 둔다. 경기 목록에는 `match.leagueName` 배지를 추가한다. 전체 목록은 서버가 반환한 정렬을 유지한다. `leagueErrors`가 있으면 성공한 경기 목록 위에 비차단 `role=status` 경고를 표시하며, 성공 리그 일정이 0개여도 오류와 빈 일정을 구분한다.

- [ ] **Step 4: 상세 선택 기반 pre-match odds 상태 구현**

`selected.id`가 바뀔 때 다음 상태를 초기화하고 새 요청을 보낸다.

```ts
setPreMatchOdds(null);
setPreMatchOddsError("");
setPreMatchOddsLoading(true);
fetch(`/api/pre-match-odds?fixture=${selected.id}`);
```

effect cleanup의 cancellation guard로 이전 경기 응답을 무시한다. 첫 북메이커를 기본 선택하되 새 경기로 이동하면 선택을 초기화한다.

- [ ] **Step 5: 상세 배당과 순위 탭 마크업 구현**

기존 Betman 배당 아래에 `API-Football 사전 배당` 카드를 추가한다. 로딩, 오류, 빈 데이터, bookmaker selector, 선택 북메이커의 market/value 표를 각각 렌더링한다. 확률 입력·저장 버튼은 추가하지 않는다.

순위 메뉴 상단에 `K리그1`, `J리그1` 탭을 만들고 선택된 `standingsByLeague[standingLeague]`만 표시한다. 해당 리그 오류는 그 탭에서만 표시한다.

- [ ] **Step 6: 반응형·접근성 스타일 구현**

리그 배지는 텍스트를 포함하고 색상만으로 구분하지 않는다. 순위 탭은 `aria-pressed`, 북메이커 선택은 label을 제공한다. 모바일에서 odds 표는 가로 스크롤되며 기존 상세 카드 폭을 넘지 않는다.

- [ ] **Step 7: 검증 및 커밋**

Run: `npm.cmd run test:unit`  
Run: `npm.cmd test`  
Run: `npm.cmd run lint`  
Expected: PASS.

```powershell
git add app/page.tsx app/globals.css app/layout.tsx tests/rendered-html.test.mjs
git commit -m "feat: show J1 standings and pre-match odds"
```

---

### Task 5: 하네스와 전체 문서 업데이트

**Files:**
- Create: `harness/src/args.mjs`
- Modify: `harness/src/suites/smoke.mjs`
- Modify: `harness/src/suites/contracts.mjs`
- Modify: `harness/src/suites/data.mjs`
- Modify: `harness/test/contracts.test.mjs`
- Modify: `harness/README.md`
- Modify: `README.md`
- Modify: `docs/PRODUCT.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DATA-SOURCES.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/ROADMAP.md`

**Interfaces:**
- Consumes final `/api/fixtures`, `/api/pre-match-odds`, `/api/betman-odds` contracts
- Produces read-only regression coverage and current handoff documentation

- [ ] **Step 1: 하네스 실패 테스트 작성**

fixture contract가 `K1`, `J1` 리그 메타와 날짜에 맞는 각각의 시즌 키, `standingsByLeague`를 요구하고, 모든 match의 league code가 지원 집합에 있는지 검사한다. J1 standings가 있으면 한 개의 20팀 표와 고유 rank/team ID를 요구한다. CLI 테스트는 `--base-url URL`의 환경 변수 우선 적용, 프로필 보존, 알 수 없는/불완전/중복 인자 거부를 검증한다. pre-match odds contract는 fixture ID가 설정되면 호출하고, 빈 bookmakers도 정상으로 허용하며 유효 항목의 ID/name/positive odds를 검증한다.

- [ ] **Step 2: 하네스 테스트 실패 확인**

Run: `Set-Location harness; npm.cmd test`  
Expected: FAIL until suites understand the multi-league response.

- [ ] **Step 3: 읽기 전용 하네스 갱신**

smoke에 `/api/pre-match-odds`를 무조건 넣지 않는다. fixture ID가 확보된 뒤 contracts suite에서 읽기 전용 GET을 호출한다. `cli.mjs`는 프로필과 `--base-url URL`을 함께 파싱하고 잘못된 인자를 실행 전에 거부한다. data suite는 모든 경기 날짜가 공통 14일 범위인지, 각 standings 행이 자신의 리그 내에서 유일한 rank/team ID인지 검증한다.

- [ ] **Step 4: 사용자·운영 문서 전체 갱신**

설계 문서의 문서 변경 범위를 모두 반영한다. 특히 다음 수치를 명시한다.

```text
K1=292, J1=98, 경기 범위=14일, fixtures 캐시=10분,
pre-match odds 캐시=30분, Betman 시작시간 허용차=15분
```

J리그1 2026-27은 `season=2027`, `coverage.odds=true`임을 DATA-SOURCES와 OPERATIONS에 기록한다. `season=2026`, `odds=false`는 완료된 2026 전환 대회로 구분한다. coverage가 true여도 개별 경기의 빈 사전 배당은 정상일 수 있음을 유지하고, 별칭은 팀 ID와 확인된 표기만 등록하도록 설명한다.

- [ ] **Step 5: 전체 검증**

Run: `npm.cmd run typecheck`  
Run: `npm.cmd run lint`  
Run: `npm.cmd test`  
Run: `Set-Location harness; npm.cmd test`  
Run: `git diff --check`  
Expected: all PASS and no whitespace errors.

API 키가 설정된 로컬 서버에서 읽기 전용 하네스를 실행한다.

```powershell
Set-Location harness
npm.cmd run all -- --base-url http://127.0.0.1:5173
```

Expected: K1/J1 fixtures and standings contracts pass; pre-match odds may report zero bookmakers without failing.

- [ ] **Step 6: 커밋**

```powershell
git add README.md docs harness
git commit -m "docs: document J1 and pre-match odds integration"
```

---

## 최종 검증 체크리스트

- [ ] `/api/fixtures`가 두 리그 중 최소 한 리그 성공 시 HTTP 200을 반환한다.
- [ ] 경기 목록이 리그 구분 없이 한국시간 날짜·시각순으로 정렬된다.
- [ ] 모든 경기 카드에 리그 텍스트 배지가 있다.
- [ ] 순위 탭이 공식 K1/J1 순위를 각각 표시한다.
- [ ] 2026-08-13 기준 K1은 `season=2026`, J1은 `season=2027`이며 J1 공식 순위는 한 개의 20팀 표다.
- [ ] 리그 하나가 실패하면 성공 경기 목록 위에 부분 실패 경고가 표시된다.
- [ ] 상세 선택 전에는 pre-match odds 요청이 발생하지 않는다.
- [ ] 빈 odds 응답이 오류 화면이 아니라 정상 빈 상태로 보인다.
- [ ] J리그 Betman 한글 팀명이 확인된 alias로만 연결된다.
- [ ] 기존 K리그 Betman 배당과 확률 저장이 유지된다.
- [ ] 전체 문서와 하네스가 새 계약을 반영한다.
