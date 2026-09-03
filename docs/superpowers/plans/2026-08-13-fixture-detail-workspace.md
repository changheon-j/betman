# 경기 목록·상세분석 작업공간 및 전체 북메이커 표시 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 경기 메뉴를 최초 전체 목록과 선택 후 독립 스크롤 상세 작업공간으로 전환하고, API-Football 모든 북메이커의 Match Winner 배당을 한 표에 표시한다.

**Architecture:** 선택 경기 계산과 경기 데이터 갱신 시 선택값 정리는 순수 모듈로 분리한다. `app/page.tsx`는 명시적 경기 선택만 상세 API 호출 조건으로 사용하고, 목록·상세 상태에 따른 레이아웃과 포커스를 조정한다. 사전배당 전용 컴포넌트는 기존 `matchWinnerOdds`를 각 북메이커에 적용해 완전한 배당 또는 `미제공`을 렌더링한다.

**Tech Stack:** TypeScript, React 19, Vinext, CSS, Node test runner, ReactDOMServer

## Global Constraints

- 최초 접속은 예정경기 목록만 전체 폭으로 표시하고 첫 경기를 자동 선택하지 않는다.
- 경기 선택 시 데스크톱은 왼쪽 목록과 오른쪽 상세분석을 반반 화면으로 표시한다.
- 상세 상태의 두 패널은 각각 독립 스크롤하며 마우스가 올라간 패널만 스크롤한다.
- 상세분석 우측 상단 `×` 버튼은 접근성 이름 `상세분석 닫기`를 가지며 목록 상태로 복귀한다.
- 1050px 이하에서는 목록 상태와 상세 상태를 한 화면씩 전환한다.
- 선택 경기가 없으면 Predictions와 API-Football 사전배당을 호출하지 않는다.
- 북메이커 선택상자를 제거하고 API가 반환한 모든 업체를 응답 순서대로 표시한다.
- 완전한 Match Winner는 Home / Draw / Away 순서와 소수점 둘째 자리로, 불완전한 업체는 `미제공`으로 표시한다.
- API 계약·호출 주기·30분 캐시·DB 비저장·Betman 기능은 변경하지 않는다.
- 기존 Betman 배당, 확률 저장, Predictions, 최근 흐름, 순위와 맞대결 내용을 변경하지 않는다.

---

## File Structure

- Create `app/fixture-workspace.ts`: 명시적 선택 경기 계산과 갱신 후 선택 ID 정리 순수 함수.
- Create `tests/fixture-workspace.test.ts`: 자동 첫 경기 선택 금지와 사라진 선택값 정리 검증.
- Create `app/analysis-close-button.tsx`: 상세분석 닫기 동작을 제공하는 접근 가능한 버튼.
- Create `tests/analysis-close-button.test.ts`: 닫기 버튼의 요소·이름·표시 문자를 정적 렌더링으로 검증.
- Modify `app/pre-match-match-winner.tsx`: 단일 북메이커 표시를 모든 북메이커 표로 확장.
- Modify `tests/pre-match-match-winner.test.ts`: 여러 업체, 고정 순서, 미제공과 선택상자 부재를 실제 정적 렌더링으로 검증.
- Modify `app/page.tsx`: 초기 선택·fallback 제거, 상세 열기·닫기·포커스, 전체 배당 컴포넌트 연결.
- Modify `app/globals.css`: 목록 전체 폭, 데스크톱 독립 스크롤, 닫기 버튼과 작은 화면 전환.
- Modify `README.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/DATA-SOURCES.md`, `docs/DECISIONS.md`: 현재 동작과 결정 기록.

---

### Task 1: 모든 북메이커 Match Winner 표

**Files:**
- Modify: `app/pre-match-match-winner.tsx`
- Modify: `tests/pre-match-match-winner.test.ts`
- Modify: `app/page.tsx:324-334, 414-434, 983-1006`
- Modify: `app/globals.css:108-112, 149`

**Interfaces:**
- Consumes: `PreMatchOddsPayload["bookmakers"]`, existing `matchWinnerOdds(bookmaker)`
- Produces: `PreMatchBookmakers({ bookmakers }: { bookmakers: PreMatchOddsPayload["bookmakers"] }): JSX.Element`

- [ ] **Step 1: Write failing multi-bookmaker rendering tests**

Replace the existing single-bookmaker tests in `tests/pre-match-match-winner.test.ts` with real static-render tests using this fixture shape:

