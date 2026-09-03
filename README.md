# Betting Analysis System

K리그1과 J리그1의 실제 경기 정보와 공개 배당을 조회하고, Betman 마감 배당·경기 결과와 사용자의 판단 기록을 보존하는 개인용 분석 도구입니다.

## 현재 범위

- 지원 리그: K1 (API-Football `292`), J1 (API-Football `98`)
- 시즌 키: K1은 달력 연도, J1은 7월~다음 해 6월의 종료 연도입니다. 따라서 2026-27 J1은 API `season=2027`입니다.
- 일정: 한국시간 오늘부터 14일 뒤까지
- 순위: 리그별 API-Football 공식 standings
- 경기 화면의 첫 상태는 예정 경기 목록 전체 폭입니다. 경기를 명시적으로 선택하면 상세 분석을 열며, 닫기(`×`, 접근성 이름 `상세분석 닫기`)로 목록으로 돌아갑니다.
- 상세: 최근 경기, 맞대결, Predictions, Betman 배당, API-Football 사전 배당
- 사전 배당과 Predictions는 선택한 경기에서만 조회합니다. 사전 배당은 API 응답의 모든 bookmaker를 응답 순서대로 표시하며, 각 행은 Match Winner의 `Home / Draw / Away`를 소수 둘째 자리까지 표시합니다. 세 값 중 하나라도 없으면 `미제공`으로 표시합니다. 빈 bookmaker 목록은 정상적인 데이터 없음 상태입니다.
- 넓은 화면에서는 목록과 상세가 나란히 표시되고 각각 독립적으로 스크롤됩니다. 1050px 이하에서는 상세가 목록을 대체하며 닫기로 목록으로 복귀합니다.
- 배당기록은 `GET /api/odds-history`로 D1에 보존된 K1/J1 정상 완료 경기의 일반 축구 승무패(`-`) 최종 배당을 최신순으로 페이지당 30개 표시합니다.
- 저장된경기에서는 각 행의 선택 1~3 중 하나를 주황색으로 표시할 수 있습니다. 변경된 행이 있을 때만 `선택 저장`이 활성화되며, 저장한 표시는 재조회와 서버 재실행 뒤에도 D1에서 복원됩니다.

API-Football Predictions는 외부 공급자가 제공하는 참고정보이며, 이 앱은 자체 승부예측 모델이나 자동 추천을 제공하지 않습니다.

## 캐시와 매칭

- API-Football 경로는 Worker 인스턴스가 함께 사용하는 D1 정상응답 캐시를 사용합니다. 같은 키의 동시 갱신은 로컬 in-flight 병합과 D1 15초 임대로 한 번만 실행됩니다.
- `/api/fixtures`: 한국 날짜별 10분 fresh, 정상 조회 시점부터 60분 stale 허용
- `/api/predictions?fixture={id}`: 경기 ID별 10분 fresh, 60분 stale 허용
- `/api/head-to-head?fixture={id}&home={homeId}&away={awayId}&kickoff={ISO8601}`: 선택한 경기 조합별 30분 fresh, 24시간 stale 허용
- `/api/pre-match-odds?fixture={id}`: 경기 ID별 30분 fresh, 120분 stale 허용
- API-Football 오류와 fixtures 부분 성공은 D1에 저장하지 않습니다. 갱신 오류 시 허용 기간 안의 마지막 정상값만 사용하며 응답의 `X-Cache-Status`로 `fresh`, `refreshed`, `stale`, `uncached`를 확인할 수 있습니다.
- `/api/betman-odds`: 회차별 10분 메모리 캐시
- Betman 경기는 리그, 한국시간 날짜, 홈/원정 팀 ID, 시작시간 차이 15분 이내가 모두 확인될 때만 연결합니다.
- `POST /api/odds-history/sync`는 로그인·구매 없이 익명 Betman `G101` 마감게임만 읽으며, 동기화 요청당 최대 5회차를 상세 동시 실행 최대 2개로 처리합니다. `PENDING`은 마지막 성공·시도 시각 중 더 최근 값부터 30분 뒤 재조회하고 `FINAL` 회차와 확정 행은 변경하지 않습니다.
- 과거 아카이브는 취소·미정·배당누락·팀매칭실패 네 제외 건수를 제공합니다. 기존 현재 회차 `/api/betman-odds` 계약과 10분 캐시는 변경되지 않습니다.

## 시작

Node.js 22 이상과 API-Football 키가 필요합니다.

```powershell
npm.cmd install
Copy-Item .env.example .dev.vars
npm.cmd run dev
```

`.dev.vars`에 `API_FOOTBALL_KEY`를 설정합니다. 실제 키는 Git, 문서, 로그, 커밋에 넣지 않습니다.

Vinext 개발 서버의 기본 로컬 주소는 `http://localhost:3000/`입니다. 포트가 사용 중이면 다음 빈 포트를 사용하므로, 터미널에 출력된 `Local` 주소를 기준으로 접속합니다.

## 검증

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
Set-Location harness
npm.cmd test
npm.cmd run all -- --base-url http://127.0.0.1:3000
```

하네스는 모든 요청을 GET으로만 수행합니다. `--base-url URL`이 환경 변수보다 우선하며, 알 수 없거나 잘못된 CLI 인자는 거부합니다. `/api/odds-history`의 D1 계약도 조회하지만 `/api/odds-history/sync`, `/api/betman-odds`의 PUT 및 `/api/market-predictions`의 POST/PATCH/DELETE는 호출하지 않습니다.

`/api/fixtures`는 리그별 시즌 경기와 standings를 순차 조회합니다. 시즌 경기 한 응답을 과거 통계와 예정 경기로 나누므로 일반적인 cold 목록 조회는 K1 2회와 J1 2회, 총 4회의 API-Football 요청이며 경기별 H2H fan-out은 없습니다. H2H는 상세 경기를 명시적으로 선택한 경우에만 호출됩니다. H2H cache miss에서는 H2H, Predictions, pre-match odds가 각각 1회씩 요청됩니다. H2H는 선택 kickoff 이전에 완료된 최근 경기만 최대 10개 표시합니다. rate limit(429) 또는 공급자 오류가 나도 자동 재시도하지 않으며, 해당 상세의 맞대결 영역에만 오류가 표시됩니다.

자세한 제품, 제품 변화 기록, 구조, 데이터 출처, 운영 절차는 `docs/`와 `docs/PRODUCT-EVOLUTION.md`를 참조합니다. 다른 채팅이나 작업 환경에서 이어갈 때는 `docs/HANDOFF.md`부터 확인합니다.
