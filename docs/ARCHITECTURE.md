# 아키텍처

## 구성

```text
Browser
  ├─ GET /api/fixtures
  ├─ GET /api/head-to-head?fixture={id}&home={homeId}&away={awayId}&kickoff={ISO8601}
  ├─ GET /api/predictions?fixture={id}
  ├─ GET /api/pre-match-odds?fixture={id}
  ├─ GET/PUT /api/betman-odds
  ├─ GET /api/odds-history → D1 archive
  ├─ POST /api/odds-history/sync → anonymous Betman G101 closed games → D1
  └─ GET/POST/PATCH/DELETE /api/market-predictions
       ↓
Next/Vinext routes → API-Football, Betman, Cloudflare D1
```

`app/page.tsx`는 UI 상태와 표시를 담당합니다. `app/fixture-workspace.ts`는 명시적으로 선택한 경기만 찾고, 새 fixtures 결과에 없는 선택은 `0`으로 정리합니다. 따라서 첫 fixtures 응답은 상세를 열지 않습니다. `app/analysis-close-button.tsx`는 접근 가능한 상세 닫기 버튼을, `app/pre-match-match-winner.tsx`는 모든 bookmaker의 Match Winner 표를 담당합니다. `app/api/fixtures/route.ts`는 두 리그의 일정·과거 경기·공식 standings를 병렬로 조회합니다. `app/lib/fixture-data.ts`는 리그별 결과를 합치고, `app/lib/pre-match-odds.ts`는 사전 배당을 정규화합니다. `app/lib/betman-matcher.ts`와 `app/lib/team-aliases.ts`는 안전한 Betman 경기 연결을 담당합니다.

경기가 선택된 경우에만 클라이언트가 Predictions와 pre-match odds GET을 시작합니다. 상세 작업공간은 넓은 화면에서 목록과 분석 패널을 두 열로 배치하고 두 열에 독립 스크롤을 적용합니다. 1050px 이하에서는 분석 패널이 목록을 대체하며, 선택 시 패널로 부드럽게 스크롤하고 닫기 시 마지막 상세 열기 버튼에 포커스를 돌려준 뒤 목록으로 복귀합니다.

## 저장된경기 선택 메타데이터

`market_predictions.selected_option_index`는 nullable 정수이며 `0`, `1`, `2`만 허용합니다. 기존 확률·배당·기대수익 데이터와 `saved_at`을 변경하지 않는 표시용 메타데이터입니다. `GET /api/market-predictions`가 이를 함께 반환하고, `PATCH /api/market-predictions`는 최대 100개의 `{ predictionKey, selectedOptionIndex }`를 검증한 뒤 D1 batch로 저장합니다. 서버는 행의 실제 `options_json` 길이를 확인해 존재하지 않는 선택 번호를 거부합니다.

클라이언트는 조회 시 저장값과 별도의 draft를 유지하고 둘이 다른 행만 저장 요청에 포함합니다. 같은 선택지를 다시 누르면 `null`로 해제하며, 저장 성공 전에는 draft를 유지하고 실패 시에도 재시도할 수 있도록 버리지 않습니다.

## Fixtures 계약

`GET /api/fixtures`는 K1=`292`, J1=`98`의 메타와 리그별 `season`을 `leagues`에 항상 제공하고, 각 성공 리그의 공식 순위를 `standingsByLeague.K1` 또는 `standingsByLeague.J1`에 제공합니다. K1은 달력 연도, J1은 7월~다음 해 6월의 종료 연도 키를 사용합니다. 공통 `season` 필드는 사용하지 않습니다. 경기는 리그 구분 없이 kickoff 순으로 정렬되고 공식 순위 행은 공급자 순서를 유지합니다.

각 리그 작업은 독립적으로 처리됩니다. 하나 이상 성공하면 HTTP 200과 `leagueErrors`를 반환하고, 두 리그가 모두 실패할 때만 502를 반환합니다. 클라이언트는 부분 실패 경고를 표시하면서 성공한 리그 경기 목록을 유지합니다. 두 리그가 모두 성공한 fixtures 결과만 D1에 10분 공유 캐시하며 부분 응답은 저장하지 않습니다.

## API-Football 공유 캐시

`app/lib/shared-api-cache.ts`는 같은 Worker의 in-flight 요청을 합치고, `db/api-response-cache.ts`는 D1의 `api_response_cache` 테이블에서 정상 응답과 15초 갱신 임대를 관리합니다. 동일 키는 한 실행자만 공급자를 갱신하며 다른 실행자는 마지막 정상 stale 값을 즉시 사용하거나 cold 상태에서 최대 3초 동안 공유 결과를 기다립니다.

HTTP 오류, API-Football `errors`, fixtures 부분 성공은 캐시에 저장하지 않습니다. 갱신 오류가 나도 stale 허용 기간 안의 마지막 정상값은 보존됩니다. D1 접근 실패는 공급자 직접 호출로 우회하지 않고 503을 반환하여 분산 중복 호출을 막습니다. 성공 응답의 `X-Cache-Status`는 `fresh`, `refreshed`, `stale`, `uncached` 중 하나입니다.