```ts
const bookmakers = [
  {
    id: 6,
    name: "1xBet",
    markets: [{
      id: 1,
      name: "Match Winner",
      values: [
        { label: "Away", odds: 1.9 },
        { label: "Home", odds: 4.1 },
        { label: "Draw", odds: 3.35 },
      ],
    }],
  },
  {
    id: 8,
    name: "Bet365",
    markets: [{
      id: 1,
      name: "Match Winner",
      values: [{ label: "Home", odds: 2.1 }, { label: "Away", odds: 3.2 }],
    }],
  },
];
```

Assertions must verify observable output:

```ts
const html = renderToStaticMarkup(createElement(PreMatchBookmakers, { bookmakers }));
assert.match(html, /<th scope="row">1xBet<\/th><td class="match-winner-odds"><strong>4\.10 \/ 3\.35 \/ 1\.90<\/strong><\/td>/);
assert.match(html, /<th scope="row">Bet365<\/th><td class="match-winner-unavailable">미제공<\/td>/);
assert.equal((html.match(/<tbody>/g) ?? []).length, 1);
assert.doesNotMatch(html, /<select|<option/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd exec tsx -- --test tests/pre-match-match-winner.test.ts`

Expected: FAIL because `PreMatchBookmakers` is not exported or the existing component does not accept a bookmaker array.

- [ ] **Step 3: Implement the all-bookmaker component**

In `app/pre-match-match-winner.tsx`, import `matchWinnerOdds` and `PreMatchOddsPayload`, then implement one table:

```tsx
import { matchWinnerOdds, type PreMatchOddsPayload } from "./lib/pre-match-odds";

export function PreMatchBookmakers({
  bookmakers,
}: {
  bookmakers: PreMatchOddsPayload["bookmakers"];
}) {
  return (
    <div className="prematch-odds-wrap">
      <table className="prematch-match-winner-table">
        <thead><tr><th>북메이커</th><th>Home / Draw / Away</th></tr></thead>
        <tbody>
          {bookmakers.map((bookmaker) => {
            const odds = matchWinnerOdds(bookmaker);
            return (
              <tr key={bookmaker.id}>
                <th scope="row">{bookmaker.name}</th>
                {odds ? (
                  <td className="match-winner-odds"><strong>{odds.home.toFixed(2)} / {odds.draw.toFixed(2)} / {odds.away.toFixed(2)}</strong></td>
                ) : <td className="match-winner-unavailable">미제공</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

Remove the no-longer-used `PreMatchMatchWinner` export after updating its callers and tests.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm.cmd exec tsx -- --test tests/pre-match-match-winner.test.ts tests/pre-match-odds.test.ts`

Expected: all focused tests PASS.

- [ ] **Step 5: Replace select-state UI with the complete table**

In `app/page.tsx`:

- import `PreMatchBookmakers` instead of `PreMatchMatchWinner`;
- delete `selectedBookmakerId`, `setSelectedBookmakerId`, `selectedBookmaker`, and `selectedMatchWinnerOdds`;
- delete both resets/assignments of selected bookmaker state in the pre-match effect;
- preserve loading, error, and empty-bookmakers branches;
- replace the `<label className="bookmaker-select">` and single result with:

```tsx
<PreMatchBookmakers bookmakers={currentPreMatchOdds.bookmakers} />
```

- [ ] **Step 6: Update focused odds styles**

Delete `.bookmaker-select` styles and its mobile override. Keep the table scroll wrapper. Add an explicit unavailable style:

```css
.match-winner-unavailable { color:#929a95; font-weight:700; }
```

Keep `.match-winner-odds { white-space:nowrap; }` and the existing numeric emphasis.

- [ ] **Step 7: Run task verification and commit**

Run:

```powershell
git diff --check
npm.cmd run typecheck
npm.cmd exec eslint -- app tests
npm.cmd exec tsx -- --test tests/pre-match-match-winner.test.ts tests/pre-match-odds.test.ts
```

Expected: every command exits 0 and focused tests report zero failures.

Commit:

```powershell
git add app/pre-match-match-winner.tsx tests/pre-match-match-winner.test.ts app/page.tsx app/globals.css
git commit -m "feat: show all pre-match bookmakers"
```

---

### Task 2: 명시적 상세 선택과 독립 스크롤 작업공간

**Files:**
- Create: `app/fixture-workspace.ts`
- Create: `tests/fixture-workspace.test.ts`
- Create: `app/analysis-close-button.tsx`
- Create: `tests/analysis-close-button.test.ts`
- Modify: `app/page.tsx:1-7, 298-367, 683, 837-884`
- Modify: `app/globals.css:21-22, 57, 143-150`

