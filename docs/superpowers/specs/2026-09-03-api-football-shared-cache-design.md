# API-Football 공유 캐시 및 중복 호출 방지 설계

## 목표와 범위

API-Football을 사용하는 fixtures, Predictions, pre-match odds, head-to-head 네 경로에 D1 공유 정상응답 캐시를 적용한다. Betman, 사용자 저장 데이터, 화면 계약은 변경하지 않는다.

## 캐시 정책

| 경로 | 키 | fresh | stale |
|---|---|---:|---:|
| fixtures | `fixtures:v1:{KST 날짜}` | 10분 | 60분 |
| Predictions | `predictions:v1:{fixtureId}` | 10분 | 60분 |
| pre-match odds | `pre-match-odds:v1:{fixtureId}` | 30분 | 120분 |
| H2H | `head-to-head:v1:{fixtureId}:{homeId}:{awayId}:{kickoff}` | 30분 | 24시간 |

`api_response_cache`는 정상 JSON, 조회시각, fresh/stale 만료시각과 15초 갱신 임대 토큰을 저장한다. 같은 Worker의 요청은 in-flight Promise를 공유하고 여러 Worker는 D1 조건부 upsert로 한 실행자만 임대를 획득한다. cold follower는 최대 3초 동안 정상값을 기다리며 임대 없이 공급자를 호출하지 않는다.

HTTP 오류, API-Football `errors`, fixtures 부분 성공은 저장하지 않는다. 갱신 실패 시 stale 기간 안의 마지막 정상값을 반환하고, 정상값이 없으면 기존 429/502 또는 공유 캐시 503을 반환한다. 성공 응답은 `X-Cache-Status: fresh | refreshed | stale | uncached`를 제공한다.

## 안전 조건

- API 키, 임대 토큰, 오류 원문은 캐시에 저장하거나 브라우저에 노출하지 않는다.
- 저장과 임대 해제는 캐시 키와 임대 토큰이 모두 일치할 때만 수행한다.
- D1 장애를 메모리 캐시나 공급자 직접 호출로 우회하지 않는다.
- fixtures는 두 리그가 모두 성공할 때만 저장하고 부분 성공 UI 계약은 유지한다.
- API-Football 자체 장애나 실제 구독량 소진은 제거할 수 없으며 중복 요청과 오류 고착을 방지하는 것이 본 설계의 책임이다.

## 검증

fresh hit의 공급자 호출 0회, 동일 인스턴스 동시 요청의 로더 1회, 분산 임대 소유자 1명, 오류 미저장, stale fallback, 이전 임대 소유자의 덮어쓰기 차단을 단위 테스트한다. 네 경로의 기존 JSON/HTTP 계약과 전체 빌드·하네스를 회귀 검증한다.

