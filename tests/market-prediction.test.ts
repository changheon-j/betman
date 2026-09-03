import assert from "node:assert/strict";
import test from "node:test";
import * as marketPredictionModule from "../app/lib/market-prediction.ts";
import {
  excludePredictionsByKey,
  makePredictionKey,
  missingStablePredictionColumns,
  isoDateBoundary,
  parsePredictionKeys,
  parsePredictionInput,
  savedProbabilitiesForMarket,
} from "../app/lib/market-prediction.ts";

type SelectionModule = {
  togglePredictionSelection?: (current: number | null, clicked: number) => number | null;
  changedPredictionSelections?: (
    predictions: Array<{ predictionKey: string; selectedOptionIndex: number | null }>,
    drafts: Record<string, number | null>,
  ) => Array<{ predictionKey: string; selectedOptionIndex: number | null }>;
  parsePredictionSelectionUpdates?: (value: unknown) => Array<{ predictionKey: string; selectedOptionIndex: number | null }>;
  missingPredictionSelectionColumns?: (rows: Array<{ name?: unknown }>) => string[];
  savePredictionSelections?: (
    value: unknown,
    repository: {
      readSelectionTargets: (predictionKeys: string[]) => Promise<Array<{ predictionKey: string; optionCount: number }>>;
      writeSelections: (updates: Array<{ predictionKey: string; selectedOptionIndex: number | null }>) => Promise<number>;
    },
  ) => Promise<{ updated: number }>;
};

const selectionModule = marketPredictionModule as SelectionModule;

function validPredictionInput() {
  return {
    matchId: 1507028,
    matchDate: "2026-08-15",
    kickoffTime: "19:30",
    homeTeam: "광주 FC",
    awayTeam: "포항 스틸러스",
    marketIndex: 0,
    marketType: "축구 승무패",
    marketCondition: "-",
    betmanRound: "260095",
    matchSeq: "1654",
    options: [
      { label: "승", odds: 2.2, probability: 0.5 },
      { label: "패", odds: 2.8, probability: 0.5 },
    ],
  };
}

test("회차와 Betman 게임번호로 저장 키를 구분한다", () => {
  assert.equal(
    makePredictionKey({ matchId: 1507028, betmanRound: "260095", matchSeq: "1654" }),
    "fixture:1507028|round:260095|game:1654",
  );
  assert.notEqual(
    makePredictionKey({ matchId: 1507028, betmanRound: "260095", matchSeq: "1654" }),
    makePredictionKey({ matchId: 1507028, betmanRound: "260096", matchSeq: "1654" }),
  );
});

test("삭제한 저장키는 복원 후보에서도 제거한다", () => {
  const records = [{ predictionKey: "a" }, { predictionKey: "b" }];
  assert.deepEqual(excludePredictionsByKey(records, new Set(["a"])), [{ predictionKey: "b" }]);
});

test("조회기간도 실제 달력 날짜만 허용한다", () => {
  assert.equal(isoDateBoundary("2024-02-29", false), "2024-02-28T15:00:00.000Z");
  assert.throws(() => isoDateBoundary("2026-02-30", false), /date/);
});

test("삭제키는 길이를 제한하고 중복을 제거한다", () => {
  assert.deepEqual(parsePredictionKeys(["fixture:1|round:2|game:3", "fixture:1|round:2|game:3"]), ["fixture:1|round:2|game:3"]);
  assert.throws(() => parsePredictionKeys(["x".repeat(513)]), /predictionKey/);
});

test("기존 저장 테이블에서 누락된 안정 식별자 열을 찾는다", () => {
  assert.deepEqual(missingStablePredictionColumns([{ name: "prediction_key" }]), ["betman_round", "match_seq"]);
  assert.deepEqual(missingStablePredictionColumns([{ name: "betman_round" }, { name: "match_seq" }]), []);
});

test("숫자로 강제 변환되는 잘못된 경기 식별자를 거부한다", () => {
  const base = validPredictionInput();
  for (const matchId of [null, "", true, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parsePredictionInput({ ...base, matchId }), /matchId/);
  }
  for (const marketIndex of [null, "", true, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parsePredictionInput({ ...base, marketIndex }), /marketIndex/);
  }
});

