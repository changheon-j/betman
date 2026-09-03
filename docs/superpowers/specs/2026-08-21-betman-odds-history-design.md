# F-001 Betman 배당기록 실데이터 전환 설계

작성일: 2026-08-21
상태: 승인됨
기능 ID: F-001

## 1. 목적

현재 `배당기록` 메뉴의 하드코딩 샘플을 Betman의 실제 마감 데이터로 교체한다. 데이터 출처는 Betman `게임구매 > 마감게임보기`의 프로토 승부식 `G101`이며, K리그1과 일본 J1리그의 정상 완료 경기에서 일반 축구 승무패 최종 배당과 공식 결과를 함께 보존한다.

사용자는 저장된 기록을 먼저 즉시 확인한다. 서버는 같은 조회 범위에서 아직 저장되지 않았거나 결과가 미확정인 회차만 뒤에서 동기화하며, 완료 뒤 저장소를 다시 조회한다. 한번 확정한 원천 데이터는 이후 Betman 오류, 빈 응답, 파서 실패 때문에 삭제하거나 덮어쓰지 않는다.

## 2. 범위와 비목표

### 2.1 포함 범위

- Betman 익명 세션 생성과 `G101` 마감 회차 탐색
- 마감 회차 상세에서 결과와 최종 승·무·패 배당 수집
- K리그1(`K1`)과 일본 J1리그(`J1`)만 엄격하게 선별
- 게임유형 `일반`, 종목/마켓 `축구 승무패`, 사전조건 `-`만 선별
- 표준 팀명과 Betman 원문 팀명 동시 저장
- 회차 동기화 상태와 마감 경기 기록의 D1 영속화
- 조회 전용 `GET /api/odds-history`
- 동기화 전용 `POST /api/odds-history/sync`
- 리그·팀·시작일·종료일 필터, 30개 고정 페이지, 최신순 표
- 제외 사유별 건수와 동기화 상태 표시
- 빠른 조건 변경 때 오래된 응답 차단
- 기존 경기, 순위, 현재 Betman, 확률 저장 기능의 회귀 검증

### 2.2 제외 범위

- K리그2, J리그2 또는 그 밖의 리그
- 핸디캡, 언더오버, SUM, 승1패, 승5패, 더블찬스 등 다른 게임유형
- 발매 중 배당의 이력 또는 배당 변동 시계열
- 로그인한 Betman 계정, 구매 내역, 사용자 쿠키 사용
- 문자열 유사도, 편집거리, 부분 문자열 또는 AI를 이용한 팀 추정 매칭
- 주기 실행 스케줄러, Queue, Cron, 관리자용 수동 데이터 편집 화면
- 기존 `/api/betman-odds`의 현재 회차 설정·캐시·응답 계약 변경
- 설계 단계에서의 제품 코드 변경 또는 구현 실행

## 3. 선택한 구조

다음 다섯 경계를 사용한다.

1. **마감 데이터 어댑터**: Betman 익명 세션과 마감 회차 목록·상세 요청을 캡슐화한다.
2. **엄격한 마감 배당 파서**: 공급자 응답을 신뢰 가능한 후보 행 또는 명시적 제외 사유로 변환한다.
3. **D1 아카이브**: 마감 경기 기록과 회차 동기화 상태를 서로 다른 테이블에 저장한다.
4. **분리 API**: 저장 데이터 조회와 외부 동기화를 서로 다른 경로와 메서드로 제공한다.
5. **저장 데이터 우선 UI**: GET 결과를 먼저 렌더링하고 POST 동기화가 끝난 뒤 GET을 다시 수행한다.

현재 회차 API를 확장하는 방식은 현재 경기 상세·확률 저장과 과거 수집의 장애 범위를 결합하므로 사용하지 않는다. 요청마다 Betman을 직접 조회하는 프록시 방식은 느리고 과거 확정값을 보존하지 못하므로 사용하지 않는다. 전체 기간을 매번 다시 긁는 방식도 확정 데이터 불변성과 요청당 5회차 제한에 어긋나므로 사용하지 않는다.

## 4. 원천 어댑터 계약

### 4.1 책임과 보안 경계

어댑터는 고정된 `https://www.betman.co.kr` 오리진만 호출한다. 클라이언트가 URL, 호스트, `gmId`를 전달할 수 없으며 `gmId`는 항상 `G101`이다. 리디렉션 뒤 최종 호스트도 `betman.co.kr` 또는 `www.betman.co.kr`인지 확인하고, 다른 호스트로 이동하면 실패한다.

한 번의 sync 요청마다 새 익명 세션을 만든다. 시작 화면은 공식 마감/적중결과 진입점인 `/main/mainPage/gamebuy/winrstList.do`이며, 같은 세션의 `Set-Cookie`를 이후 회차 목록·상세 요청에만 전달한다. 쿠키는 메모리에서 요청이 끝날 때 폐기하고 D1, 로그, API 응답에 저장하지 않는다. 로그인, 계정 식별자, 구매 요청은 사용하지 않는다.

Betman의 내부 목록·상세 요청 경로와 요청 본문은 어댑터 내부 상수 및 함수로만 둔다. 현재 코드가 사용하는 회차 상세 계약인 구매투표지 `/main/mainPage/gamebuy/gameSlip.do?gmId=G101&gmTs=...`와 JSON 상세 요청 `/buyPsblGame/gameInfoInq.do`를 재사용할 수 있지만, 과거 데이터의 기준 화면과 상태 판정은 반드시 마감게임보기 응답이어야 한다. 공급자 내부 경로가 바뀌어도 파서, 저장소, API, UI 계약은 바뀌지 않는다.

모든 외부 요청에는 연결과 본문 읽기를 합친 15초 제한, 최대 3 MiB 응답 제한을 적용한다. HTTP 오류, 제한 초과, 비 JSON/HTML 응답, 예상과 다른 로그인·차단 화면은 구조 오류로 처리한다. 같은 sync 요청 안에서 자동 재시도하지 않는다.

