import assert from "node:assert/strict";
import test from "node:test";
import finalFixture from "./fixtures/betman-history/closed-round-final.json" with { type: "json" };
import pendingFixture from "./fixtures/betman-history/closed-round-pending.json" with { type: "json" };
import * as historyParserModule from "../app/lib/betman-history-parser.ts";
import {
  BetmanHistorySchemaError,
  canonicalHistoryLeague,
  parseClosedRoundDocument,
} from "../app/lib/betman-history-parser.ts";
import type { ClosedRoundDocument } from "../app/lib/betman-history-types.ts";

const finalDocumentFixture = finalFixture as ClosedRoundDocument;
const pendingDocumentFixture = pendingFixture as ClosedRoundDocument;

function withRows(document: ClosedRoundDocument, rows: unknown[][]): ClosedRoundDocument {
  const payload = structuredClone(document.payload) as { compSchedules: { datas: unknown[][] } };
  payload.compSchedules.datas = rows;
  return { ...document, payload };
}

function withExtraColumn(document: ClosedRoundDocument, key: string, value: unknown): ClosedRoundDocument {
  const payload = structuredClone(document.payload) as { compSchedules: { keys: string[]; datas: unknown[][] } };
  payload.compSchedules.keys.push(key);
  payload.compSchedules.datas = payload.compSchedules.datas.map((row) => [...row, value]);
  return { ...document, payload };
}

test("parses only final normal football match-winner rows", () => {
  const parsed = parseClosedRoundDocument(finalDocumentFixture);
  assert.deepEqual(parsed.matches.map(({ matchSeq, displayStatus, result }) => ({ matchSeq, displayStatus, result })), [
    { matchSeq: "5345", displayStatus: "INCLUDED", result: "H" },
    { matchSeq: "5346", displayStatus: "TEAM_MATCH_FAILED", result: "A" },
  ]);
  assert.equal(parsed.matches[0].betmanHomeTeam, "FC도쿄");
  assert.equal(parsed.matches[0].homeTeamName, "FC 도쿄");
  assert.equal(parsed.matches[0].kickoffAt, "2026-08-21T19:30:00+09:00");
  assert.equal(parsed.eventFrom, "2026-08-21");
  assert.equal(parsed.eventTo, "2026-08-22");
});

test("assigns one exclusion using the required priority", () => {
  const parsed = parseClosedRoundDocument(pendingDocumentFixture);
  assert.deepEqual(parsed.matches.map((row) => row.displayStatus), ["CANCELLED", "PENDING_RESULT", "MISSING_ODDS", "TEAM_MATCH_FAILED"]);
});

test("rejects duplicate matchSeq and score-result conflicts atomically", () => {
  const rows = (finalDocumentFixture.payload as { compSchedules: { datas: unknown[][] } }).compSchedules.datas;
  const duplicateFixture = withRows(finalDocumentFixture, [rows[0], [...rows[0].slice(0, 5), "5345", ...rows[0].slice(6)]]);
  const conflictingResultFixture = withRows(finalDocumentFixture, [[...rows[0].slice(0, 12), "A", rows[0][13]]]);
  assert.throws(() => parseClosedRoundDocument(duplicateFixture), BetmanHistorySchemaError);
  assert.throws(() => parseClosedRoundDocument(conflictingResultFixture), /BETMAN_SCHEMA_CHANGED/);
});

test("accepts only declared aliases and an explicit zero-game document", () => {
  assert.equal(canonicalHistoryLeague(" 일본 J1리그 "), "J1");
  assert.equal(canonicalHistoryLeague("J리그 1"), null);
  const zeroDocument: ClosedRoundDocument = {
    ...pendingDocumentFixture,
    payload: { gmId: "G101", gmTs: "260102", roundStatus: "PENDING", zeroGames: true, compSchedules: { keys: [], datas: [] } },
  };
  assert.deepEqual(parseClosedRoundDocument(zeroDocument).matches, []);
});

