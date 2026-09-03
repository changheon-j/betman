# 기능 단위 세션 관리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 현재 Codex 작업을 프로젝트 리딩 작업으로 설정하고, 기능별 설계·개발·테스트 작업을 순차 관리할 수 있는 저장소 등록부와 운영 절차를 도입한다.

**Architecture:** 저장소의 `docs/SESSION-REGISTRY.md`를 기능 ID, 상태, 작업 ID, 브랜치와 산출물 경로의 단일 기준으로 사용한다. 현재 작업은 이름과 고정 상태만 변경하고, 기능 작업은 첫 실제 기능 요청부터 전용 worktree에서 설계 → 개발 → 테스트 순으로 생성한다. 테스트 결과는 리딩 작업이 별도 Markdown 보고서로 저장한다.

**Tech Stack:** Codex desktop task management, Git branches/worktrees, Markdown, PowerShell

**Spec:** `docs/superpowers/specs/2026-08-20-session-management-design.md`

## Global Constraints

- 현재 작업은 프로젝트 리딩·오더·승인 전용 작업으로 유지한다.
- 활성 기능은 초기 운영에서 한 번에 하나만 허용한다.
- 설계, 개발, 테스트 작업은 승인 단계에 따라 순차 생성한다.
- 기능마다 `codex/f-###-짧은-기능명` 전용 브랜치와 worktree를 사용한다.
- 테스트 작업은 코드와 문서를 수정하지 않는 읽기 전용 검증 역할이다.
- 테스트 실패는 개발 작업으로 회송하고 같은 테스트 작업에서 재검증한다.
- 테스트 통과만으로 병합·푸시·보관하지 않으며 사용자 최종 승인을 요구한다.
- 기존 `main`의 미커밋 변경과 개발 서버 로그를 수정·삭제·스테이징하지 않는다.
- 예제나 빈 기능 작업을 만들지 않고 첫 실제 기능 요청에 `F-001`을 부여한다.
- 현재 OpenAI 공식 문서에서 보관된 Codex 작업의 고정 UI 경로가 확인되지 않았으므로 작업 ID와 등록부를 복원 기준으로 사용한다.

---

## File Structure

- Create `docs/SESSION-REGISTRY.md`: 다음 기능 ID, 활성 기능, 대기 목록, 기능별 단계·작업 ID·브랜치·산출물·날짜를 관리하는 단일 등록부.
- Create `docs/SESSION-WORKFLOW.md`: 리딩·설계·개발·테스트 역할, 단계 승인, 회송, Git 격리, 보관·복원 절차를 설명하는 운영 안내.
- Create on demand `docs/session-reports/F-###-test.md`: 각 기능의 테스트 증거를 리딩 작업이 저장. 초기 도입에서는 가짜 보고서를 만들지 않는다.
- Configure current Codex task: 제목을 `[리딩] Betting Analysis System`으로 바꾸고 고정.

---

### Task 1: 세션 등록부 생성

**Files:**
- Create: `docs/SESSION-REGISTRY.md`
- Reference: `docs/superpowers/specs/2026-08-20-session-management-design.md`

**Interfaces:**
- Produces: 다음 기능 ID `F-001`
- Produces: 상태 집합 `요청 | 설계 중 | 설계 승인 | 개발 중 | 테스트 중 | 수정 필요 | 최종 승인 | 보관 | 취소`
- Produces: 리딩 작업이 단독으로 갱신하는 기능·작업 매핑 표

- [ ] **Step 1: 등록부 부재를 확인한다**

Run:

```powershell
if (Test-Path -LiteralPath 'docs\SESSION-REGISTRY.md') { throw 'SESSION-REGISTRY.md already exists' }
```

Expected: 명령이 출력 없이 exit code 0으로 끝난다.

- [ ] **Step 2: 초기 등록부를 생성한다**

Create `docs/SESSION-REGISTRY.md` with this exact structure:

```markdown
# 세션 등록부

최종 갱신일: 2026-08-20

## 운영 상태

- 다음 기능 ID: `F-001`
- 활성 기능: 없음
- 동시 진행 정책: 활성 기능 1개
- 리딩 작업: `[리딩] Betting Analysis System`
- 운영 절차: `docs/SESSION-WORKFLOW.md`

## 기능 대기 목록

현재 등록된 대기 기능이 없습니다.

## 기능 세션

현재 생성된 기능 세션이 없습니다.

기능을 등록할 때 아래 열을 사용합니다.

| 기능 ID | 기능명 | 상태 | 우선순위 | 브랜치/worktree | 설계 작업 | 개발 작업 | 테스트 작업 | 설계서 | 구현 계획 | 테스트 보고서 | 최신 결과 | 남은 문제 | 생성일 | 완료일 | 보관일 |
|---|---|---|---:|---|---|---|---|---|---|---|---|---|---|---|---|

## 상태 규칙

허용 상태는 `요청`, `설계 중`, `설계 승인`, `개발 중`, `테스트 중`, `수정 필요`, `최종 승인`, `보관`, `취소`입니다.

- 리딩 작업만 이 등록부를 수정합니다.
- 설계·개발·테스트 작업은 결과를 리딩 작업에 보고합니다.
- 첫 실제 기능 요청에 `F-001`을 발급하고 다음 기능 ID를 `F-002`로 올립니다.
- 기능 작업은 설계 승인과 개발 완료를 확인한 뒤 단계별로 하나씩 생성합니다.
- 사용자 최종 승인 전에는 병합·푸시·보관하지 않습니다.
- 보관된 작업은 등록된 작업 ID로 찾아 열거나 보관 해제합니다.

## 테스트 보고서 규칙

리딩 작업은 테스트 결과를 `docs/session-reports/F-###-test.md`에 저장합니다. 보고서에는 검사한 브랜치와 커밋 SHA, 실행 환경, 명령, 통과·실패·건너뜀 수, 화면 또는 API 증거, 발견 결함, 최종 판정을 기록합니다.
```

- [ ] **Step 3: 등록부 계약을 검증한다**

Run:

```powershell
$registry = Get-Content -Raw -Encoding UTF8 -LiteralPath 'docs\SESSION-REGISTRY.md'
$required = @('다음 기능 ID: `F-001`','활성 기능: 없음','활성 기능 1개','[리딩] Betting Analysis System','docs/SESSION-WORKFLOW.md','설계 중','수정 필요','보관','docs/session-reports/F-###-test.md')
$missing = $required | Where-Object { -not $registry.Contains($_) }
if ($missing) { throw "등록부 필수 항목 누락: $($missing -join ', ')" }
```

Expected: 명령이 출력 없이 exit code 0으로 끝난다.

- [ ] **Step 4: 문서 검사 후 커밋한다**

Run:

```powershell
git diff --check -- docs/SESSION-REGISTRY.md
git add -- docs/SESSION-REGISTRY.md
git commit -m "docs: add feature session registry"
```

Expected: 새 등록부 한 파일만 커밋된다.

---

### Task 2: 세션 운영 안내 생성

**Files:**
- Create: `docs/SESSION-WORKFLOW.md`
- Reference: `docs/SESSION-REGISTRY.md`
- Reference: `docs/superpowers/specs/2026-08-20-session-management-design.md`

**Interfaces:**
- Consumes: Task 1의 `docs/SESSION-REGISTRY.md`
- Produces: 기능 요청부터 작업 보관까지의 사용자용 운영 절차

- [ ] **Step 1: 운영 안내 부재를 확인한다**

Run:

```powershell
if (Test-Path -LiteralPath 'docs\SESSION-WORKFLOW.md') { throw 'SESSION-WORKFLOW.md already exists' }
```

Expected: 명령이 출력 없이 exit code 0으로 끝난다.

- [ ] **Step 2: 운영 안내를 생성한다**

Create `docs/SESSION-WORKFLOW.md` with this exact content:

````markdown
# 기능 세션 운영 안내

기능 작업의 현재 상태와 작업 ID는 `docs/SESSION-REGISTRY.md`를 단일 기준으로 사용합니다. 상세 설계는 `docs/superpowers/specs/2026-08-20-session-management-design.md`를 참조합니다.

## 리딩 작업

- `[리딩] Betting Analysis System`은 기능 요청, 우선순위, 단계 승인, 최종 승인을 관리합니다.
- 리딩 작업만 세션 등록부와 테스트 보고서를 수정합니다.
- 활성 기능은 기본적으로 하나만 허용합니다.

## 기능 진행 순서

1. 리딩 작업에서 요청과 성공 기준을 확정합니다.
2. 등록부에서 `F-###` 기능 ID를 발급합니다.
3. `codex/f-###-기능명` 브랜치와 worktree에서 설계 작업을 만듭니다.
4. 사용자가 설계서와 구현 계획을 승인한 뒤 개발 작업을 만듭니다.
5. 개발 완료 뒤 같은 기능 브랜치와 worktree를 검증하는 테스트 작업을 만듭니다.
6. 테스트 실패는 개발 작업으로 회송하고 같은 테스트 작업에서 재검증합니다.
7. 테스트 통과 뒤 사용자가 최종 승인합니다.
8. 승인된 방식으로 브랜치를 반영하고 세 작업을 보관합니다.