### 4.2 어댑터 인터페이스

```ts
type ClosedRoundRef = {
  gmId: "G101";
  gmTs: string;              // 숫자로만 구성된 Betman 회차
  sourceUrl: string;         // 고정 오리진의 정규화된 마감 상세 URL
  announcedAt: string | null; // 공급자가 제공할 때만 ISO 8601
};

type ClosedRoundDocument = {
  round: ClosedRoundRef;
  fetchedAt: string;         // UTC ISO 8601
  providerFinal: boolean;    // 공급자가 회차 적중결과 확정을 명시했는지
  payload: unknown;          // 파서 외부에서는 해석하지 않음
};

interface BetmanClosedAdapter {
  discoverRounds(from: string, to: string, session: AnonymousSession): Promise<ClosedRoundRef[]>;
  fetchRound(round: ClosedRoundRef, session: AnonymousSession): Promise<ClosedRoundDocument>;
}
```

`discoverRounds`는 경기 개최일이 요청한 양 끝 포함 기간과 겹치는 모든 `G101` 회차를 반환해야 한다. 목록의 발표일이나 회차 번호를 경기일의 대용으로 추정해서는 안 된다. 목록 페이지네이션과 회차 상세의 개최일을 확인해 포함 여부를 결정하고, 같은 회차는 `gmId + gmTs`로 중복 제거한다. 반환 순서는 최신 회차부터다.

회차 상세 요청은 최대 두 개만 동시에 실행한다. 목록 요청은 순차 실행하며, 한 API 요청이 상세를 시도하는 회차는 최대 다섯 개다.

## 5. 엄격한 파싱과 매칭

### 5.1 문서 수준 검증

다음 중 하나면 해당 회차 전체를 실패 처리하고 어떤 경기 행도 쓰지 않는다.

- 필수 키/열 정의 또는 행 배열이 없음
- 키와 배열 행의 길이가 맞지 않음
- `gmId`, `gmTs`가 요청한 회차와 다름
- 회차 또는 경기 식별자인 `matchSeq`가 없거나 중복됨
- 공식 회차 상태를 판정할 수 없음
- 응답이 비어 있지만 공급자가 해당 회차의 명시적 0경기를 표시하지 않음
- 동일 경기의 결과·점수·배당 사이에 모순이 있음

공급자가 명시적으로 해당 회차에 대상 경기가 0개라고 표시하고 문서 구조와 회차 식별자가 모두 정상일 때만 유효한 빈 회차로 인정한다. 유효한 빈 회차도 기존 경기 행을 삭제하는 근거로 사용하지 않는다.

### 5.2 대상 행 선별

문서가 유효하면 각 행을 다음 순서로 처리한다.

1. 스포츠가 축구인지 확인한다.
2. 리그 원문을 명시적 리그 별칭표로 조회해 `K1` 또는 `J1`인지 확인한다.
3. 공급자의 게임 구분이 `일반`, 마켓명이 `축구 승무패`, 사전조건이 정확히 `-`인지 확인한다.
4. `matchSeq`, 개최시각, 홈/원정 원문 팀명을 읽는다.
5. 공식 경기 상태, 홈/원정 점수, 승·무·패 결과를 읽는다.
6. `승`, `무`, `패` 세 선택지의 최종 배당을 읽는다.
7. 양 팀을 해당 리그의 명시적 별칭 레지스트리에 조회한다.

1~3에 맞지 않는 행은 기능 범위 밖이므로 저장하거나 제외 건수에 포함하지 않는다. 4 이후의 대상 행은 반드시 하나의 저장 행 또는 하나의 제외 사유가 된다.

텍스트에는 Unicode NFC, 앞뒤 공백 제거, 연속 공백 단일화를 적용한다. 팀 매칭은 현재 `app/lib/team-aliases.ts`와 같은 리그별 명시적 별칭 레지스트리의 정규화된 정확 일치만 허용한다. 두 팀이 모두 정확히 하나의 표준 팀 ID에 대응해야 하며, 유사도·부분 일치·리그 간 별칭 공유는 금지한다. 별칭 충돌은 애플리케이션 시작 또는 테스트에서 오류로 만든다.

표준 팀명은 API-Football 팀 ID에 연결된 애플리케이션 표준 표시명을 사용한다. 저장 시점의 표준명과 Betman 원문명을 모두 스냅샷으로 저장하므로 향후 표시명이나 별칭이 바뀌어도 과거 원문을 잃지 않는다.

### 5.3 결과와 배당 검증

- 점수는 0 이상의 정수 홈·원정 득점 두 개여야 한다.
- 결과는 홈 승=`H`, 무=`D`, 원정 승=`A`로 정규화한다.
- 결과는 점수 비교와 일치해야 한다.
- 선택지 라벨은 정확히 `승`, `무`, `패`가 각각 한 번 있어야 한다.
- 각 배당은 유한한 양수이며 문자열을 10진수로 읽은 뒤 D1 `REAL`에 저장한다.
- 정상 완료 상태, 유효 점수, 일관된 결과, 세 최종 배당, 양 팀 매칭이 모두 충족된 행만 표에 표시할 수 있다.

대상 행의 제외 사유는 다음 우선순위로 정확히 하나만 기록한다.

| 코드 | 사용자 표시 | 판정 | 재처리 |
|---|---|---|---|
| `CANCELLED` | 취소 | 공급자가 취소·무효·적중특례 등 정상 완료가 아님을 확정 | 원천 확정 뒤 재조회하지 않음 |
| `PENDING_RESULT` | 미정 | 결과 또는 점수가 아직 확정되지 않음 | 회차의 최근 성공·시도 기준 30분 쿨다운 뒤 Betman 재조회 |
| `MISSING_ODDS` | 배당누락 | 승·무·패 중 하나 이상이 없거나 유효하지 않음 | 회차 미확정이면 30분 쿨다운 뒤 재조회, 회차 확정이면 종료 |
| `TEAM_MATCH_FAILED` | 팀매칭실패 | 홈 또는 원정이 명시적 별칭에 정확히 매칭되지 않음 | Betman 재조회 없이 최신 별칭으로 로컬 재매칭 가능 |

