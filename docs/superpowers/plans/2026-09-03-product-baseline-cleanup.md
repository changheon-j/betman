# Product Baseline Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove transient development logs and align active documentation with the current data-and-recording product while retiring only future in-house prediction plans.

**Architecture:** This is a documentation and repository-hygiene change only. Preserve application code, APIs, D1 data, local secrets, and completed historical specs/plans; establish the current product baseline through active documents and a dedicated evolution record.

**Tech Stack:** Markdown, Git ignore rules, PowerShell, Git, Vinext/TypeScript validation

**Spec:** `docs/superpowers/specs/2026-09-03-product-baseline-cleanup-design.md`

## Global Constraints

- Keep the current API-Football Predictions screen and `/api/predictions` implementation unchanged.
- Remove only future plans for in-house prediction models, automatic probability generation, model training, calibration, and backtesting.
- Do not modify application source, API contracts, D1 schema, D1 rows, `.dev.vars`, or `.wrangler/`.
- Preserve completed files under `docs/superpowers/specs` and `docs/superpowers/plans` as historical records.
- Delete only the four named untracked development-server logs after validating their exact paths and Git status.
- Preserve all pre-existing approved worktree changes; never reset, restore, or overwrite unrelated changes.
- The worktree is detached and already contains approved uncommitted work. Inspect each staged diff before committing and stage only the files named by the current task.

---

### Task 1: Remove transient development logs and prevent recurrence

**Files:**
- Modify: `.gitignore:25-32`
- Delete if present: `.codex-dev-server.err.log`
- Delete if present: `.codex-dev-server.out.log`
- Delete if present: `.codex-devserver.err.log`
- Delete if present: `.codex-devserver.out.log`

**Interfaces:**
- Consumes: the repository root and Git index
- Produces: ignore rules for `.codex-dev-server*.log` and `.codex-devserver*.log`; no tracked or untracked server log files

- [ ] **Step 1: Confirm the four targets are inside the current worktree and are untracked**

Run from the worktree root:

```powershell
$workspaceRoot = (Resolve-Path -LiteralPath '.').Path
$logTargets = @(
  '.codex-dev-server.err.log',
  '.codex-dev-server.out.log',
  '.codex-devserver.err.log',
  '.codex-devserver.out.log'
)
$logTargets | ForEach-Object {
  $candidate = Join-Path $workspaceRoot $_
  [PSCustomObject]@{
    Name = $_
    Exists = Test-Path -LiteralPath $candidate
    FullName = [System.IO.Path]::GetFullPath($candidate)
  }
}
git status --short -- $logTargets
git ls-files -- $logTargets
```

Expected: every `FullName` starts with `$workspaceRoot`; existing targets appear only as `??`; `git ls-files` prints nothing.

- [ ] **Step 2: Add exact ignore rules**

Add under `# debug` in `.gitignore`:

```gitignore
.codex-dev-server*.log
.codex-devserver*.log
```

- [ ] **Step 3: Verify the ignore behavior before deletion**

Run:

```powershell
git check-ignore -v .codex-dev-server.err.log .codex-dev-server.out.log .codex-devserver.err.log .codex-devserver.out.log
```

Expected: all four names resolve to one of the two new `.gitignore` rules.

- [ ] **Step 4: Delete only the validated files**

Run:

```powershell
Remove-Item -LiteralPath '.codex-dev-server.err.log' -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath '.codex-dev-server.out.log' -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath '.codex-devserver.err.log' -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath '.codex-devserver.out.log' -Force -ErrorAction SilentlyContinue
```

Expected: no recursive deletion and no other file removal.

- [ ] **Step 5: Verify cleanup and protected local state**

Run:

```powershell
Get-Item -LiteralPath '.dev.vars' -ErrorAction Stop | Select-Object FullName,Length
Get-ChildItem -LiteralPath '.wrangler' -Force -ErrorAction Stop | Select-Object -First 1 FullName
git status --short
```

Expected: the four log files do not appear; `.dev.vars` and `.wrangler/` still exist.

