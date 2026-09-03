import assert from "node:assert/strict";
import test from "node:test";
import { betmanHistorySmokeSummary } from "../app/lib/betman-history-smoke.ts";
import type { ParsedClosedRound } from "../app/lib/betman-history-types.ts";

test("smoke summary emits only bounded round and event metadata", () => {
  const parsed = {
    round: {
      gmId: "G101",
      gmTs: "260101",
      sourceUrl: "https://www.betman.co.kr/private?cookie=secret",
      announcedAt: null,
    },
    fetchedAt: "2026-08-21T00:00:00.000Z",
    providerFinal: true,
    eventFrom: "2026-08-20",
    eventTo: "2026-08-21",
    matches: [{ payload: "raw-secret" }],
  } as unknown as ParsedClosedRound;

  assert.deepEqual(betmanHistorySmokeSummary(parsed), {
    roundKey: "G101:260101",
    eventFrom: "2026-08-20",
    eventTo: "2026-08-21",
    providerFinal: true,
    candidateCount: 1,
    fetchedAt: "2026-08-21T00:00:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(betmanHistorySmokeSummary(parsed)), /cookie|raw-secret|sourceUrl/iu);
  assert.deepEqual(betmanHistorySmokeSummary(null), {
    roundKey: null,
    eventFrom: null,
    eventTo: null,
    providerFinal: null,
    candidateCount: 0,
    fetchedAt: null,
  });
});
