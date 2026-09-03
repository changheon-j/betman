import assert from "node:assert/strict";
import test from "node:test";
import { resolveLeagueSeason, SUPPORTED_LEAGUES } from "../app/lib/leagues.ts";

const K1 = SUPPORTED_LEAGUES[0];
const J1 = SUPPORTED_LEAGUES[1];

test("uses the calendar year for the 2026 K1 season", () => {
  assert.deepEqual(resolveLeagueSeason(K1, "2026-08-13"), {
    season: 2026,
    seasonStart: "2026-01-01",
  });
});

test("uses the ending year for J1 dates from July through December", () => {
  assert.deepEqual(resolveLeagueSeason(J1, "2026-08-13"), {
    season: 2027,
    seasonStart: "2026-07-01",
  });
});

test("keeps the same ending-year J1 season from January through June", () => {
  assert.deepEqual(resolveLeagueSeason(J1, "2027-01-15"), {
    season: 2027,
    seasonStart: "2026-07-01",
  });
});