**Interfaces:**
- Produces: `selectedFixture<T extends { id: number }>(matches: readonly T[], selectedId: number): T | null`
- Produces: `reconcileSelectedFixtureId<T extends { id: number }>(matches: readonly T[], selectedId: number): number`
- Consumes: Task 1's `PreMatchBookmakers`

- [ ] **Step 1: Write failing selection-state tests**

Create `tests/fixture-workspace.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { reconcileSelectedFixtureId, selectedFixture } from "../app/fixture-workspace.ts";

const matches = [{ id: 11, name: "First" }, { id: 22, name: "Second" }];

test("does not fall back to the first fixture when nothing is selected", () => {
  assert.equal(selectedFixture(matches, 0), null);
});

test("returns only the explicitly selected fixture", () => {
  assert.deepEqual(selectedFixture(matches, 22), matches[1]);
  assert.equal(selectedFixture(matches, 99), null);
});

test("keeps a valid selection and clears a fixture removed by refresh", () => {
  assert.equal(reconcileSelectedFixtureId(matches, 22), 22);
  assert.equal(reconcileSelectedFixtureId(matches, 99), 0);
  assert.equal(reconcileSelectedFixtureId([], 22), 0);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd exec tsx -- --test tests/fixture-workspace.test.ts`

Expected: FAIL because `app/fixture-workspace.ts` does not exist.

- [ ] **Step 3: Implement the pure selection helpers**

Create `app/fixture-workspace.ts`:

```ts
export function selectedFixture<T extends { id: number }>(matches: readonly T[], selectedId: number): T | null {
  return matches.find((match) => match.id === selectedId) ?? null;
}

export function reconcileSelectedFixtureId<T extends { id: number }>(matches: readonly T[], selectedId: number) {
  return selectedFixture(matches, selectedId)?.id ?? 0;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm.cmd exec tsx -- --test tests/fixture-workspace.test.ts`

Expected: all three tests PASS.

- [ ] **Step 5: Remove automatic selection and add selection reconciliation**

In `app/page.tsx`:

- import both helpers;
- keep `selectedId` initial value `0`;
- replace first-match fallback with `const selected = selectedFixture(matches, selectedId);`;
- after a successful fixture response, replace `setSelectedId(payload.matches[0]?.id ?? 0)` with:

```ts
setSelectedId((current) => reconcileSelectedFixtureId(payload.matches, current));
```

The existing Predictions and pre-match effects already return early when `selected?.id` is absent; retain their cancellation guards and state resets.

- [ ] **Step 6: Add explicit open, focus, and close behavior**

Use React refs in `app/page.tsx`:

```ts
const analysisPanelRef = useRef<HTMLElement | null>(null);
const lastDetailTriggerRef = useRef<HTMLButtonElement | null>(null);

function openMatchDetail(matchId: number, trigger: HTMLButtonElement) {
  lastDetailTriggerRef.current = trigger;
  setSelectedId(matchId);
}

function closeMatchDetail() {
  setSelectedId(0);
  requestAnimationFrame(() => lastDetailTriggerRef.current?.focus());
}
```

Add an effect keyed by `selected?.id` that focuses the analysis panel. At 1050px or below, call `scrollIntoView({ block: "start", behavior: "smooth" })`; otherwise call `.focus({ preventScroll: true })`.

Both the card's main button and `분석 보기` button call `openMatchDetail(match.id, event.currentTarget)`.

The analysis `<aside>` receives `ref={analysisPanelRef}`, `tabIndex={-1}`, and an accessibility label. Add this close button inside the existing top line:

```tsx
<button type="button" className="analysis-close" aria-label="상세분석 닫기" onClick={closeMatchDetail}>×</button>
```

- [ ] **Step 7: Apply list-only and detail-open layout modes**

On the fixtures view, derive the class from `selected`:

```tsx
<div className={`content-shell ${activeView === "fixtures" ? selected ? "detail-open" : "list-only" : ""}`}>
```

Keep non-fixture pages unchanged. CSS requirements:

```css
.content-shell.list-only { display:block; }
.list-only .match-column { width:100%; }
.content-shell.detail-open { align-items:stretch; }
.detail-open .match-column,
.detail-open .analysis-panel { max-height:calc(100dvh - 125px); overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; }
.detail-open .analysis-panel { position:relative; top:auto; }
.analysis-panel:focus { outline:none; }
.panel-topline { position:relative; }
.analysis-close { /* 32px square real button, top-right, visible focus style */ }
```

At `@media (max-width:1050px)`:

```css
.content-shell.detail-open { display:block; max-width:760px; }
.detail-open .match-column { display:none; }
.detail-open .analysis-panel { max-height:none; overflow:visible; }
```