- [ ] **Step 6: Commit the repository-hygiene rule**

Run:

```powershell
git add -- .gitignore
git diff --cached --check
git diff --cached --name-status
git commit -m "chore: ignore local development logs"
```

Expected staged file: `.gitignore` only.

---

### Task 2: Establish the current product baseline and evolution record

**Files:**
- Create: `docs/PRODUCT-EVOLUTION.md`
- Modify: `README.md:1-16`
- Modify: `docs/PRODUCT.md:3-35`

**Interfaces:**
- Consumes: the approved definition in the spec and the existing current-product descriptions
- Produces: one authoritative current scope and one historical initial-to-current narrative

- [ ] **Step 1: Create the product evolution document**

Create `docs/PRODUCT-EVOLUTION.md` with these sections and facts:

```markdown
# 제품 변화 기록

## 출발점

최초 저장소는 Vinext 전체 스택 starter였고, 첫 제품 화면은 정적 K리그1 샘플 일정·순위·관심 경기와 데모 상세정보를 표시하는 경기 안내 화면이었다.

## 현재까지의 변화

1. K리그1 샘플을 API-Football 실제 일정·순위로 교체
2. J리그1과 리그별 시즌 규칙 추가
3. 명시적 경기 선택 기반 상세 분석, 최근 경기, 맞대결 추가
4. API-Football Predictions와 사전 배당을 외부 참고정보로 추가
5. Betman 현재 회차 배당의 보수적 경기 연결 추가
6. Betman 마감 경기 결과·최종 배당의 D1 아카이브 추가
7. 사용자 확률·기대수익과 단일 선택 표시의 D1 기록 추가

## 현재 제품 기준선

현재 제품은 K1·J1 실제 경기 정보와 공개 배당을 조회하고, Betman 마감 배당·경기 결과 및 사용자의 판단 기록을 보존하는 개인용 분석 도구다.

## 폐기한 미래 구상

자체 승부예측 모델, 자동 확률 산출, 모델 학습, 확률 보정 및 백테스트는 제품 범위에서 제외한다. API-Football Predictions는 외부 공급자의 참고정보이므로 유지한다.
```

Add short paragraphs explaining that the product center moved from sample/interest-match browsing to real odds/results and user decision records, and that deployment stability, access control, data quality, and operations now take priority.

- [ ] **Step 2: Align the README opening and current scope**

Change the opening sentence to:

```markdown
K리그1과 J리그1의 실제 경기 정보와 공개 배당을 조회하고, Betman 마감 배당·경기 결과와 사용자의 판단 기록을 보존하는 개인용 분석 도구입니다.
```

Add immediately after the current-scope list:

```markdown
API-Football Predictions는 외부 공급자가 제공하는 참고정보이며, 이 앱은 자체 승부예측 모델이나 자동 추천을 제공하지 않습니다.
```

Add `docs/PRODUCT-EVOLUTION.md` to the final documentation pointer.

- [ ] **Step 3: Align PRODUCT purpose, reference data, and non-goals**

In `docs/PRODUCT.md`:

- Replace the purpose with the approved current product definition.
- State in the user flow that API-Football Predictions is external reference information.
- State that user-entered probability and selected-option shading are user decision records, not recommendations.
- Add these explicit non-goals:

```markdown
- 자체 승부예측 모델, 자동 추천 또는 자동 확률 산출
- 모델 학습, 확률 보정 또는 백테스트
- PWA 오프라인 기능
```

- [ ] **Step 4: Verify active baseline consistency**

Run:

```powershell
rg -n "개인용 분석 도구|외부 공급자|자체 승부예측|사용자.*판단 기록|PRODUCT-EVOLUTION" README.md docs/PRODUCT.md docs/PRODUCT-EVOLUTION.md
git diff --check -- README.md docs/PRODUCT.md docs/PRODUCT-EVOLUTION.md
```

Expected: all three documents distinguish external Predictions from rejected in-house prediction and contain no whitespace errors.

