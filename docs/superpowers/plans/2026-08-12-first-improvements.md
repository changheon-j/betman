# 1차 안정성 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Betman 게임유형을 안정적으로 식별해 확률 오연결을 막고, 사용자 주도 URL 교체·엄격한 저장 검증·Windows/TypeScript 개발환경을 완성한다.

**Architecture:** Betman 파싱과 저장 입력 검증을 순수 TypeScript 모듈로 분리해 Node 테스트에서 직접 검증한다. D1에는 회차와 Betman 게임번호를 nullable 열로 추가해 기존 데이터는 보존하고, 신규 데이터만 안정적인 키를 사용한다. URL 교체는 PUT 요청에서 정상 응답 구조를 확인한 뒤 수행하며 빈 배당 배열은 정상으로 취급한다.

**Tech Stack:** Next.js 16, React 19, TypeScript, vinext/Vite, Cloudflare D1, Drizzle ORM, Node test runner, tsx

## Global Constraints

- Betman URL은 사용자가 저장 버튼을 누른 경우에만 교체한다.
- 정상 Betman 응답의 경기·배당 0건은 유효한 회차다.
- 응답 구조가 잘못되거나 외부 요청이 실패하면 기존 URL을 유지한다.
- 기존 저장 레코드는 조회·삭제 가능 상태로 보존한다.
- 기존 레코드에 회차나 게임번호를 추론해 채우지 않는다.
- 사용자 인증과 사용자별 데이터 분리는 이번 범위에서 제외한다.
- 구현은 실패 테스트를 먼저 확인한 뒤 최소 코드로 통과시킨다.

---

## File Structure

- Create `app/lib/market-prediction.ts`: 저장 키 생성과 저장 요청의 엄격한 파싱·검증
- Create `app/lib/betman-parser.ts`: Betman 응답 envelope 검증과 경기·시장 파싱
- Create `tests/market-prediction.test.ts`: 저장 키와 입력 검증 회귀 테스트
- Create `tests/betman-parser.test.ts`: 빈 배당 허용과 구조 오류 회귀 테스트
- Modify `app/api/market-predictions/route.ts`: 검증 모듈 사용, 신규 열 저장·조회
- Modify `app/api/betman-odds/route.ts`: 파서 모듈 사용, 구조 검증 후 사용자 PUT만 교체
- Modify `app/page.tsx`: 회차·게임번호 기반 입력 상태와 복원
- Modify `db/schema.ts`: `betmanRound`, `matchSeq` nullable 열 추가
- Create `drizzle/0003_*.sql` and metadata: 기존 데이터를 보존하는 열 추가 마이그레이션
- Modify `package.json`, `package-lock.json`, `tsconfig.json`: 크로스플랫폼 명령, typecheck, 테스트 도구와 Workers 타입
- Modify `app/api/fixtures/route.ts`: H2H 실패 반환 타입 정리
- Modify `harness/src/*`, `harness/test/*`: 신규 저장 계약과 엄격한 날짜 검증
- Modify `README.md`, `docs/*.md`: 동작·데이터·운영 문서 동기화

---

### Task 1: Windows 실행과 TypeScript 검사 기반 정비

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `app/api/fixtures/route.ts:345-354`
- Modify: `app/api/market-predictions/route.ts:92`

**Interfaces:**
- Produces: `npm run typecheck`, Windows에서 동작하는 `npm run dev|build|start|test`

- [ ] **Step 1: 현재 실패를 재현한다**

Run:

```powershell
npm.cmd run build
npx.cmd tsc --noEmit --incremental false
```

Expected: 첫 명령은 `WRANGLER_LOG_PATH` 구문 오류, 두 번째 명령은 Cloudflare 타입과 `fixtures/route.ts:354` 타입 오류로 실패한다.

- [ ] **Step 2: 크로스플랫폼 스크립트와 타입 의존성을 추가한다**

`package.json` scripts를 다음 계약으로 변경한다.

```json
{
  "dev": "vinext dev",
  "build": "vinext build",
  "start": "vinext start",
  "typecheck": "tsc --noEmit --incremental false",
  "test:unit": "tsx --test tests/*.test.ts",
  "test": "npm run typecheck && npm run build && npm run test:unit && node --test tests/rendered-html.test.mjs"
}
```

Install:

```powershell
npm.cmd install --save-dev @cloudflare/workers-types tsx
```

`tsconfig.json`의 `compilerOptions.types`를 `["@cloudflare/workers-types", "node"]`로 설정한다. Wrangler 경로 설정은 이미 `vite.config.ts`가 크로스플랫폼 방식으로 처리하므로 npm scripts에서 제거한다.