test("rejects ambiguous or malformed documents and conflicting duplicate odds", () => {
  const payload = structuredClone(finalDocumentFixture.payload) as { roundStatus?: string; compSchedules: { datas: unknown[][] } };
  delete payload.roundStatus;
  assert.throws(() => parseClosedRoundDocument({ ...finalDocumentFixture, payload } as ClosedRoundDocument), /BETMAN_SCHEMA_CHANGED/);
  assert.throws(() => parseClosedRoundDocument({ ...finalDocumentFixture, payload: { gmId: "G101", gmTs: "260101", roundStatus: "FINAL", compSchedules: { keys: [], datas: [] } } } as ClosedRoundDocument), /BETMAN_SCHEMA_CHANGED/);
  const rows = (finalDocumentFixture.payload as { compSchedules: { datas: unknown[][] } }).compSchedules.datas;
  const conflictingOdds = [...rows[0]];
  conflictingOdds[13] = [{ label: "승", odds: "2.05" }, { label: "승", odds: "2.30" }, { label: "무", odds: "3.15" }, { label: "패", odds: "3.40" }];
  assert.throws(() => parseClosedRoundDocument(withRows(finalDocumentFixture, [conflictingOdds])), /BETMAN_SCHEMA_CHANGED/);
});

test("treats a duplicated label with an invalid price as incomplete odds", () => {
  const rows = (finalDocumentFixture.payload as { compSchedules: { datas: unknown[][] } }).compSchedules.datas;
  const duplicatedLabel = [...rows[0]];
  duplicatedLabel[13] = [{ label: "승", odds: "2.05" }, { label: "승", odds: "not-a-decimal" }, { label: "무", odds: "3.15" }, { label: "패", odds: "3.40" }];
  const parsed = parseClosedRoundDocument(withRows(finalDocumentFixture, [duplicatedLabel]));
  assert.equal(parsed.matches[0].displayStatus, "MISSING_ODDS");
});

test("rejects malformed and duplicate match sequences even on out-of-scope rows", () => {
  const rows = (finalDocumentFixture.payload as { compSchedules: { datas: unknown[][] } }).compSchedules.datas;
  const malformedOutOfScope = [...rows[2]];
  malformedOutOfScope[5] = "not-a-sequence";
  assert.throws(() => parseClosedRoundDocument(withRows(finalDocumentFixture, [rows[0], malformedOutOfScope])), /BETMAN_SCHEMA_CHANGED/);
  const duplicateOutOfScope = [...rows[2]];
  duplicateOutOfScope[5] = rows[0][5];
  assert.throws(() => parseClosedRoundDocument(withRows(finalDocumentFixture, [rows[0], duplicateOutOfScope])), /BETMAN_SCHEMA_CHANGED/);
});

test("rejects invalid runtime document metadata", () => {
  assert.throws(() => parseClosedRoundDocument({ ...finalDocumentFixture, fetchedAt: null } as unknown as ClosedRoundDocument), /BETMAN_SCHEMA_CHANGED/);
  assert.throws(() => parseClosedRoundDocument({ ...finalDocumentFixture, fetchedAt: "2026-08-21T09:00:00+00:00" } as ClosedRoundDocument), /BETMAN_SCHEMA_CHANGED/);
  assert.throws(() => parseClosedRoundDocument({ ...finalDocumentFixture, round: { ...finalDocumentFixture.round, sourceUrl: null } } as unknown as ClosedRoundDocument), /BETMAN_SCHEMA_CHANGED/);
  assert.throws(() => parseClosedRoundDocument({ ...finalDocumentFixture, round: { ...finalDocumentFixture.round, sourceUrl: "http://www.betman.co.kr/closed/G101/260101" } } as ClosedRoundDocument), /BETMAN_SCHEMA_CHANGED/);
  assert.throws(() => parseClosedRoundDocument({ ...finalDocumentFixture, round: { ...finalDocumentFixture.round, announcedAt: {} } } as unknown as ClosedRoundDocument), /BETMAN_SCHEMA_CHANGED/);
});

