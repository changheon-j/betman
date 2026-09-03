# API-Football Match Winner 배당 표시 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 상세 경기에서 선택한 API-Football 북메이커의 Match Winner Home·Draw·Away 배당만 한 행으로 표시한다.

**Architecture:** 기존 `/api/pre-match-odds` 응답 계약과 캐시는 유지한다. `app/lib/pre-match-odds.ts`에 화면에서 재사용할 순수 선택 함수를 추가하고, `app/page.tsx`는 그 결과만 렌더링한다. 선택한 북메이커에 완전한 Match Winner 세 값이 없으면 전용 빈 상태를 표시한다.

**Tech Stack:** TypeScript, React 19, Vinext, Node test runner, CSS

## Global Constraints

- 북메이커 선택 기능을 유지한다.
- Match Winner 외 마켓은 화면에 표시하지 않는다.
- Home / Draw / Away를 고정 순서와 소수점 둘째 자리로 한 행에 표시한다.
- 세 값 중 하나라도 없으면 `Match Winner 배당이 제공되지 않습니다.`를 표시한다.
- API 응답 계약, 호출 주기, 30분 캐시, DB, Betman 기능은 변경하지 않는다.
- 사용자에게 서브에이전트를 설명할 때는 내부 식별자를 노출하지 않고 한글 역할명과 용도를 함께 표시한다.

---

## File Structure

- `app/lib/pre-match-odds.ts`: 정규화된 북메이커에서 완전한 Match Winner 세 값을 찾는 순수 함수와 타입을 제공한다.
- `tests/pre-match-odds.test.ts`: 마켓 필터링, 선택지 순서, 표기 차이, 불완전 데이터 거부를 검증한다.
- `app/page.tsx`: 선택한 북메이커의 Match Winner 결과 또는 전용 빈 상태를 렌더링한다.
- `app/globals.css`: 단일 행 배당 문자열과 빈 상태의 가독성을 조정한다.
- `README.md`, `docs/PRODUCT.md`, `docs/DATA-SOURCES.md`: 사용자 동작과 데이터 처리 범위를 현재 구현과 일치시킨다.

### Task 1: Match Winner 선택과 한 행 렌더링

**Files:**
- Modify: `app/lib/pre-match-odds.ts`
- Modify: `tests/pre-match-odds.test.ts`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Modify: `README.md`
- Modify: `docs/PRODUCT.md`
- Modify: `docs/DATA-SOURCES.md`

**Interfaces:**
- Consumes: `PreMatchOddsPayload["bookmakers"][number]`
- Produces: `matchWinnerOdds(bookmaker): { home: number; draw: number; away: number } | null`

- [ ] **Step 1: Write failing Match Winner selection tests**

Add the import and tests below to `tests/pre-match-odds.test.ts`. The production change these tests catch is accidental rendering of other markets, provider-order dependence, or display of an incomplete 1X2 market.

```ts
import {
  matchWinnerOdds,
  normalizePreMatchOdds,
  parseFixtureId,
  preMatchOddsForFixture,
} from "../app/lib/pre-match-odds.ts";

test("returns Match Winner odds in Home Draw Away order", () => {
  const bookmaker = {
    id: 6,
    name: "1xBet",
    markets: [
      { id: 5, name: "Goals Over/Under", values: [{ label: "Over 2.5", odds: 1.8 }] },
      {
        id: 1,
        name: " Match Winner ",
        values: [
          { label: "away", odds: 1.9 },
          { label: " HOME ", odds: 4.1 },
          { label: "Draw", odds: 3.35 },
        ],
      },
    ],
  };

  assert.deepEqual(matchWinnerOdds(bookmaker), { home: 4.1, draw: 3.35, away: 1.9 });
});

test("rejects missing or non-Match-Winner selections", () => {
  assert.equal(matchWinnerOdds({
    id: 1,
    name: "Bookmaker",
    markets: [{
      id: 1,
      name: "Match Winner",
      values: [{ label: "Home", odds: 2 }, { label: "Away", odds: 3 }],
    }],
  }), null);
  assert.equal(matchWinnerOdds({
    id: 1,
    name: "Bookmaker",
    markets: [{
      id: 5,
      name: "Goals Over/Under",
      values: [
        { label: "Home", odds: 2 },
        { label: "Draw", odds: 3 },
        { label: "Away", odds: 4 },
      ],
    }],
  }), null);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm.cmd exec tsx -- --test tests/pre-match-odds.test.ts`

