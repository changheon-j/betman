# 작업 인수인계

최종 확인일: 2026-09-03

## 시작 순서

1. 저장소 루트에서 `git status --short`로 기존 변경사항을 확인합니다.
2. `.dev.vars`에 `API_FOOTBALL_KEY`가 있는지 확인하되 값을 출력하지 않습니다.
3. `npm.cmd run dev`를 실행하고 터미널의 `Local` 주소로 접속합니다. 기본 포트는 `3000`이며 사용 중이면 다음 빈 포트가 선택됩니다.
4. 기능 변경 전 `README.md`, `docs/PRODUCT.md`, `docs/PRODUCT-EVOLUTION.md`, `docs/ARCHITECTURE.md`, `docs/DATA-SOURCES.md`, `docs/OPERATIONS.md`를 확인합니다.

## 현재 구현 상태

- K리그1과 J리그1의 한국시간 오늘부터 14일 일정을 API-Football에서 조회합니다.
- K1은 달력 연도, 2026-27 J1은 종료 연도인 API `season=2027`을 사용합니다.
- 첫 화면은 예정 경기 목록만 표시하며, 사용자가 경기를 선택해야 상세 분석이 열립니다.
- H2H, Predictions, pre-match odds는 선택한 경기에서만 호출합니다. H2H와 pre-match odds는 30분 메모리 캐시를 사용합니다.
- API-Football 사전 배당은 모든 bookmaker의 Match Winner를 `Home / Draw / Away` 한 행으로 표시합니다.
- Betman은 사용자가 저장한 회차 URL을 읽고, 리그·날짜·15분 이내 시작시간·확인된 홈/원정 팀 ID가 모두 일치하는 단일 경기만 연결합니다.
- Betman 확률 저장은 회차와 게임번호를 포함한 안정 키를 사용하며 합계가 1일 때만 저장합니다.
- 배당기록은 Betman `G101` 마감게임의 K1/J1 일반 승무패 결과와 최종 배당을 D1에 저장하고, 확정된 팀매칭실패 행은 최신 명시적 별칭으로 로컬 재매칭합니다.
- 저장된경기 행은 선택 1~3 중 하나를 주황색으로 표시하고 변경된 여러 행을 한 번에 저장할 수 있습니다. 이 표시는 기존 예측 수치와 별도로 D1에 영속됩니다.

## 2026-09-03 제품 기준선 정리

- 개발 서버 로그 파일을 제품 문서와 작업 범위에서 정리했습니다.
- 현재 제품은 K1·J1의 실제 경기·배당·결과를 조회하고 사용자의 판단 기록을 저장하는 도구입니다.
- API-Football Predictions 화면과 API는 외부 참고정보로 유지합니다.
- 자체 승부예측 모델, 자동 확률 산출, 모델 학습, 확률 보정과 백테스트 계획은 제품 범위에서 폐기했습니다.
- 다음 우선순위는 비공개 웹 배포 준비, 운영 안정성, 데이터 품질, 사용성입니다.
- 2026-09-03 재검증: 전체 단위 테스트 `201/201`, 렌더 테스트 `1/1`, TypeScript typecheck·Vinext build·lint 통과.

## 2026-08-27 마지막 변경

- 최근 맞대결의 기존 선택팀 강조를 실제 승리팀 강조로 변경했습니다. `W/L`은 스코어상 승리팀 이름만 녹색 굵게 표시하고 `D`는 양 팀 모두 강조하지 않습니다.
- 회귀 테스트와 실제 Urawa–Yokohama F. Marinos 맞대결 화면에서 홈·원정 승리 및 무승부 표시를 확인했습니다.
- `market_predictions.selected_option_index` nullable 정수 컬럼과 비파괴 `0005` 마이그레이션을 추가했습니다.
- 저장된경기 행에서 선택 1~3 중 하나만 선택할 수 있고, 같은 항목을 다시 누르면 해제됩니다.
- 저장값과 다른 행이 있을 때만 `선택 저장`이 활성화되며 최대 100건을 PATCH로 일괄 저장합니다.
- 미저장 상태의 재조회·메뉴 이동·페이지 종료 경고와 저장 실패 시 draft 유지 동작을 추가했습니다.
- 검증: 전체 단위 테스트 `200/200`, 렌더 테스트 `1/1`, TypeScript·Vinext build·lint 통과. 실제 로컬 API와 브라우저에서 저장→재조회 복원을 확인하고 검증 행은 원래 `null`로 복구했습니다.
- 로컬 서버: `http://localhost:3000/`