test("숫자가 아닌 배당과 확률을 거부한다", () => {
  const base = validPredictionInput();
  assert.throws(() => parsePredictionInput({
    ...base,
    options: [
      { label: "승", odds: "2.2", probability: 0.5 },
      { label: "패", odds: 2.8, probability: 0.5 },
    ],
  }), /odds/);
  assert.throws(() => parsePredictionInput({
    ...base,
    options: [
      { label: "승", odds: 2.2, probability: null },
      { label: "패", odds: 2.8, probability: 1 },
    ],
  }), /probability/);
});

test("존재하지 않는 날짜와 시간을 거부한다", () => {
  const base = validPredictionInput();
  assert.throws(() => parsePredictionInput({ ...base, matchDate: "2026-02-30" }), /matchDate/);
  assert.throws(() => parsePredictionInput({ ...base, kickoffTime: "24:00" }), /kickoffTime/);
  assert.equal(parsePredictionInput({ ...base, matchDate: "2024-02-29" }).matchDate, "2024-02-29");
});

test("회차와 게임번호 및 중복되지 않은 옵션 라벨을 요구한다", () => {
  const base = validPredictionInput();
  assert.throws(() => parsePredictionInput({ ...base, betmanRound: "" }), /betmanRound/);
  assert.throws(() => parsePredictionInput({ ...base, matchSeq: "abc" }), /matchSeq/);
  assert.throws(() => parsePredictionInput({
    ...base,
    options: [
      { label: "승", odds: 2.2, probability: 0.5 },
      { label: "승", odds: 2.8, probability: 0.5 },
    ],
  }), /option label/);
});

test("현재 회차·게임번호·옵션과 모두 일치할 때만 확률을 복원한다", () => {
  const saved = {
    betmanRound: "260095",
    matchSeq: "1654",
    options: [
      { label: "승", probability: 0.6 },
      { label: "패", probability: 0.4 },
    ],
  };
  assert.deepEqual(
    savedProbabilitiesForMarket(saved, { betmanRound: "260095", matchSeq: "1654", optionLabels: ["승", "패"] }),
    ["0.6", "0.4"],
  );
  assert.equal(savedProbabilitiesForMarket({ ...saved, betmanRound: null }, { betmanRound: "260095", matchSeq: "1654", optionLabels: ["승", "패"] }), null);
  assert.equal(savedProbabilitiesForMarket(saved, { betmanRound: "260096", matchSeq: "1654", optionLabels: ["승", "패"] }), null);
  assert.equal(savedProbabilitiesForMarket(saved, { betmanRound: "260095", matchSeq: "1654", optionLabels: ["패", "승"] }), null);
});

test("저장된 경기 선택은 한 행에서 하나만 유지하고 같은 선택을 다시 누르면 해제한다", () => {
  assert.equal(typeof selectionModule.togglePredictionSelection, "function");
  const toggle = selectionModule.togglePredictionSelection!;

  assert.equal(toggle(null, 0), 0);
  assert.equal(toggle(0, 2), 2);
  assert.equal(toggle(2, 2), null);
});

test("실제 저장값과 달라진 행만 선택 저장 요청으로 만든다", () => {
  assert.equal(typeof selectionModule.changedPredictionSelections, "function");
  const changed = selectionModule.changedPredictionSelections!;

  assert.deepEqual(changed([
    { predictionKey: "fixture:1|round:2|game:3", selectedOptionIndex: null },
    { predictionKey: "fixture:4|round:5|game:6", selectedOptionIndex: 1 },
    { predictionKey: "fixture:7|round:8|game:9", selectedOptionIndex: 2 },
  ], {
    "fixture:1|round:2|game:3": 0,
    "fixture:4|round:5|game:6": 1,
    "fixture:7|round:8|game:9": null,
  }), [
    { predictionKey: "fixture:1|round:2|game:3", selectedOptionIndex: 0 },
    { predictionKey: "fixture:7|round:8|game:9", selectedOptionIndex: null },
  ]);
});

