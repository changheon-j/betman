# 선택 경기 기반 맞대결 지연 조회 설계

## 배경

현재 `GET /api/fixtures`는 K리그1과 J리그1의 일정·과거전적·순위를 조회한 뒤, 14일 이내 모든 예정 경기 조합에 대해 API-Football `fixtures/headtohead`를 추가 호출한다. 목록 한 번을 여는 동작이 예정 경기 수만큼의 공급자 요청을 만들며, 두 리그의 병렬 처리와 맞대결 재시도가 API-Football Pro의 순간 호출 제한을 초과할 수 있다.

이 변경의 목적은 목록 조회에서 맞대결 fan-out을 제거하고, 사용자가 실제로 상세분석을 연 경기의 맞대결만 조회하는 것이다.

## 사용자 흐름

1. 경기 메뉴 최초 진입 시 `GET /api/fixtures`로 예정 경기·시즌 통계·공식 순위만 가져온다.
2. 최초 목록 조회에서는 어떤 경기의 맞대결도 호출하지 않는다.
3. 사용자가 경기를 선택하면 기존 Predictions와 pre-match odds 요청과 함께 해당 경기의 맞대결 요청을 한 번 시작한다.
4. 맞대결을 기다리는 동안 최근 맞대결 영역에 `최근 맞대결을 불러오는 중입니다.`를 표시한다.
5. 정상 응답이 비어 있으면 `최근 맞대결 기록이 없습니다.`를 표시한다.
6. 공급자 오류가 발생하면 `최근 맞대결을 불러오지 못했습니다.`를 표시하되 Predictions, 배당, 최근 흐름 등 다른 상세정보는 계속 보여준다.
7. 다른 경기를 선택하거나 상세를 닫으면 이전 경기의 맞대결 결과·오류는 새 상세에 표시하지 않는다.

## API 구조

### 목록 API

`GET /api/fixtures`는 리그별로 다음 공급자 요청만 수행한다.

- 14일 이내 예정 경기
- 시즌 시작일부터 전일까지의 완료 경기(통계 기간이 존재할 때만)
- 공식 순위

`loadLeague`에서 예정 경기별 팀 조합 생성, `mapWithConcurrency`, 맞대결 재시도와 `fixtures/headtohead` 호출을 제거한다. 따라서 일반적인 cold 조회는 K1 3회와 J1 3회, 총 6회의 API-Football 요청이다.

목록의 `Match`에서는 `headToHead`를 제거한다. fixtures 최상위 응답의 `h2hFetchFailures`도 제거한다. 하네스와 문서는 이 새 계약을 기준으로 갱신한다.

### 맞대결 API

신규 읽기 전용 경로:

```text
GET /api/head-to-head?fixture={fixtureId}&home={homeTeamId}&away={awayTeamId}&kickoff={ISO8601}
```

입력 규칙:

- `fixture`, `home`, `away`는 양의 안전 정수여야 한다.
- 홈팀과 원정팀 ID는 달라야 한다.
- `kickoff`는 유효한 ISO 8601 시각이어야 한다.

공급자 요청은 정확히 한 번 수행한다.

```text
GET /fixtures/headtohead?h2h={homeTeamId}-{awayTeamId}&last=20&timezone=Asia/Seoul
```

이 경로에서는 자동 재시도를 하지 않는다. API-Football 응답의 `errors.rateLimit`은 HTTP 429로, 기타 공급자 실패는 502로 변환한다.

정상 응답:

```json
{
  "fixtureId": 1507028,
  "fetchedAt": "2026-08-14T01:23:45.000Z",
  "cacheSeconds": 1800,
  "matches": [
    ["2026.04.11", true, "2–1", "W"]
  ]
}
```

각 튜플은 기존 UI 계약을 유지한다.

- 날짜
- 선택 경기 홈팀이 당시 홈팀이었는지 여부
- 당시 홈팀–원정팀 점수
- 선택 경기 홈팀 기준 결과 `W | D | L`

선택 경기 kickoff 이전의 완료 경기만 최신순으로 최대 10개 반환한다.

## 모듈 경계

- `app/lib/head-to-head.ts`
  - query 입력 검증
  - API-Football 원본 경기에서 표시 튜플 변환
  - 현재 선택 경기와 일치하는 응답만 반환하는 fixture-scoped helper
