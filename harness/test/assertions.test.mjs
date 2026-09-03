import test from "node:test";
import assert from "node:assert/strict";
import { invariant, isIsoDate, percentNumber } from "../src/assertions.mjs";

test("ISO 날짜 형식을 판정한다", () => {
  assert.equal(isIsoDate("2026-08-12"), true);
  assert.equal(isIsoDate("2024-02-29"), true);
  assert.equal(isIsoDate("2026-02-29"), false);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("2026/08/12"), false);
});

test("퍼센트 문자열을 숫자로 변환한다", () => {
  assert.equal(percentNumber("35%"), 35);
  assert.equal(percentNumber("60.5%"), 60.5);
  assert.equal(Number.isNaN(percentNumber("35")), true);
});

test("불변식 위반 시 메시지를 보존한다", () => {
  assert.throws(() => invariant(false, "계약 위반"), /계약 위반/);
});