## Odds 계약

`GET /api/pre-match-odds?fixture={id}`는 양의 안전 정수 fixture ID를 요구하며 `{ fixtureId, fetchedAt, cacheSeconds: 1800, bookmakers }`를 반환합니다. bookmaker와 market이 없을 수 있으며 이는 정상입니다. fixture ID별 캐시는 30분입니다.

`PreMatchBookmakers`는 응답의 bookmaker 배열을 그대로 순회해 순서를 보존합니다. bookmaker마다 `Match Winner` market의 Home, Draw, Away가 모두 있을 때만 고정된 `Home / Draw / Away` 순서로 표시하고, 하나라도 없으면 `미제공` 행을 표시합니다. 이 표시 계층에는 bookmaker 선택 상태나 선택상자가 없습니다.

`GET /api/betman-odds`는 저장된 회차 URL이 없으면 `{ configured: false, fixtures: [] }`를 반환합니다. URL 변경은 UI만 사용하는 PUT 경로입니다. Betman 회차 결과는 10분 캐시됩니다.

## Betman 최종 배당 아카이브

`GET /api/odds-history`는 외부 공급자를 호출하지 않고 D1의 저장 기록과 회차 상태를 읽습니다. K1/J1의 정상 완료된 게임유형 `일반`, `축구 승무패`, 사전조건 `-`만 반환하며 페이지당 30개를 반환합니다. 응답은 표준·Betman 원문 팀명, H/D/A 결과, 양의 승·무·패 최종 배당, 취소·미정·배당누락·팀매칭실패 네 제외 건수와 archive 메타데이터를 포함합니다.

`POST /api/odds-history/sync`는 요청마다 새 익명 세션으로 Betman `G101` 마감게임만 읽고 로그인·구매 요청을 하지 않습니다. 동기화 요청당 최대 5회차를 상세 동시 실행 최대 2개로 처리합니다. `PENDING` 재조회 시각은 `max(last_success_at, last_attempt_at) + 30분`이며 그 전에는 외부 상세를 호출하지 않습니다. `FINAL` 회차는 재조회하지 않고 `source_final=1`인 확정 행의 원천 필드·결과·최종 배당·원문 팀명은 갱신하거나 삭제하지 않습니다.

확정 행이 `TEAM_MATCH_FAILED`이면 동기화 시작 시 현재의 리그별 명시적 별칭으로 로컬 재매칭합니다. 성공 시 팀 ID·표준 팀명·표시 상태만 갱신하고 Betman 원문 팀명, 경기 결과, 배당과 확정 시각은 보존합니다. 2026-08-22 K1 띄어쓰기 변형 보완도 이 경로로 기존 5월 저장 행을 복구했습니다.

과거 아카이브의 어댑터·엄격 파서·D1 저장소·GET/POST route는 현재 회차 경로와 분리됩니다. 따라서 기존 `GET/PUT /api/betman-odds`, 현재 회차 파서와 10분 캐시의 공개 계약은 변경되지 않습니다.

## Head-to-head 지연 조회

Browser는 fixtures 목록을 받은 뒤 H2H를 요청하지 않습니다. 사용자가 경기를 명시적으로 선택하면 `GET /api/head-to-head?fixture={id}&home={homeId}&away={awayId}&kickoff={ISO8601}`를 H2H, Predictions, pre-match odds와 각각 한 번 시작합니다. H2H 상태와 오류는 fixture ID 범위로 보관하므로 경기 전환이나 닫기 뒤 이전 fixture의 결과·오류를 표시하지 않으며, 취소된 요청도 화면 상태를 갱신하지 않습니다.

`/api/fixtures`는 리그별 시즌 fixtures와 standings를 순차 조회하고, 시즌 fixtures 응답을 과거 통계와 예정 경기로 분리합니다. cold 목록 요청은 K1 2회와 J1 2회로 총 4회이고 H2H fan-out이 없습니다. `/api/head-to-head`의 cache miss는 API-Football에 한 번 요청해 선택 kickoff 이전에 완료된 경기만 최신순 최대 10개로 반환합니다. 응답은 `fixtureId`, `fetchedAt`, `cacheSeconds: 1800`, `matches`를 포함합니다.

H2H 캐시는 fixture ID·home ID·away ID·kickoff 전체 조합을 키로 D1에 1,800초(30분) fresh, 정상 조회 시점부터 24시간 stale로 유지합니다. 공급자 rate limit은 자동 재시도하거나 오류로 저장하지 않습니다. stale 정상값이 없으면 429로 전달하며, UI는 맞대결 영역에만 오류를 표시하고 다른 상세 정보는 유지합니다.

## Betman 매칭

매처는 같은 리그, 같은 한국시간 날짜, 시작시간 차이 15분 이하, 홈/원정 모두 확인된 API 팀 ID가 일치하는 후보 하나만 반환합니다. 후보가 없거나 둘 이상이면 매칭하지 않습니다.