- [ ] **Step 5: Review and commit only the baseline documents**

Run:

```powershell
git diff -- README.md docs/PRODUCT.md docs/PRODUCT-EVOLUTION.md
git add -- README.md docs/PRODUCT.md docs/PRODUCT-EVOLUTION.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: align current product baseline"
```

Expected staged files: `README.md`, `docs/PRODUCT.md`, and `docs/PRODUCT-EVOLUTION.md`. Because README and PRODUCT already contain approved uncommitted documentation updates, review their entire staged diffs before committing.

---

### Task 3: Retire future prediction scope and replace the active roadmap

**Files:**
- Modify: `docs/ROADMAP.md:21-26`
- Modify: `docs/DECISIONS.md:79-end`
- Modify: `docs/HANDOFF.md:1-70`

**Interfaces:**
- Consumes: the current product baseline from Task 2
- Produces: deployment-first near-term priorities and a durable decision record

- [ ] **Step 1: Replace ROADMAP next work with deployment-first priorities**

Replace `## 다음 작업` with:

```markdown
## 다음 작업

### 1. 비공개 웹 배포 준비

- [ ] 배포 환경에 `API_FOOTBALL_KEY` 등록
- [ ] 운영 D1 생성과 `0000`~`0005` 마이그레이션 적용
- [ ] 로컬 저장 데이터의 운영 D1 이전 여부 결정
- [ ] 저장·삭제·동기화 API 접근 제한

### 2. 운영 안정성

- [ ] API-Football·Betman 오류, 호출량과 지연 시간 확인
- [ ] 동기화 실패와 D1 오류 확인
- [ ] 운영 데이터 백업·복구 기준 마련

### 3. 데이터 품질

- [ ] 팀 별칭 변경 근거와 출처 기록
- [ ] 팀 매칭 실패 행 점검 절차

### 4. 사용성

- [ ] 모바일 접근성 점검
- [ ] 저장·조회 오류 안내 개선
```

Do not retain the old probability-calibration/backtesting or PWA-offline checklist items.

- [ ] **Step 2: Add the product-scope decision**

Append to `docs/DECISIONS.md`:

```markdown
## DEC-014: 자체 승부예측 Phase 2를 폐기하고 외부 Predictions만 유지

- 상태: 채택
- 날짜: 2026-09-03
- 결정: API-Football Predictions는 외부 참고정보로 유지한다. 자체 승부예측 모델, 자동 확률 산출, 모델 학습, 확률 보정과 백테스트는 제품 범위에서 제외한다. 사용자가 입력한 확률과 선택 표시는 사용자 판단 기록으로 취급한다.
- 이유: 현재 제품의 핵심은 실제 경기·배당·결과 조회와 판단 기록이다. 자체 예측은 검증 데이터와 운영 복잡도를 크게 늘리며 배포 안정성, 접근통제와 데이터 품질보다 우선하지 않는다.
```

- [ ] **Step 3: Refresh HANDOFF for the new baseline**

In `docs/HANDOFF.md`:

- Change `최종 확인일` to `2026-09-03`.
- Add `docs/PRODUCT-EVOLUTION.md` to the startup reading order.
- Add a `2026-09-03 제품 기준선 정리` section summarizing log cleanup, the current product definition, retained external Predictions, retired in-house prediction plans, and the deployment-first roadmap.
- Replace `## 다음 작업 후보` with the same four numbered priority groups used in ROADMAP, expressed as concise handoff bullets.
- Remove the obsolete note that the four development log files may appear untracked.

- [ ] **Step 4: Verify roadmap and decision consistency**

Run:

```powershell
rg -n "비공개 웹 배포|운영 안정성|데이터 품질|모바일 접근성|DEC-014|API-Football Predictions|자체 승부예측" docs/ROADMAP.md docs/DECISIONS.md docs/HANDOFF.md
rg -n "\[ \].*(확률 보정|백테스트|PWA|오프라인|자체 승부예측|모델 학습|자동 추천)" docs/ROADMAP.md docs/HANDOFF.md
git diff --check -- docs/ROADMAP.md docs/DECISIONS.md docs/HANDOFF.md
```

