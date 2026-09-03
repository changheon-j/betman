# 운영 안내

## 로컬 실행

```powershell
npm.cmd install
Copy-Item .env.example .dev.vars
npm.cmd run dev
```

`.dev.vars`의 `API_FOOTBALL_KEY`를 설정한 뒤 터미널에 출력된 `Local` 주소에서 확인합니다. Vinext의 기본 주소는 `http://localhost:3000`이며, 사용 중이면 다음 빈 포트로 변경됩니다. 키를 출력하거나 공유하지 않습니다.

## 배포 전 검증

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd run test:unit
node --test tests/rendered-html.test.mjs harness/test/*.test.mjs
node harness/src/cli.mjs --base-url http://127.0.0.1:3000
npm.cmd run test:betman-history-smoke
```

로컬 production build를 시작한 뒤 하네스를 실행하고 종료합니다. 하네스는 GET만 사용하며 `/api/odds-history`의 D1 응답을 검증하지만 `/api/odds-history/sync`는 호출하지 않습니다. `--base-url URL`은 `HARNESS_BASE_URL`보다 우선합니다. K1/J1 fixtures, 리그별 시즌 키, J1의 한 개 20팀 standings 계약을 검증하고, fixture ID가 있으면 선택 fixture의 H2H와 pre-match odds도 조회합니다. H2H는 응답이 최대 10개이고 모두 선택 kickoff 이전의 완료 경기인지 검증합니다. bookmaker가 0개인 것은 FAIL이 아닙니다.

`test:betman-history-smoke`는 읽기 전용으로 최근 `G101` 마감 회차 메타데이터를 최대 한 건 확인합니다. 성공 시 회차 키·개최일·최종 여부 같은 메타데이터만 출력하며 응답 본문과 쿠키는 출력하지 않습니다. Betman 차단, DNS 또는 네트워크 제한은 외부 smoke blocker로 별도 기록하고 제품 회귀 테스트 통과로 표시하지 않습니다. POST sync, 로그인, 쓰기, 구매 요청으로 우회하지 않습니다.

## 데이터 이상 대응

- K1 또는 J1 하나만 실패하면 앱은 성공한 리그와 `leagueErrors`를 반환합니다. 두 리그가 모두 실패한 경우에만 `/api/fixtures`가 502입니다.
- 2026-27 J1은 API `season=2027`입니다. 확인된 범위는 2026-08-07~2027-06-06이며 `current=true`, `standings=true`, `odds=true`입니다. `season=2026`, `odds=false`는 이미 끝난 2026-02-06~2026-06-06 동부/서부 전환 대회입니다.
- coverage가 true여도 개별 경기의 사전 배당이 비어 있을 수 있으므로 빈 `bookmakers`와 API 오류를 구분해 대응합니다.
- API-Football의 fixtures(10분), Predictions(10분), H2H(30분), pre-match odds(30분)는 D1 공유 정상응답 캐시를 사용합니다. 공급자 변경을 즉시 반영해야 하면 해당 fresh TTL 만료 뒤 다시 확인합니다.
- 성공 응답의 `X-Cache-Status`는 `fresh`(공유 캐시 적중), `refreshed`(이번 요청이 갱신), `stale`(갱신 장애로 마지막 정상값 사용), `uncached`(fixtures 부분 성공으로 미저장)를 뜻합니다.
- 동일 키의 갱신 임대는 15초이며 cold follower는 최대 3초 동안 D1 결과를 기다립니다. D1 장애는 공급자 직접 호출로 우회하지 않고 503으로 반환합니다.
- rate-limit과 공급자 오류는 캐시에 저장하지 않습니다. 기존 정상값이 stale 허용 기간 안이면 정상값을 반환하고, 그렇지 않으면 기존 429/502 오류가 표시됩니다.
- cold fixtures 조회에서 H2H fan-out은 없어야 합니다. H2H는 사용자가 상세 경기를 선택할 때만 한 번 호출됩니다. cache miss의 rate limit은 `/api/head-to-head`가 429로 반환하며 자동 재시도하지 않습니다. UI는 해당 상세의 맞대결 영역에만 오류를 표시하고 Predictions·배당 등 다른 상세 정보는 계속 표시합니다.
- Betman 매칭 실패는 배당 없음으로 보입니다. 별칭 수정 전에는 리그·시즌의 API 팀 ID와 실제 Betman 표기를 확인합니다. 시작시간 허용차는 15분입니다.
- 화면에 배당이 없지만 Betman 원문에 경기가 있으면 `리그 → 날짜·시간 → 홈/원정 팀 ID` 순서로 확인합니다. 2026-08-20에는 `JEF United Chiba`의 실제 Betman 표기 `제프 유나이티드`가 누락돼 매칭되지 않았고, 확인 후 J1 팀 ID `301`의 별칭으로 추가했습니다.
- 배당기록의 `팀매칭실패`가 많으면 D1의 Betman 원문 팀명을 먼저 확인하고, 실제 표기와 API-Football 팀 ID가 확인된 경우에만 `app/lib/team-aliases.ts`에 정확한 변형을 추가합니다. 동기화를 다시 실행하면 확정 실패 행은 외부 재수집이나 삭제 없이 로컬 재매칭됩니다.
- 2026-08-22 K1 5월 자료에서는 `FC서울`·`FC안양`, `울산HDFC`, `강원FC`·`광주FC`, `제주SKFC`, `부천FC1995`, `전북현대모터스`, `김천상무프로축구단`, `대전하나시티즌`, `인천유나이티드`, `포항스틸러스` 등의 공백 차이가 원인이었습니다. 2026-05-01~2026-05-17 재검증 기준 총 32개, 팀매칭실패 0개입니다.

## Betman 회차 URL

회차 URL 변경은 UI의 PUT 요청만 수행합니다. 구조가 유효하지 않으면 기존 URL을 유지합니다. 정상 구조의 빈 축구 경기/배당은 유효한 응답입니다.

## 최종 배당 아카이브

- `GET /api/odds-history`는 D1에서 페이지당 30개를 읽습니다. 현재 회차 `/api/betman-odds` 경로와 캐시는 그대로 유지됩니다.
- `POST /api/odds-history/sync`는 익명 Betman `G101` 마감게임에서 K1/J1의 `일반`·`축구 승무패`·`-` 시장만 읽고, 동기화 요청당 최대 5회차와 상세 동시 실행 최대 2개를 지킵니다.
- `PENDING`은 `max(last_success_at, last_attempt_at) + 30분` 전에는 상세를 재요청하지 않습니다. `FINAL` 회차와 확정 행의 결과·최종 배당·원문 팀명은 변경·삭제하지 않습니다.
- 화면과 GET 메타데이터의 제외 건수는 취소·미정·배당누락·팀매칭실패 네 가지입니다. 공급자 장애가 있어도 기존 D1 표를 보존하고 `BETMAN_UNAVAILABLE` 또는 `BETMAN_SCHEMA_CHANGED`를 데이터 없음과 구분합니다.

## 저장된경기 선택 표시

- 선택 1~3 셀을 누르면 한 행에서 하나만 주황색으로 표시되고, 같은 셀을 다시 누르면 해제됩니다.
- 실제 저장값과 다른 행이 있을 때만 `선택 저장` 버튼이 활성화됩니다. 저장은 `PATCH /api/market-predictions`로 최대 100건을 일괄 처리하며 기존 확률·배당·기대수익·입력일자를 변경하지 않습니다.
- 재조회 또는 서버 재실행 뒤에도 선택이 유지되지 않으면 `GET /api/market-predictions`의 `selectedOptionIndex`와 D1 `market_predictions.selected_option_index`를 확인합니다.
- 미저장 상태에서 조회 또는 다른 메뉴로 이동하면 확인창이 떠야 하며, 저장 실패 시 화면의 draft 선택은 유지되어야 합니다.

## 다른 채팅에서 이어가기

새 작업에서는 `docs/HANDOFF.md`를 먼저 읽고 `git status --short`로 미커밋 변경을 확인합니다. 개발 서버 포트와 저장된 Betman 회차는 실행 환경에 따라 달라질 수 있으므로 문서 값보다 현재 터미널과 화면 값을 우선합니다.