Expected: FAIL because `matchWinnerOdds` is not exported.

- [ ] **Step 3: Implement the minimal pure selector**

Add the following public type and function to `app/lib/pre-match-odds.ts`:

```ts
export type MatchWinnerOdds = { home: number; draw: number; away: number };

function normalizeOddsLabel(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("en").replace(/\s+/g, "");
}

export function matchWinnerOdds(
  bookmaker: PreMatchOddsPayload["bookmakers"][number] | null | undefined,
): MatchWinnerOdds | null {
  const market = bookmaker?.markets.find((item) => normalizeOddsLabel(item.name) === "matchwinner");
  if (!market) return null;
  const byLabel = new Map(market.values.map((value) => [normalizeOddsLabel(value.label), value.odds]));
  const home = byLabel.get("home");
  const draw = byLabel.get("draw");
  const away = byLabel.get("away");
  return home === undefined || draw === undefined || away === undefined ? null : { home, draw, away };
}
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npm.cmd exec tsx -- --test tests/pre-match-odds.test.ts`

Expected: all tests in `tests/pre-match-odds.test.ts` PASS.

- [ ] **Step 5: Replace the multi-market table with the Match Winner row**

In `app/page.tsx`:

1. Import `matchWinnerOdds` with the existing pre-match helpers.
2. Derive `const selectedMatchWinnerOdds = matchWinnerOdds(selectedBookmaker);` beside `selectedBookmaker`.
3. Keep the existing bookmaker `<select>`.
4. Replace `selectedBookmaker?.markets.flatMap(...)` with this conditional rendering:

```tsx
{selectedMatchWinnerOdds ? (
  <div className="prematch-odds-wrap">
    <table className="prematch-odds-table prematch-match-winner-table">
      <thead><tr><th>마켓</th><th>Home / Draw / Away</th></tr></thead>
      <tbody><tr>
        <th scope="row">Match Winner</th>
        <td className="match-winner-odds">
          <strong>
            {selectedMatchWinnerOdds.home.toFixed(2)} / {selectedMatchWinnerOdds.draw.toFixed(2)} / {selectedMatchWinnerOdds.away.toFixed(2)}
          </strong>
        </td>
      </tr></tbody>
    </table>
  </div>
) : (
  <div className="prematch-odds-state">Match Winner 배당이 제공되지 않습니다.</div>
)}
```

This keeps the existing API loading, API error, and no-bookmaker branches unchanged.

- [ ] **Step 6: Adjust focused styles**

Add to `app/globals.css`:

```css
.prematch-match-winner-table tbody th { width:45%; }
.prematch-match-winner-table tbody td { text-align:left; }
.prematch-match-winner-table .match-winner-odds { font-variant-numeric:tabular-nums; white-space:nowrap; }
.prematch-match-winner-table .match-winner-odds strong { color:#155f3d; font-size:12px; letter-spacing:.2px; }
```

- [ ] **Step 7: Update user and data documentation**

Update the existing pre-match odds sections without changing cache or endpoint descriptions:

- `README.md`: selected bookmaker displays only Match Winner as `Home / Draw / Away` on one row.
- `docs/PRODUCT.md`: complete three-way odds are required; otherwise the dedicated empty message is shown.
- `docs/DATA-SOURCES.md`: this is a presentation filter over the normalized API response, not an API or storage contract change.

- [ ] **Step 8: Run complete verification**

Run:

```powershell
git diff --check
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
```

Expected: all commands exit 0; unit tests and rendered HTML test report zero failures.

- [ ] **Step 9: Verify the local API-backed screen**

With the existing local server running, select a fixture whose `/api/pre-match-odds` response has a bookmaker with Match Winner. Confirm that:

- only one Match Winner row appears;
- the value order is Home / Draw / Away;
- changing bookmaker updates the row;
- a bookmaker without a complete Match Winner market shows `Match Winner 배당이 제공되지 않습니다.`;
- no other pre-match market rows appear.

- [ ] **Step 10: Commit the implementation**

```powershell
git add app/lib/pre-match-odds.ts tests/pre-match-odds.test.ts app/page.tsx app/globals.css README.md docs/PRODUCT.md docs/DATA-SOURCES.md
git commit -m "feat: focus pre-match odds on Match Winner"
```