test("does not use current-round punctuation and FC-stripping aliases for history", () => {
  const rows = (finalDocumentFixture.payload as { compSchedules: { datas: unknown[][] } }).compSchedules.datas;
  const punctuationVariant = [...rows[0]];
  punctuationVariant[7] = "F.C. 도쿄";
  const parsed = parseClosedRoundDocument(withRows(finalDocumentFixture, [punctuationVariant]));
  assert.equal(parsed.matches[0].displayStatus, "TEAM_MATCH_FAILED");
  assert.equal(parsed.matches[0].homeTeamName, null);
});

test("omits a textual football row when its present sport code is not SC", () => {
  const payloadDocument = withExtraColumn(finalDocumentFixture, "itemName", "축구");
  const payload = payloadDocument.payload as { compSchedules: { datas: unknown[][] } };
  payload.compSchedules.datas[0][0] = "BS";
  payload.compSchedules.datas = [payload.compSchedules.datas[0]];
  assert.deepEqual(parseClosedRoundDocument(payloadDocument).matches, []);
});

test("derives row finality from terminal row data instead of round finality", () => {
  const rows = (finalDocumentFixture.payload as { compSchedules: { datas: unknown[][] } }).compSchedules.datas;
  const completed = [...rows[0]];
  const pending = [...rows[0]];
  pending[5] = "9998";
  pending[9] = "PENDING";
  pending[10] = "";
  pending[11] = "";
  pending[12] = "";
  const payload = structuredClone(finalDocumentFixture.payload) as {
    roundStatus: string;
    compSchedules: { datas: unknown[][] };
  };
  payload.roundStatus = "PENDING";
  payload.compSchedules.datas = [completed, pending];

  const parsed = parseClosedRoundDocument({
    ...finalDocumentFixture,
    providerFinal: false,
    payload,
  });

  assert.deepEqual(parsed.matches.map(({ displayStatus, sourceFinal }) => ({ displayStatus, sourceFinal })), [
    { displayStatus: "INCLUDED", sourceFinal: true },
    { displayStatus: "PENDING_RESULT", sourceFinal: false },
  ]);
});

test("does not freeze provider-final rows with incomplete results", () => {
  const rows = (finalDocumentFixture.payload as { compSchedules: { datas: unknown[][] } }).compSchedules.datas;
  const incomplete = [...rows[0]];
  incomplete[9] = "PENDING";
  incomplete[10] = "";
  incomplete[11] = "";
  incomplete[12] = "";
  const parsed = parseClosedRoundDocument(withRows(finalDocumentFixture, [incomplete]));
  assert.equal(parsed.matches[0].displayStatus, "PENDING_RESULT");
  assert.equal(parsed.matches[0].sourceFinal, false);
});

test("captures compact kickoff seconds and rejects invalid second fields", () => {
  const rows = (finalDocumentFixture.payload as { compSchedules: { datas: unknown[][] } }).compSchedules.datas;
  const withKickoff = (value: string) => {
    const row = [...rows[0]];
    row[6] = value;
    return withRows(finalDocumentFixture, [row]);
  };

  assert.equal(parseClosedRoundDocument(withKickoff("20260821193045")).matches[0].kickoffAt, "2026-08-21T19:30:45+09:00");
  assert.throws(() => parseClosedRoundDocument(withKickoff("20260821193060")), /BETMAN_SCHEMA_CHANGED/u);
  assert.throws(() => parseClosedRoundDocument(withKickoff("20260821193099")), /BETMAN_SCHEMA_CHANGED/u);
});

test("exports the punctuation-sensitive history team resolver", () => {
  const resolver = (historyParserModule as Record<string, unknown>).strictHistoryTeamIdentityForAlias;
  assert.equal(typeof resolver, "function");
  if (typeof resolver !== "function") return;
  const typedResolver = resolver as (league: "J1", value: string) => { id: number } | null;
  assert.equal(typedResolver("J1", "FC도쿄")?.id, 292);
  assert.equal(typedResolver("J1", "F.C. 도쿄"), null);
});