여러 조건이 동시에 맞으면 표의 위쪽 사유를 사용한다. 점수와 결과가 서로 모순되거나 중복 선택지가 충돌하는 행은 단순 제외가 아니라 문서 수준 오류로 간주해 회차 전체 쓰기를 막는다.

## 6. D1 데이터 모델

새 마이그레이션은 다음 두 테이블을 만든다. Drizzle 선언과 SQL 마이그레이션은 동일한 제약을 가져야 한다.

### 6.1 `betman_history_rounds`

| 열 | 형식/제약 | 의미 |
|---|---|---|
| `round_key` | `TEXT PRIMARY KEY` | `G101:{gmTs}` |
| `gm_id` | `TEXT NOT NULL CHECK (gm_id = 'G101')` | 게임 ID |
| `gm_ts` | `TEXT NOT NULL` | Betman 회차 |
| `source_url` | `TEXT NOT NULL` | 정규화된 공식 상세 URL |
| `status` | `TEXT NOT NULL` | `DISCOVERED`, `SYNCING`, `PENDING`, `FINAL`, `ERROR` |
| `provider_final` | `INTEGER NOT NULL DEFAULT 0` | 공급자 회차 확정 여부 0/1 |
| `event_from` | `TEXT` | 해당 회차 대상 경기의 최소 `YYYY-MM-DD` |
| `event_to` | `TEXT` | 해당 회차 대상 경기의 최대 `YYYY-MM-DD` |
| `attempt_count` | `INTEGER NOT NULL DEFAULT 0` | 상세 동기화 시도 수 |
| `last_attempt_at` | `TEXT` | 마지막 시도 UTC ISO 8601 |
| `last_success_at` | `TEXT` | 마지막 유효 문서 처리 시각 |
| `finalized_at` | `TEXT` | `FINAL` 전환 시각 |
| `error_code` | `TEXT` | 마지막 실패의 안정 코드 |
| `error_message` | `TEXT` | 비밀값을 제거한 마지막 실패 요약 |
| `lease_expires_at` | `TEXT` | 중복 상세 요청 방지용 짧은 임대 만료시각 |
| `created_at` | `TEXT NOT NULL` | 최초 발견 시각 |
| `updated_at` | `TEXT NOT NULL` | 마지막 상태 변경 시각 |

`UNIQUE(gm_id, gm_ts)`와 `(status, event_from, event_to)` 인덱스를 둔다. 임대는 60초이며 만료된 임대만 다른 요청이 인수할 수 있다. `FINAL` 회차는 네트워크 상세 조회 대상에서 제외한다.

상태 전이는 다음과 같다.

```text
없음 -> DISCOVERED -> SYNCING -> PENDING -> SYNCING
                         |          |
                         +--------> FINAL
                         +--------> ERROR -> SYNCING
```

유효한 상세를 처리했지만 재조회가 필요한 행이 하나라도 있으면 `PENDING`이다. 공급자가 회차 확정을 명시하고 모든 대상 행이 표시 가능 또는 종료 가능한 제외 상태이면 `FINAL`이다. 요청·파싱·D1 트랜잭션이 실패하면 `ERROR`로 두되 기존 `provider_final`, 경기 데이터, 성공 시각은 지우지 않는다. 오류를 기록할 때도 이미 `FINAL`인 회차를 `ERROR`로 되돌리지 않는다.

`PENDING`의 네트워크 재조회 가능 시각은 `max(last_success_at, last_attempt_at) + 30분`이다. 두 값 중 null은 제외하며 둘 다 없으면 즉시 가능하다. 현재 UTC 시각이 이 경계 이상일 때만 상세 요청 대상으로 claim할 수 있고, 30분 미만이면 상태와 저장 행을 그대로 둔 채 이번 sweep에서 건너뛴다. 쿨다운으로 건너뛴 회차는 `attempt_count`와 `last_attempt_at`을 변경하지 않는다. `FINAL`은 시간 경과와 관계없이 영구적으로 상세 네트워크 재조회 대상에서 제외한다. `TEAM_MATCH_FAILED` 로컬 재매칭은 네트워크 요청이 아니므로 이 쿨다운을 적용하지 않는다.

### 6.2 `betman_history_matches`

| 열 | 형식/제약 | 의미 |
|---|---|---|
| `source_key` | `TEXT PRIMARY KEY` | `G101:{gmTs}:{matchSeq}` |
| `round_key` | `TEXT NOT NULL REFERENCES betman_history_rounds(round_key)` | 소속 회차 |
| `gm_id`, `gm_ts`, `match_seq` | `TEXT NOT NULL` | 공급자 식별자 |
| `league_code` | `TEXT NOT NULL CHECK IN ('K1','J1')` | 표준 리그 코드 |
| `league_name` | `TEXT NOT NULL` | 표준 리그명 `K리그1` 또는 `J리그1` |
| `betman_league_name` | `TEXT NOT NULL` | Betman 리그 원문 |
| `kickoff_at` | `TEXT NOT NULL` | 공급자 시각을 한국시간 오프셋 포함 ISO 8601로 정규화 |
| `match_date` | `TEXT NOT NULL` | 한국시간 `YYYY-MM-DD` |
| `home_team_id`, `away_team_id` | `INTEGER` | 매칭된 API-Football 팀 ID, 실패 시 null |
| `home_team_name`, `away_team_name` | `TEXT` | 저장 시점의 표준 팀명, 실패 시 null |
| `betman_home_team`, `betman_away_team` | `TEXT NOT NULL` | 가공 전 Betman 원문 팀명 |
| `home_score`, `away_score` | `INTEGER` | 확정 전 또는 취소면 null 가능 |
| `result` | `TEXT CHECK IN ('H','D','A')` | 확정 전 또는 취소면 null |
| `home_odds`, `draw_odds`, `away_odds` | `REAL` | 유효하지 않으면 null 가능 |
| `display_status` | `TEXT NOT NULL` | `INCLUDED` 또는 네 제외 코드 중 하나 |
| `source_final` | `INTEGER NOT NULL DEFAULT 0` | 이 행의 원천 결과·배당 확정 여부 |
| `first_seen_at`, `last_seen_at` | `TEXT NOT NULL` | 최초·최근 유효 관측 시각 |
| `finalized_at` | `TEXT` | 원천 확정 시각 |

