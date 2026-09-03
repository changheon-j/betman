import assert from "node:assert/strict";
import test from "node:test";
import { parseBetmanPayload } from "../app/lib/betman-parser.ts";
import { replaceCacheAfterPersist } from "../app/lib/betman-round-state.ts";

test("정상 구조의 빈 배당은 허용한다", () => {
  assert.deepEqual(parseBetmanPayload({ compSchedules: { keys: [], datas: [] } }), []);
});

test("compSchedules가 없는 응답은 거부한다", () => {
  assert.throws(() => parseBetmanPayload({ result: "error" }), /응답 구조/);
});

test("keys 또는 datas가 배열이 아니면 거부한다", () => {
  assert.throws(() => parseBetmanPayload({ compSchedules: { keys: {}, datas: [] } }), /응답 구조/);
  assert.throws(() => parseBetmanPayload({ compSchedules: { keys: [], datas: null } }), /응답 구조/);
});

test("실제 Betman 배열 행을 축구 경기와 게임유형으로 파싱한다", () => {
  const keys = [
    "itemCode", "homeName", "awayName", "gameDate", "leagueName", "gameName",
    "matchSeq", "winTxt", "winAllot", "drawTxt", "drawAllot", "loseTxt", "loseAllot",
  ];
  const row = [
    "SC", "광주FC", "포항스틸러스", "202608151930", "K리그1", "축구 승무패",
    "1654", "승", "2.20", "무", "3.10", "패", "2.80",
  ];
  const fixtures = parseBetmanPayload({ compSchedules: { keys, datas: [row] } });
  assert.equal(fixtures.length, 1);
  assert.equal(fixtures[0].date, "2026-08-15");
  assert.equal(fixtures[0].kickoffAt, "2026-08-15T19:30:00+09:00");
  assert.equal(fixtures[0].markets[0].matchSeq, "1654");
  assert.deepEqual(fixtures[0].markets[0].options, [
    { label: "승", odds: "2.20" },
    { label: "무", odds: "3.10" },
    { label: "패", odds: "2.80" },
  ]);
});

test("회차 저장 실패 시 기존 캐시를 교체하지 않는다", async () => {
  const previous = { sourceKey: "G101:old" };
  const candidate = { sourceKey: "G101:new" };
  let cache = previous;
  await assert.rejects(async () => {
    cache = await replaceCacheAfterPersist(candidate, async () => {
      throw new Error("D1 failure");
    });
  }, /D1 failure/);
  assert.equal(cache, previous);
});