- [ ] **Step 3: 실제 TypeScript 오류를 최소 수정한다**

H2H mapper의 반환 타입을 `readonly [string, ApiFixture[]]`로 명시하고 실패 값은 `[] as ApiFixture[]`로 반환한다. D1 조회 행에는 다음 타입을 지정한다.

```ts
type MarketPredictionRow = {
  prediction_key: string;
  match_id: number;
  match_date: string;
  kickoff_time: string;
  home_team: string;
  away_team: string;
  market_index: number;
  market_type: string;
  market_condition: string;
  options_json: string;
  probability_sum: number;
  saved_at: string;
};
```

- [ ] **Step 4: 개발환경 검증을 통과시킨다**

Run:

```powershell
npm.cmd run typecheck
npm.cmd run build
```

Expected: 두 명령 모두 exit code 0.

---

### Task 2: 안정적인 시장 키와 엄격한 저장 입력 검증

**Files:**
- Create: `tests/market-prediction.test.ts`
- Create: `app/lib/market-prediction.ts`
- Modify: `app/api/market-predictions/route.ts`
- Modify: `db/schema.ts`
- Modify: `app/page.tsx`
- Create: `drizzle/0003_*.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `drizzle/meta/0003_snapshot.json`

**Interfaces:**
- Produces: `makePredictionKey({ matchId, betmanRound, matchSeq }): string`
- Produces: `parsePredictionInput(value: unknown): ParsedPredictionInput`
- `ParsedPredictionInput` includes `matchId`, `marketIndex`, `betmanRound`, `matchSeq`, match metadata and validated options.

- [ ] **Step 1: 저장 키와 입력 검증 실패 테스트를 작성한다**

`tests/market-prediction.test.ts`에 다음 행위를 검증한다.

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { makePredictionKey, parsePredictionInput } from "../app/lib/market-prediction.ts";

function validPredictionInput() {
  return {
    matchId: 1507028,
    matchDate: "2026-08-15",
    kickoffTime: "19:30",
    homeTeam: "광주 FC",
    awayTeam: "포항 스틸러스",
    marketIndex: 0,
    marketType: "축구 승무패",
    marketCondition: "-",
    betmanRound: "260095",
    matchSeq: "1654",
    options: [
      { label: "승", odds: 2.2, probability: 0.5 },
      { label: "패", odds: 2.8, probability: 0.5 },
    ],
  };
}

test("회차와 Betman 게임번호로 저장 키를 구분한다", () => {
  assert.equal(makePredictionKey({ matchId: 1507028, betmanRound: "260095", matchSeq: "1654" }),
    "fixture:1507028|round:260095|game:1654");
  assert.notEqual(
    makePredictionKey({ matchId: 1507028, betmanRound: "260095", matchSeq: "1654" }),
    makePredictionKey({ matchId: 1507028, betmanRound: "260096", matchSeq: "1654" }),
  );
});

test("숫자로 강제 변환되는 잘못된 입력을 거부한다", () => {
  const base = validPredictionInput();
  for (const matchId of [null, "", true, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parsePredictionInput({ ...base, matchId }), /matchId/);
  }
  assert.throws(() => parsePredictionInput({ ...base, options: [{ label: "승", odds: 2, probability: null }, { label: "패", odds: 2, probability: 1 }] }), /probability/);
});

test("존재하지 않는 날짜와 시간을 거부한다", () => {
  const base = validPredictionInput();
  assert.throws(() => parsePredictionInput({ ...base, matchDate: "2026-02-30" }), /matchDate/);
  assert.throws(() => parsePredictionInput({ ...base, kickoffTime: "24:00" }), /kickoffTime/);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run:

```powershell
npm.cmd run test:unit -- tests/market-prediction.test.ts
```

Expected: `app/lib/market-prediction.ts`가 없어서 실패한다.

- [ ] **Step 3: 순수 검증 모듈을 최소 구현한다**

`app/lib/market-prediction.ts`는 문자열을 trim하되 숫자는 변환하지 않는다. `Number.isSafeInteger`, 엄격한 날짜 round-trip, `HH:mm` 범위, 문자열 최대 길이, 중복 옵션 라벨과 확률합을 검증한다. 저장 키는 다음 구현을 사용한다.

```ts
export function makePredictionKey(input: StableMarketIdentity) {
  return `fixture:${input.matchId}|round:${input.betmanRound}|game:${input.matchSeq}`;
}
```

- [ ] **Step 4: 스키마와 API를 새 식별자로 연결한다**

Drizzle 스키마에 nullable 열을 추가한다.

```ts
betmanRound: text("betman_round"),
matchSeq: text("match_seq"),
```

`npm.cmd run db:generate`로 `ALTER TABLE ... ADD betman_round`와 `match_seq` 마이그레이션을 생성하고 내용을 검사한다. route의 신규 테이블 DDL, SELECT, INSERT, 응답에도 두 필드를 포함한다. POST는 `parsePredictionInput`의 결과만 저장한다.

- [ ] **Step 5: UI 상태와 복원을 안정적인 키로 교체한다**

현재 배당 입력 키는 다음 함수의 결과와 옵션 인덱스를 사용한다.

```ts
const marketKey = `${selected.id}-${betmanRound.gmTs}-${market.matchSeq}`;
const optionKey = `${marketKey}-${optionIndex}`;
```

POST body에 `betmanRound: betmanRound.gmTs`, `matchSeq: market.matchSeq`를 포함한다. 저장 레코드 복원은 두 값이 있고 저장 옵션 라벨 배열이 현재 옵션 라벨 배열과 정확히 같은 경우에만 수행한다. 레거시 레코드는 저장된경기 화면에서 조회·삭제만 가능하게 둔다.

- [ ] **Step 6: 테스트를 통과시킨다**

Run:

```powershell
npm.cmd run test:unit -- tests/market-prediction.test.ts
npm.cmd run typecheck
```

Expected: 모든 테스트와 typecheck 통과.

---

### Task 3: Betman 빈 배당 허용과 구조 오류 차단

**Files:**
- Create: `tests/betman-parser.test.ts`
- Create: `app/lib/betman-parser.ts`
- Modify: `app/api/betman-odds/route.ts`

**Interfaces:**
- Produces: `parseBetmanPayload(value: unknown): BetmanFixture[]`
- Throws: `Betman 응답 구조가 올바르지 않습니다.` when `compSchedules.keys/datas` are absent or not arrays.

- [ ] **Step 1: 빈 데이터와 구조 오류 테스트를 작성한다**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseBetmanPayload } from "../app/lib/betman-parser.ts";

test("정상 구조의 빈 배당은 허용한다", () => {
  assert.deepEqual(parseBetmanPayload({ compSchedules: { keys: [], datas: [] } }), []);
});

test("compSchedules가 없는 응답은 거부한다", () => {
  assert.throws(() => parseBetmanPayload({ result: "error" }), /응답 구조/);
});

test("keys 또는 datas가 배열이 아니면 거부한다", () => {
  assert.throws(() => parseBetmanPayload({ compSchedules: { keys: {}, datas: [] } }), /응답 구조/);
  assert.throws(() => parseBetmanPayload({ compSchedules: { keys: [], datas: null } }), /응답 구조/);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm.cmd run test:unit -- tests/betman-parser.test.ts`