`UNIQUE(gm_id, gm_ts, match_seq)`를 두고 다음 인덱스를 둔다.

- `(display_status, match_date DESC, kickoff_at DESC)`
- `(league_code, match_date DESC, kickoff_at DESC)`
- `(league_code, home_team_id, match_date DESC)`
- `(league_code, away_team_id, match_date DESC)`
- `(round_key)`

`INCLUDED`에는 팀 ID·표준명, 점수·결과, 세 배당, `source_final=1`, `finalized_at`이 모두 있어야 한다. 이 불변조건은 저장소 함수가 트랜잭션 전에 검사하고 테스트로 고정한다.

### 6.3 쓰기와 불변성

회차 한 개의 상태와 후보 행 전체는 하나의 D1 batch/트랜잭션 단위로 쓴다. 문서 수준 검증이 모두 끝난 뒤에만 쓰기를 시작한다.

- 새 행은 삽입한다.
- `source_final=0`인 행만 완전한 새 후보 행으로 교체할 수 있다.
- `source_final=1`인 행의 원천 필드, 결과, 배당, 원문 팀명은 절대 갱신하거나 삭제하지 않는다.
- 확정 행과 다른 새 값이 오면 기존 값을 유지하고 회차에 `FINAL_CONFLICT` 오류를 기록한다.
- `TEAM_MATCH_FAILED` 행은 원천 필드를 바꾸지 않고 팀 ID·표준명·표시 상태만 최신 별칭 레지스트리로 다시 계산할 수 있다.
- 유효한 빈 응답, 범위 축소, 목록에서 사라진 회차는 삭제 명령을 발생시키지 않는다.
- 동기화 경로에는 경기 또는 회차 `DELETE`가 존재하지 않는다.

확정 행은 운영상 영구 보존한다. 향후 실제 삭제가 필요하면 이 기능과 분리된 명시적 관리 설계와 승인을 거쳐야 한다.

## 7. 조회 API 계약

### 7.1 요청

```http
GET /api/odds-history?league=all&team=&from=2026-05-21&to=2026-08-21&page=1
```

| 매개변수 | 규칙 |
|---|---|
| `league` | `all`, `K1`, `J1`; 생략 시 `all` |
| `team` | 생략/빈 문자열은 전체 팀, 값은 `{leagueCode}:{positiveTeamId}` |
| `from`, `to` | 둘 다 생략하면 한국시간 오늘과 3개월 전 기본값, 하나만 생략하면 400 |
| `page` | 1 이상의 안전한 정수, 생략 시 1 |

최근 3개월은 한국시간 오늘을 `to`로 하고, `from`은 오늘에서 달력상 3개월을 뺀 같은 일자다. 대상 월에 같은 일자가 없으면 그 달 마지막 날을 사용한다. 예를 들어 5월 31일의 기본 시작일은 2월 28일 또는 윤년 2월 29일이다.

날짜는 정규식만이 아니라 실제 Gregorian 달력 날짜인지 확인한다. `from > to`면 거부한다. 최대 범위는 `to <= from을 1년 뒤로 이동한 날짜`이며, 2월 29일의 1년 뒤는 2월 28일로 계산한다. 이 경계를 넘으면 거부한다. 양 끝 날짜를 포함한다.

`team`의 리그는 `league=all`이거나 같은 리그여야 하고 현재 별칭 레지스트리의 표준 팀 ID여야 한다. 아니면 400 `INVALID_TEAM`이다.

### 7.2 성공 응답

```json
{
  "query": {
    "league": "all",
    "team": null,
    "from": "2026-05-21",
    "to": "2026-08-21",
    "page": 1,
    "pageSize": 30
  },
  "teams": [
    { "key": "K1:2766", "leagueCode": "K1", "id": 2766, "name": "FC 서울" }
  ],
  "records": [
    {
      "sourceKey": "G101:260098:5345",
      "round": "260098",
      "matchSeq": "5345",
      "leagueCode": "J1",
      "leagueName": "J리그1",
      "kickoffAt": "2026-08-21T19:30:00+09:00",
      "date": "2026-08-21",
      "homeTeamId": 292,
      "awayTeamId": 301,
      "homeTeam": "FC 도쿄",
      "awayTeam": "제프 유나이티드 지바",
      "betmanHomeTeam": "FC도쿄",
      "betmanAwayTeam": "제프 유나이티드",
      "score": { "home": 2, "away": 1 },
      "result": "H",
      "odds": { "home": 2.1, "draw": 3.2, "away": 3.4 },
      "finalizedAt": "2026-08-21T14:00:00.000Z"
    }
  ],
  "pagination": { "page": 1, "pageSize": 30, "total": 1, "totalPages": 1 },
  "excludedCounts": {
    "cancelled": 0,
    "pendingResult": 0,
    "missingOdds": 0,
    "teamMatchFailed": 0
  },
  "archive": {
    "pendingRounds": 0,
    "cooldownPendingRounds": 0,
    "errorRounds": 0,
    "nextPendingRetryAt": null,
    "lastSuccessfulSyncAt": "2026-08-21T14:00:00.000Z"
  }
}
```