- `app/api/head-to-head/route.ts`
  - API 키 읽기
  - 공급자 1회 요청
  - rate-limit 오류 분류
  - 경기별 30분 메모리 캐시와 최대 100개 제한
- `app/api/fixtures/route.ts`
  - 목록 데이터만 조회
- `app/lib/fixture-data.ts`
  - 목록 경기 생성에서 맞대결 의존성 제거
- `app/page.tsx`
  - 선택 경기에서만 맞대결 API 호출
  - 로딩·오류·빈 결과 표시
  - 경기 ID가 일치하는 결과만 렌더링

캐시 키는 `fixtureId`, 홈팀 ID, 원정팀 ID, kickoff를 모두 포함한다. 동일 fixture ID에 다른 팀이나 시간이 잘못 전달됐을 때 기존 캐시를 재사용하지 않는다. 캐시는 서버 프로세스를 재시작하면 초기화되며 DB에는 저장하지 않는다.

## 동시성 및 상태 안전성

클라이언트 effect는 선택 경기의 ID·홈팀 ID·원정팀 ID·kickoff를 캡처한다. 선택이 변경되거나 상세가 닫히면 이전 요청을 취소하거나 응답 적용을 중단한다.

상태는 다음처럼 fixture ID와 함께 보관한다.

```ts
type HeadToHeadResponse = {
  fixtureId: number;
  fetchedAt?: string;
  cacheSeconds?: number;
  matches: HeadToHeadMatch[];
};
```

렌더링은 `response.fixtureId === selected.id`인 경우에만 결과를 사용한다. 오류도 `{ fixtureId, message }` 형태로 격리한다. A 경기 응답을 받은 뒤 B 경기를 선택했을 때 B 요청 대기 중 A 데이터가 노출되지 않아야 한다.

## 호출량 변화

일반적인 서버 cold 상태 기준:

- 변경 전 목록: 기본 6회 + 예정 경기 수만큼 맞대결 호출, 실패 시 맞대결별 최대 3회
- 변경 후 목록: 기본 6회, 맞대결 호출과 재시도 없음
- 상세 선택: 맞대결 1회 + 기존 Predictions 1회 + pre-match odds 1회(각 캐시 miss 기준)

이 설계는 API-Football 전체 요청에 대한 공통 초당 throttle까지 구현하지 않는다. 이번 범위는 가장 큰 fan-out 제거에 한정한다.

## 테스트

### 단위 테스트

- fixtures 리그 빌더가 맞대결 map 없이 목록을 생성한다.
- 맞대결 query가 양의 ID, 서로 다른 팀, 유효한 kickoff만 허용한다.
- 완료 경기만 kickoff 이전·최신순·최대 10개로 변환한다.
- 선택 경기 홈팀이 당시 원정팀이어도 선택 경기 홈팀 기준 W/D/L을 계산한다.
- fixture ID가 다른 응답과 오류는 현재 상세에 노출하지 않는다.
- rate-limit 공급자 오류는 재시도 없이 429로 매핑한다.

### 계약 및 통합 테스트

- fixtures 계약에서 `headToHead`와 `h2hFetchFailures`를 요구하지 않는다.
- 신규 head-to-head 응답의 fixture ID, 날짜, boolean, 점수, 결과 튜플을 검증한다.
- 선택이 없으면 맞대결 API를 호출하지 않는 기존 명시 선택 흐름을 유지한다.
- 전체 typecheck, lint, build, 단위 테스트, rendered HTML, black-box harness를 통과한다.

## 문서 갱신

- `README.md`: 맞대결은 상세 선택 시 조회한다고 명시한다.
- `docs/ARCHITECTURE.md`: 신규 API와 목록/상세 책임 분리를 반영한다.
- `docs/DATA-SOURCES.md`: 목록 6회 구조, 상세 선택 기반 맞대결, 30분 캐시와 재시도 금지를 기록한다.
- `docs/DECISIONS.md`: 선택 기반 맞대결 조회 결정을 `2026-08-14` 날짜로 추가한다.
- `docs/OPERATIONS.md`: cold cache와 호출량, 429 발생 시 동작을 갱신한다.

## 제외 범위

- 공통 API-Football 전역 속도 제한기
- 맞대결 DB 영구 저장
- 수동 새로고침 버튼
- Predictions 및 pre-match odds의 캐시 정책 변경
- Betman 데이터 흐름 변경
