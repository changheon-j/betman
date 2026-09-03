# API-Football 공유 캐시 및 중복 호출 방지 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 네 API-Football 경로에 D1 공유 정상응답 캐시, 중복 갱신 방지, 오류 미저장과 stale fallback을 적용한다.

**Architecture:** `app/lib/shared-api-cache.ts`가 상태 전이와 in-flight 병합을, `db/api-response-cache.ts`가 D1 정상값과 원자적 갱신 임대를 담당한다. 각 route는 기존 공급자 로더와 응답 계약을 유지한 채 공통 캐시 정책을 적용한다.

**Tech Stack:** TypeScript, Vinext, Cloudflare Workers, Cloudflare D1, Drizzle, Node test runner

**Spec:** `docs/superpowers/specs/2026-09-03-api-football-shared-cache-design.md`

## Global Constraints

- 오류와 fixtures 부분 성공은 저장하지 않는다.
- 동일 키의 동시 갱신은 공급자 호출 한 번만 허용한다.
- D1 장애 시 공급자 직접 호출로 우회하지 않는다.
- 기존 화면과 API JSON 계약을 유지한다.

### Task 1: 공통 캐시 조정 모듈

- [x] fresh/stale/오류/부분응답/in-flight/분산 follower 실패 테스트 작성
- [x] `getOrRefreshShared` 최소 구현 및 집중 검증
- [x] 체크포인트 커밋 `74619a9`

### Task 2: D1 저장소와 갱신 임대

- [x] D1 읽기·임대·토큰 조건부 저장/해제 실패 테스트 작성
- [x] `api_response_cache` 스키마와 `0006_hard_scarecrow.sql` 생성
- [x] 이전 임대 소유자 덮어쓰기 차단 검증
- [x] 체크포인트 커밋 `22ff803`

### Task 3: API-Football 네 경로 연결

- [x] fixtures 완전 성공만 저장하고 부분 성공은 `uncached` 반환
- [x] Predictions, pre-match odds, H2H의 공유 캐시와 stale fallback 적용
- [x] `X-Cache-Status` 및 기존 오류 상태 회귀 테스트
- [x] 체크포인트 커밋 `99f38d8`

### Task 4: 문서와 전체 검증

- [x] README와 구조·데이터·운영·결정 문서 갱신
- [x] typecheck, lint, build, 전체 단위 테스트 220개, rendered HTML 1개 검증
- [x] harness 단위 테스트 30개 및 로컬/분산 동시 요청 자동 테스트 검증
- [ ] 최종 검토와 완료 기록