test("선택 저장 요청은 중복 없는 최대 100개 행과 0부터 2 또는 null만 허용한다", () => {
  assert.equal(typeof selectionModule.parsePredictionSelectionUpdates, "function");
  const parse = selectionModule.parsePredictionSelectionUpdates!;
  const first = { predictionKey: "fixture:1|round:2|game:3", selectedOptionIndex: 2 };

  assert.deepEqual(parse({ updates: [first] }), [first]);
  assert.throws(() => parse({ updates: [first, first] }), /duplicate/);
  for (const selectedOptionIndex of [-1, 3, 1.5, "1", undefined]) {
    assert.throws(() => parse({ updates: [{ ...first, selectedOptionIndex }] }), /selectedOptionIndex/);
  }
  assert.equal(parse({ updates: [{ ...first, selectedOptionIndex: null }] })[0]?.selectedOptionIndex, null);
  assert.throws(() => parse({ updates: Array.from({ length: 101 }, (_, index) => ({
    predictionKey: `fixture:${index + 1}|round:2|game:3`,
    selectedOptionIndex: 0,
  })) }), /100/);
});

test("기존 저장 테이블에서 선택 메타데이터 열 누락을 찾는다", () => {
  assert.equal(typeof selectionModule.missingPredictionSelectionColumns, "function");
  const missing = selectionModule.missingPredictionSelectionColumns!;

  assert.deepEqual(missing([{ name: "prediction_key" }]), ["selected_option_index"]);
  assert.deepEqual(missing([{ name: "selected_option_index" }]), []);
});

test("선택 저장은 실제 저장 행의 옵션 개수 안에서만 일괄 반영한다", async () => {
  assert.equal(typeof selectionModule.savePredictionSelections, "function");
  const save = selectionModule.savePredictionSelections!;
  const stored = new Map<string, { optionCount: number; selectedOptionIndex: number | null }>([
    ["fixture:1|round:2|game:3", { optionCount: 2, selectedOptionIndex: null }],
    ["fixture:4|round:5|game:6", { optionCount: 3, selectedOptionIndex: 2 }],
  ]);
  const repository = {
    async readSelectionTargets(predictionKeys: string[]) {
      return predictionKeys.flatMap((predictionKey) => {
        const row = stored.get(predictionKey);
        return row ? [{ predictionKey, optionCount: row.optionCount }] : [];
      });
    },
    async writeSelections(updates: Array<{ predictionKey: string; selectedOptionIndex: number | null }>) {
      for (const update of updates) stored.get(update.predictionKey)!.selectedOptionIndex = update.selectedOptionIndex;
      return updates.length;
    },
  };

  assert.deepEqual(await save({ updates: [
    { predictionKey: "fixture:1|round:2|game:3", selectedOptionIndex: 1 },
    { predictionKey: "fixture:4|round:5|game:6", selectedOptionIndex: null },
  ] }, repository), { updated: 2 });
  assert.equal(stored.get("fixture:1|round:2|game:3")?.selectedOptionIndex, 1);
  assert.equal(stored.get("fixture:4|round:5|game:6")?.selectedOptionIndex, null);
});

test("선택 저장은 없는 행과 해당 행의 옵션 범위를 벗어난 선택을 거부한다", async () => {
  assert.equal(typeof selectionModule.savePredictionSelections, "function");
  const save = selectionModule.savePredictionSelections!;
  const repository = {
    async readSelectionTargets(predictionKeys: string[]) {
      return predictionKeys.includes("fixture:1|round:2|game:3")
        ? [{ predictionKey: "fixture:1|round:2|game:3", optionCount: 2 }]
        : [];
    },
    async writeSelections() { return 1; },
  };

  await assert.rejects(() => save({ updates: [
    { predictionKey: "fixture:9|round:9|game:9", selectedOptionIndex: 0 },
  ] }, repository), /not found/);
  await assert.rejects(() => save({ updates: [
    { predictionKey: "fixture:1|round:2|game:3", selectedOptionIndex: 2 },
  ] }, repository), /option range/);
});