Expected: 파서 모듈이 없어서 실패한다.

- [ ] **Step 3: 기존 파서를 순수 모듈로 이동하고 envelope 검증을 추가한다**

기존 `text`, `canonicalTeam`, 날짜 처리, row 확장, 시장 조건, fixture 그룹화를 모듈로 이동한다. `parseBetmanPayload`는 구조 검증 후 `datas: []`이면 빈 배열을 반환한다.

- [ ] **Step 4: URL 교체 순서를 보장한다**

PUT 처리 순서를 다음으로 유지한다.

```text
URL 문법 검증 → Betman 화면 요청 → 배당 응답 구조 검증 → D1 단일 슬롯 교체
```

빈 fixtures는 저장 성공으로 반환한다. 구조 오류나 외부 요청 실패 시 DB batch와 `roundCache` 할당을 실행하지 않는다. 자동 URL 갱신이나 시간 기반 URL 교체 코드는 추가하지 않는다.

- [ ] **Step 5: 파서 테스트와 전체 단위 테스트를 통과시킨다**

Run:

```powershell
npm.cmd run test:unit -- tests/betman-parser.test.ts
npm.cmd run test:unit
```

Expected: 모든 단위 테스트 통과.

---

### Task 4: 블랙박스 하네스 계약 강화

**Files:**
- Modify: `harness/src/assertions.mjs`
- Modify: `harness/src/suites/contracts.mjs`
- Modify: `harness/src/suites/data.mjs`
- Modify: `harness/test/assertions.test.mjs`
- Create: `harness/test/contracts.test.mjs`

**Interfaces:**
- Produces: 실제 존재하는 ISO 날짜 판정
- Produces: 저장 레코드의 nullable 레거시 필드 및 신규 안정 키 계약 검증

