# 1차 안정성 개선 설계

## 목표

현재 개인 테스트용 흐름을 유지하면서 저장된 확률의 게임유형 연결 오류를 방지하고, Betman 회차 교체·저장 API·Windows 개발환경의 안정성을 높인다.

## 범위

1. Betman 시장의 안정적인 저장 키
2. Betman 응답 구조 검증과 사용자 주도 URL 교체
3. 저장 API 입력값 검증 강화
4. Windows 실행 및 TypeScript 검사 정상화
5. 관련 테스트와 프로젝트 문서 업데이트

사용자 인증과 사용자별 데이터 분리는 공개 배포 단계로 미루며 이번 범위에 포함하지 않는다.

## 1. 안정적인 Betman 시장 식별자

확률 입력과 저장 내역의 시장 식별자는 배열 순번인 `marketIndex` 대신 다음 값으로 구성한다.

```text
fixture:{API-Football 경기 ID}|round:{Betman gmTs}|game:{Betman matchSeq}
```

- `gmTs`는 사용자가 저장한 Betman 프로토 회차를 구분한다.
- `matchSeq`는 해당 회차의 개별 게임유형을 구분한다.
- API 요청과 D1에는 `betmanRound`, `matchSeq`를 별도 필드로 저장한다.
- 화면의 입력 상태와 저장 복원도 같은 식별자를 사용한다.
- 옵션 복원 시 저장된 라벨 배열과 현재 Betman 옵션 라벨 배열이 같을 때만 확률을 복원한다.
- 기존 `marketIndex`는 과거 저장 내역 표시 호환을 위해 유지하되 새로운 식별 키로 사용하지 않는다.

기존 레코드는 조회와 삭제가 가능하다. `betmanRound`와 `matchSeq`가 없는 기존 레코드는 새 배당 행에 자동 복원하지 않아 잘못된 시장에 확률이 표시되는 것을 방지한다.

## 2. Betman URL 교체와 응답 검증

Betman URL은 자동으로 변경하지 않는다. 사용자가 경기 메뉴의 URL 입력란에서 저장 버튼을 누른 경우에만 기존 단일 회차 URL을 새 URL로 교체한다.

주중·주말 경기별 배당 공개 시점이 다르므로 정상 Betman 응답의 경기 또는 배당이 0건인 경우도 유효한 회차로 저장할 수 있다. 화면에는 기존 규칙대로 `현재 배당이 확정되지 않았습니다`를 표시한다.

저장 성공 조건은 데이터 건수가 아니라 응답 구조다.

- Betman 화면과 배당 조회 요청이 HTTP 수준에서 성공해야 한다.
- 응답 루트가 객체여야 한다.
- `compSchedules`가 객체이고 `keys`, `datas`가 배열이어야 한다.
- `datas`가 빈 배열인 것은 정상으로 허용한다.
- 구조가 없거나 타입이 다르면 스크래핑 구조 오류로 처리하고 기존 URL을 유지한다.

검증이 끝난 후에만 D1의 단일 슬롯을 교체한다. 저장 과정에서 실패하면 기존 URL과 캐시는 유지한다.

## 3. 저장 API 입력값 검증

`POST /api/market-predictions`는 값의 자동 숫자 변환에 의존하지 않는다.

- `matchId`: 실제 JSON number, 양의 safe integer
- `marketIndex`: 실제 JSON number, 0 이상의 safe integer
- `betmanRound`: 숫자로만 구성된 비어 있지 않은 문자열
- `matchSeq`: 숫자로만 구성된 비어 있지 않은 문자열
- `matchDate`: 실제 존재하는 `YYYY-MM-DD` 날짜
- `kickoffTime`: `HH:mm` 형식의 유효한 시간
- 팀명, 게임유형, 옵션 라벨: 공백 제거 후 비어 있지 않고 길이 제한 준수
- 배당: 실제 JSON number이며 0보다 큰 유한값
- 확률: 실제 JSON number이며 `0~1` 범위
- 선택지: 2개 또는 3개, 라벨 중복 불가
- 확률합: `1.000 ± 0.001`

기대수익은 서버에서 `확률 × 배당 - 1`로 다시 계산한다.

## 4. 스키마와 마이그레이션

`market_predictions`에 다음 열을 추가한다.

- `betman_round TEXT`
- `match_seq TEXT`

기존 데이터 보존을 위해 두 열은 마이그레이션에서 nullable로 추가한다. 신규 저장 API에서는 두 값을 필수로 받고 저장한다. Drizzle 스키마와 런타임 조회·저장 SQL을 함께 변경한다.

새 레코드의 `prediction_key`는 새로운 시장 식별자를 사용한다. 기존 키 레코드는 그대로 유지되므로 조회와 삭제가 가능하다.

## 5. 개발환경 정비

- `package.json`의 Unix 전용 환경변수 접두사를 제거한다. 필요한 Wrangler 경로 설정은 이미 `vite.config.ts`에서 크로스플랫폼 방식으로 수행한다.
- `typecheck` 스크립트를 추가한다.
- Cloudflare Workers와 D1 타입 선언을 프로젝트 TypeScript 설정에 연결한다.
- H2H 실패 분기의 빈 배열 타입을 `ApiFixture[]`로 명확히 지정한다.
- D1 조회 결과의 행 타입을 선언해 암시적 `any`를 제거한다.

## 6. 테스트 전략

구현 전 실패 테스트를 먼저 추가한다.

- 회차와 `matchSeq`가 다른 시장은 서로 다른 저장 키를 생성한다.
- 기존 레코드는 조회 가능하지만 현재 배당 입력으로 자동 복원하지 않는다.
- Betman `datas: []` 응답은 유효하고, `compSchedules`가 없는 응답은 거부한다.
- `null`, 빈 문자열, boolean 숫자 입력을 거부한다.
- 윤년과 존재하지 않는 날짜, 잘못된 시간을 구분한다.
- Windows 호환 스크립트, TypeScript 검사, lint, 프로덕션 빌드가 성공한다.
- 기존 렌더링 테스트와 블랙박스 하네스를 함께 실행한다.

## 7. 문서 업데이트

다음 문서에 새 저장 키, 마이그레이션, Betman 0건 허용 규칙, 사용자 주도 URL 교체, 실행·검증 명령을 반영한다.

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/DATA-SOURCES.md`
- `docs/DECISIONS.md`
- `docs/OPERATIONS.md`
- `docs/PRODUCT.md`
- `docs/ROADMAP.md`

## 제외 범위

- URL 자동 탐색 또는 자동 교체
- Betman 회차 주기적 갱신
- 사용자 인증과 사용자별 데이터 분리
- 기존 레코드의 `gmTs`, `matchSeq` 자동 추론
- Betman 배당 원문 전체의 장기 보관