`records`는 `INCLUDED`만 반환하며 `kickoff_at DESC, gm_ts DESC, match_seq DESC` 순서다. 페이지 크기는 요청으로 바꿀 수 없는 30이다. 팀 필터는 홈 또는 원정 ID가 일치하면 된다.

`excludedCounts`는 같은 날짜·리그 범위의 대상 행을 사유별로 한 번씩 센다. 팀이 선택되면 표준 팀 ID가 있는 제외 행만 홈 또는 원정 일치 조건으로 센다. 따라서 팀 매칭 자체가 실패한 행은 특정 팀을 안전하게 귀속할 수 없어 `teamMatchFailed`가 0이며, 전체 팀일 때만 그 건수가 보인다. 이 규칙을 UI 도움말에 표시한다.

`teams`는 현재 표준 팀 레지스트리에서 만든다. `league=K1`이면 K1, `league=J1`이면 J1, `all`이면 두 리그 팀을 리그명·팀명 순으로 반환한다. 기록 존재 여부와 무관하게 지원 팀 전체를 제공하므로 필터 목록이 빈 아카이브에 좌우되지 않는다.

`archive.cooldownPendingRounds`는 현재 시각에 30분 쿨다운이 끝나지 않은 `PENDING` 회차 수다. `archive.nextPendingRetryAt`은 그 회차들 가운데 가장 이른 재조회 가능 UTC ISO 8601 시각이며 없으면 null이다. 이 값은 GET 처리 시 `last_success_at`과 `last_attempt_at`으로 계산하고 저장된 별도 타이머에 의존하지 않는다.

## 8. 동기화 API 계약

### 8.1 요청

첫 요청:

```http
POST /api/odds-history/sync
Content-Type: application/json

{ "from": "2026-05-21", "to": "2026-08-21" }
```

이어받기 요청:

```json
{ "from": "2026-05-21", "to": "2026-08-21", "cursor": "opaque-server-cursor" }
```

날짜 검증은 GET과 동일하다. 동기화는 Betman 회차 단위로 K1과 J1 대상 행을 함께 저장하므로 리그와 팀 필터를 받지 않는다. 화면의 리그·팀 선택은 다시 조회할 표시 범위에만 영향을 준다.

cursor는 서버가 만든 최대 8 KiB의 base64url 값이며 버전, `from`, `to`, 최초 탐색에서 확정한 최신순 회차 키 배열, 다음 배열 위치, 발급시각을 포함한다. 클라이언트는 해석하거나 수정하지 않는다. 이어받기 요청마다 서버는 cursor의 회차 배열이 같은 기간을 다시 탐색한 결과의 순서를 유지하는 부분집합인지 검증한다. 버전·모양·기간·회차가 맞지 않거나 30분이 지난 cursor는 400 `INVALID_CURSOR`다. cursor는 권한 토큰이 아니며 고정 오리진의 `G101` 읽기만 지시할 수 있으므로 별도 비밀값을 추가하지 않는다.

### 8.2 처리 순서

1. 첫 요청에서 기간에 속한 회차 목록을 최신순 스냅샷으로 확정하고 cursor에 담는다. 첫 요청과 각 이어받기 요청은 각각 새 익명 세션을 만든다.
2. 이미 `FINAL`인 회차는 상세 요청 없이 건너뛴다.
3. `PENDING`은 `max(last_success_at, last_attempt_at) + 30분`이 현재 시각 이하인 회차만 선택하고, 쿨다운 중인 회차는 상세 요청 없이 건너뛴다.
4. `DISCOVERED`, 재조회 가능한 `PENDING`, `ERROR` 또는 저장소에 없는 회차 중 이번 페이지의 최대 다섯 회차를 선택한다.
5. `TEAM_MATCH_FAILED`인 확정 원천 행은 네트워크 요청 전에 현재 별칭으로 로컬 재매칭한다.
6. 상세 요청은 두 작업의 고정 워커 풀로 실행한다. 세 번째 요청은 둘 중 하나가 끝날 때까지 시작하지 않는다.
7. 각 회차는 문서 전체 검증 뒤 원자적으로 upsert한다.
8. 아직 탐색 스냅샷에서 검사하지 않은 회차가 있으면 `hasMore=true`와 다음 cursor를 반환한다.

한 POST가 실제 상세를 요청하는 회차는 성공·실패를 합쳐 최대 다섯 개다. `FINAL` 또는 쿨다운 중인 `PENDING`을 건너뛰는 것은 이 다섯 개에 포함하지 않지만 cursor의 검사 위치는 앞으로 이동한다. 상세 실패 회차도 이번 탐색 스냅샷에서는 시도한 것으로 표시하고 cursor는 앞으로 이동한다. 같은 자동 동기화가 실패 회차나 쿨다운 회차를 무한 반복하지 않으며, `PENDING`은 다음 메뉴 진입·조회 동기화가 재조회 가능 시각 이후 시작될 때만 다시 요청한다.

### 8.3 성공 및 부분 성공 응답

```json
{
  "status": "completed",
  "processedRounds": 5,
  "maxRoundsPerRequest": 5,
  "maxParallelDetails": 2,
  "rounds": [
    {
      "gmTs": "260098",
      "status": "FINAL",
      "inserted": 8,
      "updatedPending": 2,
      "preservedFinal": 12,
      "excluded": {
        "cancelled": 1,
        "pendingResult": 0,
        "missingOdds": 0,
        "teamMatchFailed": 1
      },
      "error": null
    }
  ],
  "hasMore": false,
  "nextCursor": null,
  "remainingUnresolvedRounds": 0,
  "deferredPendingRounds": 0,
  "nextPendingRetryAt": null,
  "startedAt": "2026-08-21T13:59:00.000Z",
  "finishedAt": "2026-08-21T14:00:00.000Z"
}
```