## 작업 이름

```text
[설계][F-001] 기능명
[개발][F-001] 기능명
[테스트][F-001] 기능명
````

## 역할 경계

- 설계 작업은 설계서와 구현 계획만 작성하고 제품 코드를 수정하지 않습니다.
- 개발 작업은 승인된 계획만 구현하고 검증 결과를 보고합니다.
- 테스트 작업은 읽기 전용이며 결함을 수정하지 않습니다. 실패 결과는 개발 작업으로 회송합니다.
- 테스트 작업은 등록부를 수정하지 않고 리딩 작업에 결과를 보고합니다.

## 테스트 보고서

리딩 작업은 테스트 결과를 `docs/session-reports/F-###-test.md`에 저장합니다. 보고서에는 브랜치와 커밋 SHA, 실행 환경, 명령, 통과·실패·건너뜀 수, 화면 또는 API 증거, 발견 결함, 최종 판정을 기록합니다.

## 보관과 복원

- 사용자 최종 승인과 등록부·보고서 갱신 뒤 설계·개발·테스트 작업을 함께 보관합니다.
- 보관은 삭제가 아닙니다.
- 보관된 작업은 등록부의 작업 ID로 열거나 보관 해제합니다.
- 완료 기능에 추가 변경이 필요하면 새 기능 또는 수정 주기를 등록합니다.
```

- [ ] **Step 3: 운영 안내 계약을 검증한다**

Run:

```powershell
$workflow = Get-Content -Raw -Encoding UTF8 -LiteralPath 'docs\SESSION-WORKFLOW.md'
$required = @('docs/SESSION-REGISTRY.md','[리딩] Betting Analysis System','codex/f-###-기능명','[설계][F-001] 기능명','테스트 작업은 읽기 전용','docs/session-reports/F-###-test.md','보관은 삭제가 아닙니다')
$missing = $required | Where-Object { -not $workflow.Contains($_) }
if ($missing) { throw "운영 안내 필수 항목 누락: $($missing -join ', ')" }
git diff --check -- docs/SESSION-WORKFLOW.md
```

Expected: 필수 운영 규칙이 모두 존재하고 whitespace 오류가 없다.

- [ ] **Step 4: 운영 안내만 커밋한다**

Run:

```powershell
git add -- docs/SESSION-WORKFLOW.md
git diff --cached --check
git commit -m "docs: add session workflow guide"
```

Expected: 새 운영 안내 한 파일만 커밋되고 기존 미커밋 파일은 그대로 남는다.

---

### Task 3: 현재 작업을 프로젝트 리딩 작업으로 설정

**Files:**
- No repository file changes

**Interfaces:**
- Consumes: current Codex thread
- Produces: title `[리딩] Betting Analysis System`
- Produces: pinned state `true`

- [ ] **Step 1: 현재 작업 제목과 프로젝트를 확인한다**

Use the Codex task listing capability and locate the calling task whose workspace is `C:\Users\USER\OneDrive\문서\betting analysis system`. Record its thread ID in the execution report; do not add it to source control because the current task itself does not need a registry row.

Expected: exactly one active calling task is identified.

- [ ] **Step 2: 현재 작업 제목을 변경한다**

Use the Codex task title capability with:

```text
[리딩] Betting Analysis System
```

Expected: the current task title changes without creating another task.

- [ ] **Step 3: 현재 작업을 고정한다**

Use the Codex task pin capability with the current task ID and `pinned=true`.

Expected: the task appears in the pinned task collection.

- [ ] **Step 4: 리딩 작업 설정을 검증한다**

List Codex tasks again and assert:

```text
title = [리딩] Betting Analysis System
pinned = true
cwd = C:\Users\USER\OneDrive\문서\betting analysis system
```

Expected: 세 조건이 모두 일치하며 새 설계·개발·테스트 작업은 생성되지 않았다.

---

### Task 4: 세션 관리 도입 전체 검증

**Files:**
- Verify: `docs/SESSION-REGISTRY.md`
- Verify: `docs/SESSION-WORKFLOW.md`
- Verify: `docs/superpowers/specs/2026-08-20-session-management-design.md`
- Verify: current Codex task metadata

**Interfaces:**
- Consumes: Tasks 1-3 outputs
- Produces: 첫 실제 기능을 `F-001`로 시작할 수 있는 검증된 기준선

- [ ] **Step 1: 설계 요구사항의 문서 반영을 검사한다**

Run:

```powershell
$registry = Get-Content -Raw -Encoding UTF8 -LiteralPath 'docs\SESSION-REGISTRY.md'
$workflow = Get-Content -Raw -Encoding UTF8 -LiteralPath 'docs\SESSION-WORKFLOW.md'
$checks = @(
  $registry.Contains('다음 기능 ID: `F-001`'),
  $registry.Contains('활성 기능: 없음'),
  $registry.Contains('docs/SESSION-WORKFLOW.md'),
  $registry.Contains('docs/session-reports/F-###-test.md'),
  $workflow.Contains('테스트 작업은 읽기 전용'),
  $workflow.Contains('보관은 삭제가 아닙니다')
)
if ($checks -contains $false) { throw '세션 관리 문서 계약이 불완전합니다' }
```

Expected: exit code 0.

- [ ] **Step 2: 저장소 변경의 공백과 스테이징 상태를 검사한다**

Run:

```powershell
git diff --check
git diff --cached --check
git status --short
```

Expected: whitespace 오류가 없고, 기존 미커밋 파일과 개발 서버 로그는 그대로 남아 있으며 세션 관리 작업이 이들을 삭제하거나 덮어쓰지 않았다.

- [ ] **Step 3: 리딩 작업과 작업 수를 검사한다**

List Codex tasks and confirm:

- `[리딩] Betting Analysis System`이 고정돼 있다.
- 이 도입 과정에서 `[설계][F-001]`, `[개발][F-001]`, `[테스트][F-001]` 작업을 만들지 않았다.
- 첫 실제 기능 요청을 받을 때만 `F-001` 설계 작업을 생성한다.

- [ ] **Step 4: 최종 운영 상태를 보고한다**

Report exactly:

```text
리딩 작업: 설정 완료
다음 기능 ID: F-001
활성 기능: 없음
기능 작업: 0개
기존 미커밋 변경: 보존
다음 행동: 첫 기능 요청 접수 후 F-001 설계 작업 생성
```

Expected: 사용자가 별도 복구 작업 없이 현재 리딩 작업에서 첫 기능 요청을 시작할 수 있다.