The list-only mobile state continues to show `.match-column`. Do not use document-level wheel interception or synthetic wheel handlers.

- [ ] **Step 8: Add a structural close-control regression test**

Create `app/analysis-close-button.tsx`:

```tsx
export function AnalysisCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="analysis-close" aria-label="상세분석 닫기" onClick={onClose}>
      ×
    </button>
  );
}
```

Use this component in the detail panel. Create `tests/analysis-close-button.test.ts` with ReactDOMServer and assert the rendered HTML contains a real `button`, `aria-label="상세분석 닫기"`, and visible `×`. The pure selection tests from Steps 1–4 are the regression boundary proving that ID `0` produces no selected fixture, so `page.tsx` must conditionally omit the analysis `<aside>` when `selected` is null.

- [ ] **Step 9: Run task verification and commit**

Run:

```powershell
git diff --check
npm.cmd run typecheck
npm.cmd exec eslint -- app tests
npm.cmd exec tsx -- --test tests/fixture-workspace.test.ts tests/analysis-close-button.test.ts tests/pre-match-match-winner.test.ts tests/pre-match-odds.test.ts
```

Expected: all commands exit 0 with zero test failures.

Commit:

```powershell
git add app/fixture-workspace.ts tests/fixture-workspace.test.ts app/analysis-close-button.tsx tests/analysis-close-button.test.ts app/page.tsx app/globals.css
git commit -m "feat: add explicit fixture detail workspace"
```

---

### Task 3: 제품 문서와 통합 검증

**Files:**
- Modify: `README.md`
- Modify: `docs/PRODUCT.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DATA-SOURCES.md`
- Modify: `docs/DECISIONS.md`

**Interfaces:**
- Consumes: Task 1 `PreMatchBookmakers`, Task 2 explicit selection/detail workspace behavior
- Produces: documentation matching the shipped UI and data flow

- [ ] **Step 1: Update current behavior documentation**

Make these exact documentation changes:

- `README.md`: first screen is a full-width fixture list; selecting a fixture opens split detail; `×` returns to the list; all bookmakers appear together.
- `docs/PRODUCT.md`: define list state, desktop detail state, small-screen detail replacement, and per-bookmaker `미제공` behavior.
- `docs/ARCHITECTURE.md`: document explicit-selection gating for Predictions/pre-match odds, independent panel scrolling, and the `fixture-workspace`/all-bookmaker component boundaries.
- `docs/DATA-SOURCES.md`: all normalized bookmakers are displayed, but Match Winner can be missing per bookmaker; the API and cache contract are unchanged.
- `docs/DECISIONS.md`: add a dated decision explaining that automatic first-fixture selection was removed to reduce unsolicited detail API calls and prioritize schedule browsing.

- [ ] **Step 2: Verify documentation consistency**

Run:

```powershell
rg -n "자동 선택|첫 경기|북메이커 선택|select|Match Winner|미제공|독립 스크롤|상세분석 닫기" README.md docs
```

Expected: current docs do not claim a bookmaker select or automatic first-fixture detail; Match Winner, all-bookmaker display, and explicit selection are described consistently. Historical specs/plans may retain their original wording as implementation history.

- [ ] **Step 3: Run full verification**

Run:

```powershell
git diff --check
npm.cmd run typecheck
npm.cmd exec eslint -- app tests harness
npm.cmd test
Push-Location harness
npm.cmd test
Pop-Location
```

Expected: typecheck, app lint, build, all unit/render tests, and all harness tests exit 0. The known Node `module.register()` deprecation warning does not indicate a product failure.

- [ ] **Step 4: Verify live local behavior**

Run the app with external API access and verify in the local browser:

1. Reload `/`; confirm no fixture is selected and no detail panel appears.
2. Confirm the fixture list uses full content width.
3. Select a fixture; confirm desktop split view and detail focus.
4. Place the pointer over each panel and wheel; confirm only that panel scrolls.
5. Confirm the pre-match table shows every returned bookmaker and no select.
6. Confirm complete values use Home / Draw / Away and incomplete values show `미제공`.
7. Click `×`; confirm full-width list returns and keyboard focus returns to the triggering control.
8. At 1050px or below, confirm selection replaces the list with detail and `×` returns to the list.

- [ ] **Step 5: Commit documentation**

```powershell
git add README.md docs/PRODUCT.md docs/ARCHITECTURE.md docs/DATA-SOURCES.md docs/DECISIONS.md
git commit -m "docs: update fixture detail workflow"
```