일부 회차가 실패하거나 `PENDING`으로 남아도 요청 수준의 목록·D1 처리가 가능했으면 HTTP 200과 `status="partial"`을 반환하며 해당 회차의 안정 오류 코드와 사용자용 메시지를 `rounds[].error`에 넣는다. 시도한 회차가 모두 `FINAL`이거나 이미 확정되어 건너뛴 경우만 `status="completed"`다. `hasMore`는 이번 탐색 스냅샷에서 아직 검사하지 않은 회차가 있는지만 뜻하며 쿨다운 종료를 기다리라는 뜻으로 사용하지 않는다. `remainingUnresolvedRounds`는 검사했지만 `PENDING` 또는 `ERROR`로 남은 회차 수다. `deferredPendingRounds`는 그중 30분 쿨다운 때문에 네트워크 요청을 건너뛴 수, `nextPendingRetryAt`은 가장 이른 재조회 가능 시각이며 해당 회차가 없으면 null이다.

회차 목록 자체를 가져오지 못했거나 D1을 사용할 수 없어 아무 안전한 처리를 할 수 없으면 502 또는 503으로 실패한다. 이때도 기존 데이터는 변하지 않는다.

## 9. 공통 오류 계약

모든 오류 응답은 다음 모양을 사용한다.

```json
{
  "error": {
    "code": "INVALID_DATE_RANGE",
    "message": "조회 기간은 최대 1년입니다.",
    "field": "to",
    "retryable": false
  }
}
```

| HTTP | 코드 | 조건 |
|---|---|---|
| 400 | `INVALID_DATE`, `INVALID_DATE_RANGE`, `INVALID_LEAGUE`, `INVALID_TEAM`, `INVALID_PAGE`, `INVALID_CURSOR` | 입력 검증 실패 |
| 409 | `ROUND_BUSY` | 선택한 모든 회차가 다른 sync 요청의 유효 임대 상태 |
| 502 | `BETMAN_UNAVAILABLE`, `BETMAN_SCHEMA_CHANGED`, `FINAL_CONFLICT` | 요청 수준에서 안전하게 처리된 회차가 하나도 없는 원천 연결·구조·확정값 충돌 |
| 503 | `DATABASE_UNAVAILABLE` | D1 조회 또는 트랜잭션 실패 |
| 500 | `INTERNAL_ERROR` | 분류되지 않은 서버 오류 |

서버 응답과 로그에는 쿠키, 전체 원천 본문, 스택, D1 바인딩 정보가 포함되지 않는다. 로그에는 요청 상관 ID, 회차 키, 오류 코드, HTTP 상태, 소요시간만 남긴다. UI는 저장된 표를 지우지 않고 마지막 성공 데이터 위에 오류 상태를 표시한다.

## 10. UI 동작

### 10.1 초기값과 필터

배당기록 메뉴의 필터 순서는 리그, 팀, 시작일, 종료일이다.

- 리그: `전체`, `K리그1`, `J리그1`; 기본값 `전체`
- 팀: `전체 팀`과 GET 응답의 해당 리그 팀; 기본값 `전체 팀`
- 종료일: 한국시간 오늘
- 시작일: 종료일에서 달력상 3개월 전
- 조회 버튼: 현재 입력값을 검증한 뒤 적용
- 초기화 버튼: 네 필터와 페이지를 기본값으로 되돌리고 같은 조회 흐름 실행

리그가 바뀌면 팀 목록을 즉시 새 리그 기준으로 갱신한다. 현재 팀 key가 새 목록에 없으면 조회 전 `전체 팀`으로 초기화한다. 유효한 팀이면 유지한다. 필터가 적용되면 페이지는 항상 1로 돌아간다. 페이지 이동은 저장 데이터 GET만 수행하고 새 sync를 시작하지 않는다.

클라이언트는 잘못된 날짜, 날짜 역전, 1년 초과를 조회 전에 필드별 메시지로 막는다. 서버도 같은 규칙을 독립적으로 검증한다.

### 10.2 저장 데이터 우선 흐름

메뉴 최초 진입과 조회 버튼 동작은 동일한 순서를 따른다.

```text
필터 검증
  -> GET /api/odds-history
  -> D1 records 즉시 표시
  -> POST /api/odds-history/sync
  -> hasMore인 동안 nextCursor로 POST를 순차 반복
  -> 마지막 POST 완료 또는 부분 실패
  -> GET /api/odds-history 재조회
  -> 최신 저장 결과와 최종 상태 표시
```

GET이 성공하면 기록이 0개여도 즉시 빈 상태를 표시한 뒤 sync를 시작한다. 최초 GET이 실패하면 저장 데이터도 신뢰할 수 없으므로 sync를 시작하지 않고 재시도 버튼을 보인다. sync 실패·부분 실패 때는 최초 GET 결과를 유지하고 오류와 `remainingUnresolvedRounds`를 표시한 뒤 마지막 GET을 한 번 시도한다. 마지막 GET까지 실패하면 최초 성공 표를 그대로 유지한다.

자동 POST 체인은 `hasMore`만 따라가며 `nextPendingRetryAt`까지 브라우저에서 대기하거나 타이머로 다시 호출하지 않는다. 쿨다운 중인 `PENDING`만 남아 있으면 저장 결과와 `다음 동기화 가능 {한국시간}` 안내를 표시하고 이번 흐름을 종료한다. 사용자가 재조회 가능 시각 전에 메뉴에 다시 진입하거나 조회를 눌러도 서버는 해당 회차를 건너뛰며, 시각 이후의 새 조회 흐름에서만 네트워크 재조회를 허용한다.