test("resolves confirmed K1 Betman spacing variants from May closed games", () => {
  const resolver = historyParserModule.strictHistoryTeamIdentityForAlias;
  const variants: Array<[string, number]> = [
    ["FC서울", 2766], ["FC안양", 2748],
    ["울산 HDFC", 2767], ["울산HDFC", 2767],
    ["강원FC", 2746], ["광주FC", 2759],
    ["제주 SKFC", 2761], ["제주SKFC", 2761],
    ["부천FC1995", 2745], ["전북현대모터스", 2762],
    ["김천상무프로축구단", 2768], ["대전하나시티즌", 2750],
    ["인천유나이티드", 2763], ["포항스틸러스", 2764],
  ];

  for (const [rawName, expectedId] of variants) {
    assert.equal(resolver("K1", rawName)?.id, expectedId, rawName);
  }
});

test("parses the real Betman closed-game column contract", () => {
  const keys = [
    "itemCode", "gameDate", "leagueName", "matchSeq", "homeName", "awayName",
    "winTxt", "winAllot", "drawTxt", "drawAllot", "loseTxt", "loseAllot",
    "handi", "protoStatus", "gameResult", "mchScore", "betTypId", "betTypNm", "betId", "betNm",
    "prlYn", "sgl", "gameReject", "buyReject",
  ];
  const values: Record<string, unknown> = {
    itemCode: "SC", gameDate: 1787306400000, leagueName: "일본 J1리그", matchSeq: 5301,
    homeName: "가시와 레이솔", awayName: "V바렌 나가사키",
    winTxt: "승", winAllot: 1.54, drawTxt: "무", drawAllot: 3.45, loseTxt: "패", loseAllot: 4.75,
    handi: 0, protoStatus: "4", gameResult: "0", mchScore: "4:2", betTypId: "1",
    betTypNm: "승무패", betId: "1", betNm: "축구 승무패", prlYn: "N", sgl: "1", gameReject: "0", buyReject: "0",
  };
  const document: ClosedRoundDocument = {
    round: {
      gmId: "G101", gmTs: "260098",
      sourceUrl: "https://www.betman.co.kr/main/mainPage/gamebuy/closedGameSlip.do?gmId=G101&gmTs=260098",
      announcedAt: null,
    },
    fetchedAt: "2026-08-21T09:00:00.000Z",
    providerFinal: true,
    payload: { gmTs: 260098, compSchedules: { keys, datas: [keys.map((key) => values[key])] } },
  };

  const [parsed] = parseClosedRoundDocument(document).matches;
  assert.equal(parsed.displayStatus, "INCLUDED");
  assert.equal(parsed.result, "H");
  assert.deepEqual([parsed.homeScore, parsed.awayScore], [4, 2]);
  assert.deepEqual([parsed.homeOdds, parsed.drawOdds, parsed.awayOdds], [1.54, 3.45, 4.75]);
  assert.equal(parsed.homeTeamId, 281);
  assert.equal(parsed.awayTeamId, 285);
  assert.match(parsed.kickoffAt, /^2026-08-21T\d{2}:\d{2}:00\+09:00$/u);
});

test("excludes Betman's first-half match-winner rows", () => {
  const keys = [
    "itemCode", "gameDate", "leagueName", "matchSeq", "homeName", "awayName",
    "winTxt", "winAllot", "drawTxt", "drawAllot", "loseTxt", "loseAllot",
    "handi", "protoStatus", "gameResult", "mchScore", "betTypId", "betTypNm", "betId", "betNm", "prlYn",
  ];
  const row = ["SC", 1787306400000, "일본 J1리그", 5302, "가시와 레이솔", "V바렌 나가사키", "승", 1.5, "무", 3.4, "패", 4.7, 0, "4", "0", "2:0", "1", "승무패", "118", "축구 전반 승무패", "N"];
  const document: ClosedRoundDocument = {
    round: { gmId: "G101", gmTs: "260098", sourceUrl: "https://www.betman.co.kr/main/mainPage/gamebuy/closedGameSlip.do?gmId=G101&gmTs=260098", announcedAt: null },
    fetchedAt: "2026-08-21T09:00:00.000Z", providerFinal: true,
    payload: { gmTs: 260098, compSchedules: { keys, datas: [row] } },
  };
  assert.deepEqual(parseClosedRoundDocument(document).matches, []);
});
