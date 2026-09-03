# 데이터 출처

## API-Football

지원 리그는 K1=`292`와 J1=`98`입니다. 시즌 키는 리그별로 계산합니다. K1은 달력 연도를 사용하고, J1은 7월~12월 날짜를 다음 연도 키로, 1월~6월 날짜를 해당 연도 키로 사용합니다. 2026-27 J1의 API 키는 `season=2027`이며 통계 조회 시작은 `2026-07-01`로 잡아 실제 개막일 `2026-08-07`을 포함합니다.

```text
GET /fixtures?league={292|98}&season={leagueSeason}&from={today}&to={today+14}&timezone=Asia/Seoul
GET /fixtures?league={292|98}&season={leagueSeason}&from={leagueSeasonStart}&to={yesterday}&timezone=Asia/Seoul
GET /standings?league={292|98}&season={leagueSeason}
GET /fixtures/headtohead?h2h={homeId}-{awayId}&last=20&timezone=Asia/Seoul
GET /predictions?fixture={id}
GET /odds?fixture={id}
```

목록 공급자 요청은 `fixtures`와 `standings`만 사용합니다. cold 목록 조회는 K1과 J1 각각 upcoming fixtures, 조건부 past fixtures, standings의 세 요청으로 총 6회이며, 목록에서는 `fixtures/headtohead`를 요청하지 않습니다.

`GET /fixtures/headtohead?h2h={homeId}-{awayId}&last=20&timezone=Asia/Seoul`는 선택한 상세의 `/api/head-to-head`만 사용합니다. 서버는 응답에서 선택 kickoff 이전에 완료된 경기만 최신순으로 최대 10개 사용합니다. H2H cache miss에서는 H2H, Predictions, pre-match odds가 각각 한 번씩 요청됩니다.

API-Football 정상 응답은 D1 공유 캐시를 사용합니다. fixtures는 한국 날짜별 10분 fresh/60분 stale, H2H는 조합별 30분 fresh/24시간 stale, Predictions는 경기 ID별 10분 fresh/60분 stale, pre-match odds는 경기 ID별 30분 fresh/120분 stale입니다. 같은 키의 갱신은 D1 임대로 한 Worker만 수행합니다. HTTP 오류, API-Football `errors`, fixtures 부분 성공은 저장하지 않으며 공급자 오류를 자동 재시도하지 않습니다.

## 사전 배당의 빈 응답

API-Football 공급 범위는 리그·시즌·경기·bookmaker별로 다릅니다. 2026-08-13에 확인한 J1 `season=2027`은 `current=true`, `coverage.standings=true`, `coverage.odds=true`이며 2026-08-07부터 2027-06-06까지 한 개의 공식 20팀 순위표를 제공합니다. `season=2026`의 `coverage.odds=false`는 2026-02-06~2026-06-06에 끝난 동부/서부 전환 대회에 대한 값이며 현재 2026-27 시즌의 공급 범위를 뜻하지 않습니다. coverage가 true여도 개별 경기나 bookmaker에 배당이 없을 수 있으므로 빈 `bookmakers` 배열은 정상적인 데이터 없음으로 처리합니다.

사전 배당은 경기 전 데이터이며 과거 최종 배당을 복원하는 데이터 소스가 아닙니다. 경기 상세를 명시적으로 연 경우에만 `/api/pre-match-odds`를 호출하며, 정상 응답만 30분 D1 공유 캐시에 저장합니다. 화면은 bookmaker 선택상자를 사용하지 않고 응답에 포함된 모든 bookmaker를 응답 순서대로 표시합니다. 각 업체에서는 Match Winner만 Home / Draw / Away의 고정 순서로 소수 둘째 자리까지 표시하고, 세 값 중 하나라도 없으면 `미제공`으로 표시합니다.

## Betman

Betman은 사용자가 설정한 프로토 회차 URL에서 축구 시장과 선택지 배당을 읽습니다. 응답 구조가 정상이라면 경기나 배당이 0개여도 정상입니다. 회차 데이터는 10분 캐시됩니다.

팀 별칭은 `app/lib/team-aliases.ts`에서 관리합니다. 별칭을 추가할 때는 반드시 API-Football의 해당 리그·시즌 팀 ID를 먼저 확인하고, Betman 또는 공급자에서 실제로 확인한 표기만 같은 ID 아래에 추가합니다. 추정 표기나 다른 리그의 동명 팀을 등록하지 않습니다.

2026-08-22에는 2026-05-01~2026-05-17 마감게임에서 K1 팀명의 띄어쓰기·붙여쓰기 차이로 `TEAM_MATCH_FAILED`가 발생한 사실을 확인했습니다. 실제 응답에서 확인한 `FC서울`, `FC안양`, `울산 HDFC`, `울산HDFC`, `강원FC`, `광주FC`, `제주 SKFC`, `제주SKFC`, `부천FC1995`, `전북현대모터스`, `김천상무프로축구단`, `대전하나시티즌`, `인천유나이티드`, `포항스틸러스`를 해당 K1 API-Football 팀 ID의 명시적 별칭으로 등록했습니다. 별칭 추가 후 확정 실패 행을 원천 데이터 재수집이나 삭제 없이 로컬 재매칭했으며, 같은 기간 조회는 총 32개 기록, `teamMatchFailed=0`, 제외된 취소 경기 1건으로 확인했습니다.

2026-08-20 회차 `260098`에서 `FC도쿄 vs 제프 유나이티드` 표기를 확인했습니다. API-Football 팀 ID는 각각 FC Tokyo=`292`, JEF United Chiba=`301`이며, Betman의 축약 표기 `제프 유나이티드`를 J1 팀 ID `301`의 확인된 별칭으로 등록했습니다. 해당 경기의 일반 승무패 게임번호는 `5345`였습니다.

Betman 리그 표기는 실제 회차 응답을 기준으로 정규화합니다. J1은 `J1 League`, `일본 J리그`, `일본 J1리그` 표기를 모두 같은 리그로 처리합니다.

### 마감게임 최종 배당

배당기록 동기화는 고정 오리진의 Betman `G101` 마감게임을 요청마다 새 익명 세션으로 읽습니다. 로그인, 계정 식별자, 구매 요청과 사용자 쿠키는 사용하지 않습니다. K1/J1의 게임유형 `일반`, `축구 승무패`, 사전조건 `-`인 행만 엄격하게 선별하며, 정상 완료 결과와 양의 승·무·패 최종 배당 및 Betman 원문 팀명을 D1에 보존합니다.

`GET /api/odds-history`는 D1만 조회해 페이지당 30개와 취소·미정·배당누락·팀매칭실패 건수를 반환합니다. `POST /api/odds-history/sync`는 동기화 요청당 최대 5회차를 상세 동시 실행 최대 2개로 처리합니다. `PENDING`은 `max(last_success_at, last_attempt_at)`부터 30분 쿨다운하며, `FINAL` 회차와 확정 경기 행은 원천 오류·빈 응답·충돌로 덮어쓰거나 삭제하지 않습니다. 이 아카이브는 기존 현재 회차 `/api/betman-odds`의 설정·캐시·응답을 변경하지 않습니다.

## 비밀값

`API_FOOTBALL_KEY`는 로컬 `.dev.vars`에만 둡니다. 키는 Git, 문서, 테스트 출력, 로그, 커밋 메시지에 기록하지 않습니다.
`API_FOOTBALL_KEY`는 서버 route에서만 사용하며 Browser에 전달하지 않는다.