POST 연결은 한 번에 하나만 실행한다. 브라우저가 새 조건으로 조회하거나 배당기록 메뉴를 떠나면 진행 중 GET/POST를 `AbortController`로 취소한다. 각 조회 흐름에 증가하는 request generation을 부여하고, 응답을 적용하기 직전에 현재 generation과 일치하는지 확인한다. 취소가 서버 처리 자체를 되돌린다고 가정하지 않으며, 늦게 끝난 서버 sync의 D1 쓰기는 멱등이므로 허용하되 오래된 응답은 화면 상태를 바꾸지 못한다.

### 10.3 표시

헤더의 `샘플 데이터`, `데모 데이터`, 하단 샘플 안내와 하드코딩 `oddsRecords`를 제거한다. 배당기록 메뉴의 데이터 출처 문구는 `Betman 마감게임 · D1 아카이브`로 바꾼다.

표 열은 다음 순서다.

```text
경기일 / 리그 / 홈팀 / 원정팀 / 경기결과 / 승 배당 / 무 배당 / 패 배당
```

표준 팀명을 기본으로 표시하고 접근 가능한 보조 텍스트 또는 툴팁에 `Betman 원문: ...`를 제공한다. 결과에 해당하는 배당 셀의 기존 강조 스타일은 유지한다. 최신순이며 페이지당 30개다. 결과가 없으면 `선택한 조건에 해당하는 확정 경기가 없습니다.`를 표시한다.

표 위 상태 영역은 다음을 구분한다.

- `저장 기록 N경기`: 현재 GET 결과와 전체 건수
- `마감 회차 동기화 중 · 이번 요청 X/5`: POST 진행 중
- `동기화 완료`: 마지막 sweep에 오류·미확정 없음
- `일부 회차 미확정 N개`: `remainingUnresolvedRounds > 0`
- `다음 동기화 가능 YYYY.MM.DD HH:mm`: 쿨다운 중인 `PENDING`이 있을 때 `nextPendingRetryAt`을 한국시간으로 표시
- `동기화 실패`: 목록 전체 또는 D1 실패

제외 안내는 `취소 N · 미정 N · 배당누락 N · 팀매칭실패 N`을 항상 같은 순서로 표시하되 모두 0이면 접힌 요약만 표시할 수 있다. 특정 팀 필터에서는 팀매칭실패를 귀속할 수 없어 전체 팀일 때만 집계된다는 도움말을 제공한다. 제외 행은 표에 렌더링하지 않는다.

페이지 번호는 `1 … 현재 주변 … 마지막` 형태로 제공하고 처음·이전·다음·마지막 버튼을 둔다. `totalPages=0`일 때 현재 페이지 표시는 1, 이동 버튼은 모두 비활성화한다. 요청한 페이지가 마지막 페이지를 넘어 빈 결과가 되면 마지막 유효 페이지로 GET을 한 번 다시 요청한다.

## 11. 모듈 경계

구현 시 책임을 다음처럼 분리한다. 파일명은 기존 저장소 관례에 맞춘 권장 경계이며 동일 책임을 거대 `page.tsx`나 기존 현재 회차 모듈에 합치지 않는다.

| 책임 | 경계 |
|---|---|
| 익명 세션, 목록·상세 요청, 제한시간·크기 제한 | `app/lib/betman-history-adapter.ts` |
| 엄격 파싱, 결과·배당·제외 판정 | `app/lib/betman-history-parser.ts` |
| 날짜·리그·팀·cursor 입력 검증 | `app/lib/odds-history-contract.ts` |
| D1 조회, 회차 claim, 불변 upsert | `app/lib/odds-history-store.ts` |
| GET route | `app/api/odds-history/route.ts` |
| POST route | `app/api/odds-history/sync/route.ts` |
| 필터, 표, 페이지, 상태 UI | 별도 배당기록 컴포넌트 |

기존 `app/api/betman-odds/route.ts`, `app/lib/betman-parser.ts`, `app/lib/betman-matcher.ts`의 공개 계약은 변경하지 않는다. 공통으로 쓸 수 있는 리그/팀 별칭 레지스트리는 단일 원천을 유지하되, 과거 파서가 현재 회차 파서의 관대한 시장 선별 규칙을 그대로 재사용해서는 안 된다.

## 12. 테스트 설계

### 12.1 순수 단위 테스트

- 실제 달력 날짜, 윤년, 날짜 역전, 정확히 1년, 1년 초과
- 기본 최근 3개월의 월말 보정
- 리그와 `{leagueCode}:{teamId}` 검증
- cursor 구조·기간 결합·만료·변조/회차 불일치 거부
- `G101` 외 회차 거부와 회차 중복 제거·최신순 정렬
- 축구/K1/J1/일반/축구 승무패/`-`의 정확 선별
- 승·무·패 순서가 섞여도 라벨로 정확히 배치
- 배당 0, 음수, NaN, 누락, 중복 거부
- 점수와 H/D/A 결과 일치 및 모순 문서 거부
- 취소 > 미정 > 배당누락 > 팀매칭실패 우선순위
- 표준 팀명과 Betman 원문 팀명 동시 보존
- 명시적 별칭 정확 일치와 유사 문자열 거부
- 별칭 충돌 거부, 같은 이름의 리그 간 격리

### 12.2 어댑터 계약 테스트

Betman에서 비밀값을 제거해 저장한 고정 fixture로 다음을 검증한다.

- 익명 첫 요청의 쿠키가 같은 세션 상세 요청에 전달됨
- 외부 호스트 리디렉션, 로그인/차단 화면, HTTP 오류 거부
- 15초 제한과 3 MiB 제한
- 목록 페이지네이션이 기간 내 모든 회차를 찾음
- 회차 개최일 기준 포함과 발표일 추정 금지
- 상세 요청 동시 실행 수가 어느 시점에도 2를 넘지 않음
- 요청당 상세 시도 회차가 5를 넘지 않음
- 명시적 0경기와 비정상 빈 응답 구분