- [ ] **Step 1: 날짜와 저장 계약의 실패 테스트를 추가한다**

`isIsoDate("2026-02-30")`가 false이고 윤년 `2024-02-29`는 true임을 먼저 기대한다. 저장 레코드 테스트 fixture는 신규 레코드에 `betmanRound`, `matchSeq`가 있어야 하며 둘 중 하나만 있는 객체는 실패하도록 구성한다.

- [ ] **Step 2: 기존 테스트의 실패를 확인한다**

Run: `npm.cmd test` in `harness/`.

Expected: 존재하지 않는 날짜가 현재 true여서 실패한다.

- [ ] **Step 3: 엄격한 날짜와 저장 항목 계약을 구현한다**

날짜는 UTC 구성요소를 round-trip한다. 저장 레코드는 레거시 데이터의 두 필드가 모두 null/undefined인 경우와 신규 데이터의 두 필드가 모두 유효 문자열인 경우만 허용하고, prediction key·옵션·확률·배당·기대수익·저장시각을 검증한다.

- [ ] **Step 4: 팀 순위 연결 검사를 실제 팀 기준으로 강화한다**

standings를 `teamCode`와 rank로 매핑해 `match.homeCode/homeRank`, `awayCode/awayRank`가 같은 행을 가리키는지 검사한다. rank와 teamId 중복, 1부터 팀 수까지의 rank 범위도 검증한다.

- [ ] **Step 5: 하네스 검증을 통과시킨다**

Run:

```powershell
npm.cmd test
npm.cmd run all
```

Expected: 단위 테스트와 로컬 블랙박스 검증 모두 통과.

---

### Task 5: 사용자·개발 문서 동기화

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DATA-SOURCES.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/PRODUCT.md`
- Modify: `docs/ROADMAP.md`
- Modify: `harness/README.md`

**Interfaces:**
- Produces: 실제 코드와 동일한 저장 키, URL 교체, 빈 배당, 실행·검증 안내

- [ ] **Step 1: 문서의 기존 표현을 검색한다**

Run:

```powershell
rg -n "marketIndex|prediction_key|matchSeq|자동|교체|배당.*0건|WRANGLER_LOG_PATH|npm run build|TypeScript" README.md docs harness/README.md
```

- [ ] **Step 2: 제품·데이터·아키텍처 문서를 갱신한다**

다음 내용을 명시한다.

- 신규 키: `fixture:{경기ID}|round:{gmTs}|game:{matchSeq}`
- 기존 데이터는 조회·삭제 가능하지만 자동 복원하지 않음
- URL은 사용자가 저장할 때만 교체
- 정상 구조의 배당 0건은 허용하고 `현재 배당이 확정되지 않았습니다` 표시
- 구조 오류 시 기존 URL 유지
- 신규 열과 nullable 레거시 호환 정책

- [ ] **Step 3: 운영 명령을 실제 scripts와 맞춘다**

Windows와 macOS/Linux 모두 `npm run dev`, `npm run typecheck`, `npm run build`, `npm test`를 기본 명령으로 안내한다. 하네스 문서에는 읽기 전용 검증 범위와 신규 저장 계약을 반영한다.

- [ ] **Step 4: 문서 자체 검사를 수행한다**

Run:

```powershell
rg -n "match:\{경기ID\}.*market:|WRANGLER_LOG_PATH=.*vinext|배당.*반드시.*1건" README.md docs harness/README.md
git diff --check
```

Expected: 폐기된 키·Windows 비호환 명령·배당 필수 건수 표현이 없고 whitespace 오류가 없다.

---

### Task 6: 전체 회귀 검증

**Files:**
- Verify only

**Interfaces:**
- Consumes: Tasks 1-5의 코드, 마이그레이션, 테스트, 문서

- [ ] **Step 1: 정적 검사와 전체 테스트를 실행한다**

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
```

Expected: 모두 exit code 0.

- [ ] **Step 2: 로컬 앱의 읽기 전용 통합 검증을 실행한다**

```powershell
Set-Location harness
npm.cmd test
npm.cmd run all
```

Expected: 모든 하네스 검증 통과. PUT/POST/DELETE는 호출하지 않는다.

- [ ] **Step 3: 변경 범위와 마이그레이션을 점검한다**

```powershell
git status --short
git diff --check
git diff --stat
Get-Content drizzle/0003_*.sql
```

Expected: 요청 범위의 코드·테스트·문서와 기존 `harness/`만 변경되며, 마이그레이션은 기존 행을 삭제하지 않고 두 nullable 열만 추가한다.