## 2026-08-22 마지막 변경

2026-05-01~2026-05-17 조회가 1건만 표시된 원인은 Betman K1 원문 팀명의 띄어쓰기·붙여쓰기 변형이 과거 기록용 엄격 별칭과 정확히 일치하지 않아 36개 행이 `TEAM_MATCH_FAILED`로 분류됐기 때문입니다.

- 실제 Betman 응답에서 확인한 K1 팀명 변형 14종을 `app/lib/team-aliases.ts`에 추가했습니다.
- 확정 원천 행은 삭제하거나 다시 수집하지 않고 기존 로컬 재매칭 경로로 복구했습니다.
- 같은 기간 API 재검증: 총 32개 기록, 첫 페이지 30개, 2페이지 2개, `teamMatchFailed=0`, 취소 제외 1개
- 회귀 테스트: `resolves confirmed K1 Betman spacing variants from May closed games`
- 마지막 검증: 단위 테스트 `193/193` 통과, TypeScript `--noEmit --incremental false` 통과, `http://localhost:3001/` 및 배당기록 API HTTP 200 확인

## 2026-08-20 이전 변경

Betman 회차 `260098`에는 `FC도쿄 vs 제프 유나이티드` 경기가 있었지만 기존 별칭은 `제프 유나이티드 지바`, `제프 지바`, `JEF United Chiba`뿐이어서 매칭되지 않았습니다. 실제 Betman 표기를 확인한 뒤 `제프 유나이티드`를 J1 API-Football 팀 ID `301`에 추가했습니다.

- 일반 승무패 게임번호: `5345`
- 확인 당시 배당: `1.42 / 3.65 / 5.80`
- 회귀 테스트: `matches Betman's shortened JEF United team name`
- 마지막 검증: `npm.cmd run typecheck` 통과, 단위 테스트 `70/70` 통과, 실제 상세화면에서 Betman 4개 게임유형 표시 확인

## 기능 변경 통합 이력

2026-09-03 GitHub 게시 준비 과정에서 Betman 마감게임 실데이터 전환과 후속 수정, 저장된경기 선택 표시, 관련 문서·마이그레이션·테스트를 하나의 기능 통합 커밋으로 보존했습니다. 다음 작업 시작 시에도 `git status --short`와 `git log`로 실제 기준점을 확인합니다. 2026-08-27 선택 표시 기능의 핵심 파일은 다음과 같습니다.

- `app/lib/market-prediction.ts`, `app/api/market-predictions/route.ts`: 선택 계약·검증·PATCH 저장
- `app/page.tsx`, `app/saved-option-button.tsx`, `app/globals.css`: draft 상태·일괄 저장·주황색 선택 UI
- `db/schema.ts`, `drizzle/0005_narrow_sandman.sql`: 선택 메타데이터 스키마와 마이그레이션
- `tests/market-prediction.test.ts`, `tests/saved-option-button.test.ts`: 선택 규칙과 표시 회귀 테스트

## 다음 작업 후보

1. 비공개 웹 배포 준비
   - 배포 환경에 `API_FOOTBALL_KEY` 등록
   - 운영 D1 생성과 `0000`~`0005` 마이그레이션 적용
   - 로컬 저장 데이터의 운영 D1 이전 여부 결정
   - 저장·삭제·동기화 API 접근 제한
2. 운영 안정성
   - API-Football·Betman 오류, 호출량과 지연 시간 확인
   - 동기화 실패와 D1 오류 확인
   - 운영 데이터 백업·복구 기준 마련
3. 데이터 품질
   - 팀 별칭 변경 근거와 출처 기록
   - 팀 매칭 실패 행 점검 절차
4. 사용성
   - 모바일 접근성 점검
   - 저장·조회 오류 안내 개선