실 Betman 스모크 테스트는 읽기 전용으로 `G101` 한 회차만 수행하고 응답 본문·쿠키를 로그나 fixture에 그대로 남기지 않는다.

### 12.3 저장소 테스트

- 새 회차와 행의 원자적 삽입
- 미확정 행만 유효한 후속 값으로 갱신
- 확정 행에 같은 값이 오면 멱등, 다른 값이 오면 보존 후 `FINAL_CONFLICT`
- 오류·빈 응답·부분 파싱 실패에서 기존 행 수와 값 불변
- 동기화 경로가 `DELETE`를 실행하지 않음
- `FINAL` 회차 상세 재조회 없음
- `PENDING`은 `max(last_success_at, last_attempt_at)`에서 29분 59초에는 재조회하지 않고 30분 경계부터 재조회
- 쿨다운으로 건너뛸 때 `attempt_count`와 `last_attempt_at` 불변
- 만료 전 lease 중복 claim 방지와 만료 후 회복
- 팀 별칭 추가 뒤 `TEAM_MATCH_FAILED` 로컬 재매칭
- 날짜·리그·홈/원정 팀 필터와 제외 집계
- 최신순 안정 정렬, 30개 페이지, 동률 보조 정렬

### 12.4 API 통합 테스트

- GET 기본값, 명시 필터, 페이지 메타와 응답 스키마
- 잘못된 입력별 400 코드와 필드
- POST 첫 cursor와 이어받기, 변조·만료 cursor 거부
- 5회차 경계에서 `hasMore`, 마지막에서 `hasMore=false`
- 쿨다운 `PENDING`을 건너뛰면서 cursor가 전진하고 `deferredPendingRounds`·`nextPendingRetryAt`을 반환
- 두 상세 병렬 제한과 일부 회차 실패의 HTTP 200 `partial`
- 전체 Betman 실패 502, D1 실패 503
- 실패 뒤 기존 GET 기록 유지
- GET이 정상 완료 경기만 반환하고 네 제외 사유는 건수로만 반환

### 12.5 UI와 회귀 테스트

- 배당기록 진입 시 GET 결과가 POST 완료 전 먼저 렌더링됨
- `hasMore` cursor를 순차 소비하고 완료 뒤 GET 재호출
- 쿨다운 중인 `PENDING`에서 자동 반복 호출하지 않고 다음 동기화 가능 시각 표시
- 빠른 필터 변경, 메뉴 이탈, 페이지 변경에서 오래된 응답 무시
- 리그 변경 시 팀 목록 갱신과 무효 팀의 전체 팀 초기화
- 클라이언트 날짜 오류와 1년 초과 메시지
- 리그 열, 원문 팀명 보조 표시, 결과 배당 강조
- 30개 페이지 이동과 빈 결과
- 샘플 배열·샘플/데모 문구 부재
- 제외 건수와 완료·부분·실패 상태의 접근 가능한 `role=status`
- 기존 `/api/fixtures`, 순위 탭, 상세경기 H2H·Predictions·pre-match odds 동작
- 기존 `/api/betman-odds` GET/PUT과 현재 회차 10분 캐시
- 기존 `/api/market-predictions` GET/POST/DELETE와 저장 복원
- 타입 검사, 린트, 빌드, 전체 단위·렌더링 테스트, 읽기 전용 하네스

## 13. 완료 기준

다음 조건을 모두 만족해야 F-001 구현 완료로 판정한다.

- 배당기록에 하드코딩 샘플과 샘플/데모 문구가 없다.
- 기본 최근 3개월 D1 기록이 Betman 네트워크 응답보다 먼저 표시된다.
- K1/J1의 일반 축구 승무패 `-` 시장만 수집된다.
- 정상 완료 경기만 최신순 표에 나오며 결과와 최종 승·무·패 배당이 함께 표시된다.
- 표준 팀명과 Betman 원문 팀명이 D1 및 GET 계약에 모두 존재한다.
- 리그·팀·날짜 필터, 리그별 팀 갱신, 무효 팀 초기화, 30개 페이지가 동작한다.
- 날짜 역전, 불가능한 날짜, 1년 초과를 클라이언트와 서버가 모두 거부한다.
- 한 POST가 최대 5회차, 상세 동시 실행 최대 2개를 지키고 `hasMore`로 전체 sweep을 잇는다.
- `FINAL` 회차는 재조회하지 않고, `PENDING` 회차는 마지막 성공·시도 중 더 최근 시각에서 30분 이상 지난 경우에만 다음 sweep에서 네트워크 재조회한다.
- 확정 데이터는 오류, 빈 응답, 충돌, 범위 변경으로 삭제·변경되지 않는다.
- 취소·미정·배당누락·팀매칭실패가 사유별 건수로 안내되고 표에는 나오지 않는다.
- 조건을 빠르게 바꿔도 이전 요청 결과가 현재 화면을 덮지 않는다.
- 기존 경기·순위·현재 Betman·확률 저장 기능의 계약과 회귀 테스트가 통과한다.
- 신규 API 계약 테스트와 읽기 전용 Betman 스모크 검증이 통과한다.

## 14. 운영 관찰 항목

운영 로그와 상태 응답으로 다음 값을 확인할 수 있어야 한다.

- sync 요청별 발견·시도·성공·부분 실패 회차 수
- `PENDING`, `ERROR`, `FINAL` 회차 수
- 네 제외 사유별 행 수
- 확정값 충돌 횟수
- Betman 요청 지연과 오류 코드
- 마지막 성공 동기화 시각

이 값은 사용자 쿠키나 원천 전체 본문 없이 집계한다. 공급자 구조 변경은 `BETMAN_SCHEMA_CHANGED`, 확정값 불일치는 `FINAL_CONFLICT`로 분리해 데이터 부족과 코드 결함을 구별한다.