Expected: the first command shows the adopted baseline; the second command prints nothing; the whitespace check succeeds.

- [ ] **Step 5: Review and commit only roadmap documents**

Run:

```powershell
git diff -- docs/ROADMAP.md docs/DECISIONS.md docs/HANDOFF.md
git add -- docs/ROADMAP.md docs/DECISIONS.md docs/HANDOFF.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: retire future prediction phase"
```

Expected staged files: `docs/ROADMAP.md`, `docs/DECISIONS.md`, and `docs/HANDOFF.md`. Review full staged diffs because these documents already contain approved work from earlier features.

---

### Task 4: Verify the cleanup without changing product behavior

**Files:**
- Modify after fresh verification: `docs/HANDOFF.md`
- Verify only: `app/**`, `db/**`, `drizzle/**`, `tests/**`, `.dev.vars`, `.wrangler/**`

**Interfaces:**
- Consumes: Tasks 1-3 and the existing application
- Produces: evidence that documentation cleanup did not alter runtime behavior or local persistent data

- [ ] **Step 1: Verify protected files and historical records**

Run:

```powershell
Get-Item -LiteralPath '.dev.vars' -ErrorAction Stop | Select-Object FullName,Length
Get-ChildItem -LiteralPath '.wrangler\state\v3\d1' -Recurse -File -ErrorAction Stop | Select-Object FullName,Length
git diff --name-only -- docs/superpowers/specs docs/superpowers/plans
```

Expected: `.dev.vars` and at least one local D1 file exist; the final command prints nothing because the new spec and plan are already committed and older historical documents were not modified.

- [ ] **Step 2: Verify the four log names are absent and ignored**

Run:

```powershell
Get-Item -LiteralPath '.codex-dev-server.err.log','.codex-dev-server.out.log','.codex-devserver.err.log','.codex-devserver.out.log' -ErrorAction SilentlyContinue
git check-ignore -v .codex-dev-server.err.log .codex-dev-server.out.log .codex-devserver.err.log .codex-devserver.out.log
```

Expected: `Get-Item` prints nothing; `git check-ignore` resolves all four names.

- [ ] **Step 3: Run complete application verification**

Run:

```powershell
npm.cmd test
npm.cmd run lint
```

Expected: typecheck and Vinext build succeed; all unit and rendered-HTML tests pass; ESLint exits 0.

- [ ] **Step 4: Run documentation and worktree integrity checks**

Run:

```powershell
rg -n "API-Football Predictions|외부.*참고|자체 승부예측|사용자.*판단 기록" README.md docs/PRODUCT.md docs/PRODUCT-EVOLUTION.md docs/DECISIONS.md
rg -n "\[ \].*(확률 보정|백테스트|PWA|오프라인|자체 승부예측|모델 학습|자동 추천)" docs/ROADMAP.md docs/HANDOFF.md
git diff --check
git status --short
```

Expected: the first command shows the distinction between external and in-house prediction; the second prints nothing; `git diff --check` reports no whitespace errors; the status contains no development logs.

- [ ] **Step 5: Record fresh verification evidence in HANDOFF**

Update the `2026-09-03 제품 기준선 정리` section with the exact test counts and the successful typecheck, build, and lint result observed in Step 3. Do not copy an older count.

- [ ] **Step 6: Commit the verification record**

Run:

```powershell
git add -- docs/HANDOFF.md
git diff --cached --check
git diff --cached --name-status
git commit -m "docs: record baseline cleanup verification"
```

Expected staged file: `docs/HANDOFF.md` only.

- [ ] **Step 7: Report the exact remaining worktree state**

Run:

```powershell
git status --short
git log -4 --oneline
```

Expected: report all remaining pre-existing application changes without claiming they were committed or cleaned by this documentation task. Do not start deployment, migrate D1 data, or configure hosted secrets in this plan.
