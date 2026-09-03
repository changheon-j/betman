import assert from "node:assert/strict";
import test from "node:test";
import {
  focusFixtureDetail,
  predictionErrorForFixture,
  predictionForFixture,
  reconcileSelectedFixtureId,
  selectedFixture,
} from "../app/fixture-workspace.ts";

const matches = [{ id: 11, name: "First" }, { id: 22, name: "Second" }];

test("does not fall back to the first fixture when nothing is selected", () => {
  assert.equal(selectedFixture(matches, 0), null);
});

test("returns only the explicitly selected fixture", () => {
  assert.deepEqual(selectedFixture(matches, 22), matches[1]);
  assert.equal(selectedFixture(matches, 99), null);
});

test("keeps a valid selection and clears a fixture removed by refresh", () => {
  assert.equal(reconcileSelectedFixtureId(matches, 22), 22);
  assert.equal(reconcileSelectedFixtureId(matches, 99), 0);
  assert.equal(reconcileSelectedFixtureId([], 22), 0);
});

test("does not expose prediction data or errors from a previously selected fixture", () => {
  const prediction = { fixtureId: 11, data: { advice: "Home wins" } };
  const error = { fixtureId: 11, message: "Prediction failed" };

  assert.equal(predictionForFixture(22, prediction), null);
  assert.equal(predictionErrorForFixture(22, error), "");
  assert.deepEqual(predictionForFixture(11, prediction), prediction.data);
  assert.equal(predictionErrorForFixture(11, error), error.message);
});

function recordingPanel() {
  const calls: Array<["focus" | "scroll", object]> = [];
  return {
    calls,
    panel: {
      focus(options: { preventScroll: boolean }) {
        calls.push(["focus", options]);
      },
      scrollIntoView(options: { block: string; behavior: string }) {
        calls.push(["scroll", options]);
      },
    },
  };
}

test("focuses the detail panel without scrolling on desktop", () => {
  const { calls, panel } = recordingPanel();

  focusFixtureDetail(panel, { isSmallViewport: false, prefersReducedMotion: false });

  assert.deepEqual(calls, [["focus", { preventScroll: true }]]);
});

test("focuses before smoothly scrolling the detail panel on a small screen", () => {
  const { calls, panel } = recordingPanel();

  focusFixtureDetail(panel, { isSmallViewport: true, prefersReducedMotion: false });

  assert.deepEqual(calls, [
    ["focus", { preventScroll: true }],
    ["scroll", { block: "start", behavior: "smooth" }],
  ]);
});

test("uses automatic scrolling when reduced motion is preferred", () => {
  const { calls, panel } = recordingPanel();

  focusFixtureDetail(panel, { isSmallViewport: true, prefersReducedMotion: true });

  assert.deepEqual(calls, [
    ["focus", { preventScroll: true }],
    ["scroll", { block: "start", behavior: "auto" }],
  ]);
});
