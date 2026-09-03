# Read-only regression harness

실행 중인 앱을 HTTP 경계에서 검증하는 Node.js 하네스입니다. 앱 소스나 D1 데이터를 변경하지 않습니다.

## 실행

```powershell
Set-Location harness
npm.cmd test
npm.cmd run all -- --base-url http://127.0.0.1:3000
```

선택 가능한 프로필은 `smoke`, `contracts`, `data`, `all`입니다. 하네스 자체 기본 주소는 `http://127.0.0.1:5173`이지만 Vinext 개발 서버는 기본적으로 `http://localhost:3000`을 사용하므로, 실행 시 터미널에 출력된 주소를 `--base-url URL`로 넘기는 것을 권장합니다. `--base-url`은 `HARNESS_BASE_URL`보다 우선합니다. 알 수 없는 옵션, URL 없는 `--base-url`, 중복 옵션, 잘못된 URL은 실행 전에 거부합니다. 시간 제한은 `HARNESS_TIMEOUT_MS`(기본 15000ms)입니다.

```powershell
$env:HARNESS_FIXTURE_ID='1507031'
npm.cmd run contracts
```

`HARNESS_FIXTURE_ID`가 있으면 Predictions와 pre-match odds를 그 fixture로 조회합니다. 없으면 fixtures 응답의 첫 경기 ID를 사용합니다. 예정 경기가 없으면 두 fixture별 검사는 SKIP입니다.

## 범위

- `/api/fixtures`의 K1=`292`, J1=`98` 메타, 날짜 기준 리그별 시즌 키, `standingsByLeague`, 공통 14일 일정 범위를 검증합니다. J1 순위가 있으면 한 개의 20팀 표와 고유 rank/team ID를 요구합니다.
- `/api/pre-match-odds?fixture={id}`는 fixture ID를 얻은 뒤에만 GET으로 검증합니다. bookmaker가 0개여도 통과하며, 제공된 항목은 ID·이름·양수 배당을 검증합니다.
- `/api/betman-odds`, `/api/market-predictions`, `/api/predictions`의 읽기 계약도 검증합니다.

## 안전 규칙

- 요청 메서드는 GET뿐입니다.
- `/api/betman-odds` PUT, `/api/market-predictions` POST/DELETE를 호출하지 않습니다.
- API 키 또는 `.dev.vars` 값을 읽거나 출력하지 않습니다.
- 공급자 데이터가 없는 경우는 SKIP 또는 정상 빈 배열로 처리하지만, 응답 구조와 업무 규칙 위반은 FAIL입니다.
