import assert from "node:assert/strict";
import test from "node:test";
import type { AnonymousSession, BetmanClosedAdapter } from "../app/lib/betman-history-adapter.ts";
import { BetmanHistorySchemaError } from "../app/lib/betman-history-parser.ts";
import type {
  ClaimedClosedRound,
  ClosedRoundDocument,
  ClosedRoundRef,
  ParsedClosedRound,
  SyncInput,
} from "../app/lib/betman-history-types.ts";
import { decodeSyncCursor, encodeSyncCursor, OddsHistoryValidationError } from "../app/lib/odds-history-contract.ts";
import type { OddsHistoryStore } from "../app/lib/odds-history-store.ts";
import {
  handleOddsHistorySync,
  MAX_CURSOR_INSPECTIONS_PER_SYNC,
  runOddsHistorySync,
  type OddsHistoryOperationalEvent,
  type SyncDependencies,
} from "../app/lib/odds-history-sync.ts";
import { handleOddsHistorySyncPost } from "../app/api/odds-history/sync/route.ts";

const from = "2026-05-21";
const to = "2026-08-21";
const instant = "2026-08-21T00:10:00.000Z";
const emptyExcluded = { cancelled: 0, pendingResult: 0, missingOdds: 0, teamMatchFailed: 0 };

type Claim = Awaited<ReturnType<OddsHistoryStore["claimCandidates"]>>;
type Persisted = Awaited<ReturnType<OddsHistoryStore["persistRound"]>>;
type Controls = {
  claim?: (keys: string[], now: string, limit: number) => Claim | Promise<Claim>;
  fetch?: (round: ClosedRoundRef) => ClosedRoundDocument | Promise<ClosedRoundDocument>;
  parse?: (document: ClosedRoundDocument) => ParsedClosedRound;
  persist?: (round: ParsedClosedRound) => Persisted | Promise<Persisted>;
  register?: () => void | Promise<void>;
  recordError?: (round: ClosedRoundRef, code: string, message: string) => void | Promise<void>;
  release?: (key: string, leaseToken: string) => void | Promise<void>;
  rematch?: () => number | Promise<number>;
  createSession?: () => AnonymousSession | Promise<AnonymousSession>;
};

type Observed = {
  sessions: number;
  discoveries: number;
  registered: string[][];
  claimInputs: string[][];
  claimTimestamps: string[];
  claimLimits: number[];
  detailCalls: string[];
  persistCalls: string[];
  released: string[];
  releaseClaimTimestamps: string[];
  persistLeaseTokens: string[];
  rematchInputs: string[][];
  recorded: Array<{ gmTs: string; code: string; message: string }>;
  events: string[];
  activeDetails: number;
  maxActiveDetails: number;
};

function round(gmTs: string): ClosedRoundRef {
  return {
    gmId: "G101",
    gmTs,
    sourceUrl: `https://www.betman.co.kr/main/mainPage/gamebuy/gameSlip.do?gmId=G101&gmTs=${gmTs}`,
    announcedAt: null,
  };
}

function claimedRound(ref: ClosedRoundRef): ClaimedClosedRound {
  return { ...ref, leaseToken: `00000000-0000-4000-8000-${ref.gmTs.padStart(12, "0")}` };
}

function roundDocument(ref: ClosedRoundRef, providerFinal = true): ClosedRoundDocument {
  return { round: ref, fetchedAt: instant, providerFinal, payload: {} };
}

function parsedRound(document: ClosedRoundDocument): ParsedClosedRound {
  return {
    round: document.round,
    fetchedAt: document.fetchedAt,
    providerFinal: document.providerFinal,
    eventFrom: null,
    eventTo: null,
    matches: [],
  };
}

function controlledDependencies(discovered: ClosedRoundRef[], controls: Controls = {}) {
  const observed: Observed = {
    sessions: 0,
    discoveries: 0,
    registered: [],
    claimInputs: [],
    claimTimestamps: [],
    claimLimits: [],
    detailCalls: [],
    persistCalls: [],
    released: [],
    releaseClaimTimestamps: [],
    persistLeaseTokens: [],
    rematchInputs: [],
    recorded: [],
    events: [],
    activeDetails: 0,
    maxActiveDetails: 0,
  };
  const adapter: BetmanClosedAdapter = {
    async discoverRounds() {
      observed.discoveries += 1;
      observed.events.push("discover");
      return discovered;
    },
    async fetchRound(ref) {
      observed.events.push(`fetch:${ref.gmTs}`);
      observed.detailCalls.push(ref.gmTs);
      observed.activeDetails += 1;
      observed.maxActiveDetails = Math.max(observed.maxActiveDetails, observed.activeDetails);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return controls.fetch ? await controls.fetch(ref) : roundDocument(ref);
      } finally {
        observed.activeDetails -= 1;
      }
    },
  };
  const store: OddsHistoryStore = {
    async registerRounds(rounds) {
      observed.events.push("register");
      observed.registered.push(rounds.map(({ gmTs }) => gmTs));
      await controls.register?.();
    },
    async query() {
      throw new Error("not used by sync tests");
    },
    async claimCandidates(keys, now, limit) {
      observed.events.push("claim");
      observed.claimInputs.push([...keys]);
      observed.claimTimestamps.push(now);
      observed.claimLimits.push(limit);
      if (controls.claim) return controls.claim(keys, now, limit);
      const claimed = keys.slice(0, limit).map((key) => claimedRound(round(key.slice("G101:".length))));
      return {
        claimed,
        busy: [],
        skippedFinal: 0,
        deferredPending: 0,
        nextPendingRetryAt: null,
        nextIndex: claimed.length,
      };
    },
    async persistRound(parsed, _now, leaseToken) {
      observed.persistCalls.push(parsed.round.gmTs);
      observed.persistLeaseTokens.push(leaseToken);
      if (controls.persist) return controls.persist(parsed);
      return {
        status: parsed.providerFinal ? "FINAL" : "PENDING",
        inserted: 1,
        updatedPending: 0,
        preservedFinal: 0,
        excluded: emptyExcluded,
      };
    },
    async recordRoundError(ref, code, message) {
      observed.recorded.push({ gmTs: ref.gmTs, code, message });
      await controls.recordError?.(ref, code, message);
    },
    async rematchFinalTeamFailures(keys) {
      observed.events.push("rematch");
      observed.rematchInputs.push([...keys]);
      return await controls.rematch?.() ?? 0;
    },
    async releaseLease(key, leaseToken) {
      observed.released.push(key);
      observed.releaseClaimTimestamps.push(leaseToken);
      await controls.release?.(key, leaseToken);
    },
  };
  const deps: SyncDependencies = {
    adapter,
    store,
    async createSession() {
      observed.sessions += 1;
      observed.events.push("session");
      return await controls.createSession?.() ?? { cookie: "JSESSIONID=test-secret" };
    },
    parseRound: controls.parse ?? parsedRound,
    now: () => new Date(instant),
  };
  return { deps, observed };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/odds-history/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function responseFor(input: SyncInput, deps: SyncDependencies) {
  return handleOddsHistorySync(post(input), { run: (parsed) => runOddsHistorySync(parsed, deps), now: deps.now });
}

test("sync fetches at most five rounds with at most two details active", async () => {
  const discovered = [1, 2, 3, 4, 5, 6, 7].map((value) => round(String(260100 + value)));
  const { deps, observed } = controlledDependencies(discovered);

  const result = await runOddsHistorySync({ from, to, cursor: null }, deps);

  assert.equal(result.processedRounds, 5);
  assert.equal(observed.maxActiveDetails, 2);
  assert.equal(result.maxRoundsPerRequest, 5);
  assert.equal(result.maxParallelDetails, 2);
  assert.equal(result.hasMore, true);
  assert.ok(result.nextCursor);
  assert.deepEqual(observed.detailCalls, ["260107", "260106", "260105", "260104", "260103"]);
  const cursor = decodeSyncCursor(result.nextCursor, { from, to }, discovered.toReversed().map(({ gmId, gmTs }) => `${gmId}:${gmTs}`), new Date(instant));
  assert.equal(cursor.nextIndex, 5);
  assert.equal(result.startedAt, instant);
  assert.equal(result.finishedAt, instant);
});

test("delayed waves claim only available workers and give the fifth attempt a fresh lease", async () => {
  const discovered = [5, 4, 3, 2, 1].map((value) => round(String(260100 + value)));
  let current = "2026-08-21T00:00:00.000Z";
  let persisted = 0;
  const { deps, observed } = controlledDependencies(discovered, {
    persist: (parsed) => {
      persisted += 1;
      if (persisted === 2) current = "2026-08-21T00:00:50.000Z";
      if (persisted === 4) current = "2026-08-21T00:01:40.000Z";
      return {
        status: parsed.providerFinal ? "FINAL" : "PENDING",
        inserted: 1,
        updatedPending: 0,
        preservedFinal: 0,
        excluded: emptyExcluded,
      };
    },
  });
  deps.now = () => new Date(current);

  const result = await runOddsHistorySync({ from, to, cursor: null }, deps);

  assert.equal(result.processedRounds, 5);
  assert.deepEqual(observed.claimLimits, [2, 2, 1]);
  assert.deepEqual(observed.claimTimestamps, [
    "2026-08-21T00:00:00.000Z",
    "2026-08-21T00:00:50.000Z",
    "2026-08-21T00:01:40.000Z",
  ]);
  assert.deepEqual(observed.releaseClaimTimestamps, observed.persistLeaseTokens);
  assert.ok(observed.releaseClaimTimestamps.every((token) => /^[0-9a-f-]{36}$/u.test(token)));
});

test("continuation rediscovers but does not repeat full registration or rematching", async () => {
  const discovered = [7, 6, 5, 4, 3, 2, 1].map((value) => round(String(260100 + value)));
  const { deps, observed } = controlledDependencies(discovered);
  const first = await runOddsHistorySync({ from, to, cursor: null }, deps);
  assert.ok(first.nextCursor);

  const second = await runOddsHistorySync({ from, to, cursor: first.nextCursor }, deps);

  assert.equal(observed.sessions, 2);
  assert.equal(observed.discoveries, 2);
  assert.equal(observed.registered.length, 1);
  assert.deepEqual(observed.claimInputs, [
    ["G101:260107", "G101:260106", "G101:260105", "G101:260104", "G101:260103", "G101:260102", "G101:260101"],
    ["G101:260105", "G101:260104", "G101:260103", "G101:260102", "G101:260101"],
    ["G101:260103", "G101:260102", "G101:260101"],
    ["G101:260102", "G101:260101"],
  ]);
  assert.equal(second.processedRounds, 2);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(observed.rematchInputs, [
    ["G101:260107", "G101:260106", "G101:260105", "G101:260104", "G101:260103", "G101:260102", "G101:260101"],
    ["G101:260102", "G101:260101"],
  ]);
});

test("cursor progress keeps earlier pending work and retry timing sticky across pages", async () => {
  const discovered = [7, 6, 5, 4, 3, 2, 1].map((value) => round(String(260100 + value)));
  const retryAt = "2026-08-21T00:40:00.000Z";
  const { deps } = controlledDependencies(discovered, {
    claim: (keys, _now, limit) => {
      if (keys.length === 7) {
        return {
          claimed: keys.slice(1, 1 + limit).map((key) => claimedRound(round(key.slice(5)))),
          busy: [],
          skippedFinal: 0,
          deferredPending: 1,
          nextPendingRetryAt: retryAt,
          nextIndex: 1 + limit,
        };
      }
      const claimed = keys.slice(0, limit).map((key) => claimedRound(round(key.slice(5))));
      return { claimed, busy: [], skippedFinal: 0, deferredPending: 0, nextPendingRetryAt: null, nextIndex: claimed.length };
    },
  });

  const first = await runOddsHistorySync({ from, to, cursor: null }, deps);
  assert.equal(first.status, "partial");
  assert.equal(first.remainingUnresolvedRounds, 1);
  assert.equal(first.deferredPendingRounds, 1);
  assert.equal(first.nextPendingRetryAt, retryAt);
  assert.ok(first.nextCursor);

  const second = await runOddsHistorySync({ from, to, cursor: first.nextCursor }, deps);
  assert.equal(second.processedRounds, 1);
  assert.equal(second.status, "partial");
  assert.equal(second.remainingUnresolvedRounds, 1);
  assert.equal(second.deferredPendingRounds, 1);
  assert.equal(second.nextPendingRetryAt, retryAt);
});

test("a POST inspects and rematches only a bounded cursor window", async () => {
  const discovered = Array.from({ length: 60 }, (_, index) => round(String(260001 + index)));
  const { deps, observed } = controlledDependencies(discovered, {
    claim: (keys) => ({
      claimed: [],
      busy: [],
      skippedFinal: keys.length,
      deferredPending: 0,
      nextPendingRetryAt: null,
      nextIndex: keys.length,
    }),
  });

  const result = await runOddsHistorySync({ from, to, cursor: null }, deps);
  assert.equal(observed.registered[0].length, 60);
  assert.equal(observed.claimInputs[0].length, MAX_CURSOR_INSPECTIONS_PER_SYNC);
  assert.equal(observed.rematchInputs[0].length, MAX_CURSOR_INSPECTIONS_PER_SYNC);
  assert.equal(result.processedRounds, 0);
  assert.equal(result.hasMore, true);
  assert.ok(result.nextCursor);
  const cursor = decodeSyncCursor(
    result.nextCursor,
    { from, to },
    discovered.toReversed().map(({ gmId, gmTs }) => `${gmId}:${gmTs}`),
    new Date(instant),
  );
  assert.equal(cursor.nextIndex, MAX_CURSOR_INSPECTIONS_PER_SYNC);
});

test("sync performs local rematching before detail network work", async () => {
  const { deps, observed } = controlledDependencies([round("260101")]);
  await runOddsHistorySync({ from, to, cursor: null }, deps);
  assert.ok(observed.events.indexOf("rematch") < observed.events.indexOf("fetch:260101"));
});

test("sync skips FINAL and cooling PENDING while advancing cursor", async () => {
  const { deps, observed } = controlledDependencies([round("260102"), round("260101")], {
    claim: () => ({
      claimed: [],
      busy: [],
      skippedFinal: 1,
      deferredPending: 1,
      nextPendingRetryAt: "2026-08-21T00:40:00.000Z",
      nextIndex: 2,
    }),
  });

  const result = await runOddsHistorySync({ from, to, cursor: null }, deps);

  assert.equal(result.processedRounds, 0);
  assert.equal(result.deferredPendingRounds, 1);
  assert.equal(result.nextPendingRetryAt, "2026-08-21T00:40:00.000Z");
  assert.equal(result.remainingUnresolvedRounds, 1);
  assert.equal(result.status, "partial");
  assert.equal(observed.detailCalls.length, 0);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextCursor, null);
});

test("partial round errors preserve successful rounds and release every lease", async () => {
  const secret = "session-cookie-secret";
  const { deps, observed } = controlledDependencies([round("260102"), round("260101")], {
    fetch: (ref) => {
      if (ref.gmTs === "260102") {
        throw new OddsHistoryValidationError("BETMAN_UNAVAILABLE", `Cookie: ${secret}\nprovider raw body`, null, true);
      }
      return roundDocument(ref);
    },
  });

  const response = await responseFor({ from, to, cursor: null }, deps);
  const payload = await response.json() as {
    status: string;
    processedRounds: number;
    remainingUnresolvedRounds: number;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.status, "partial");
  assert.equal(payload.processedRounds, 2);
  assert.equal(payload.remainingUnresolvedRounds, 1);
  assert.deepEqual(observed.persistCalls, ["260101"]);
  assert.deepEqual(observed.released.sort(), ["G101:260101", "G101:260102"]);
  assert.equal(observed.recorded[0].code, "BETMAN_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(secret, "u"));
  assert.doesNotMatch(JSON.stringify(payload), /raw body|stack|cookie/i);
});

test("structured sync telemetry is allowlisted, correlated, timed, and secret-free", async () => {
  const secret = "provider-cookie-and-raw-body";
  const events: OddsHistoryOperationalEvent[] = [];
  const { deps } = controlledDependencies([round("260102"), round("260101")], {
    fetch: (ref) => {
      if (ref.gmTs === "260102") throw new Error(secret);
      return roundDocument(ref);
    },
  });
  deps.correlationId = "request:test-2601";
  deps.logger = (event) => events.push(event);

  const result = await runOddsHistorySync({ from, to, cursor: null }, deps);

  assert.equal(result.status, "partial");
  assert.equal(events.length, 3);
  const roundEvents = events.filter((event) => event.event === "odds_history.round");
  const aggregate = events.find((event) => event.event === "odds_history.sync");
  assert.equal(roundEvents.length, 2);
  assert.deepEqual(roundEvents.map((event) => Object.keys(event).sort()), [
    ["correlationId", "durationMs", "errorCode", "event", "providerLatencyMs", "roundKey", "status"],
    ["correlationId", "durationMs", "errorCode", "event", "providerLatencyMs", "roundKey", "status"],
  ]);
  assert.ok(roundEvents.every((event) => event.correlationId === "request:test-2601"));
  assert.ok(roundEvents.every((event) => event.durationMs >= 0 && event.providerLatencyMs >= 0));
  assert.ok(aggregate);
  assert.ok(aggregate.durationMs >= 0);
  assert.deepEqual({ ...aggregate, durationMs: 0 }, {
    event: "odds_history.sync",
    correlationId: "request:test-2601",
    status: "partial",
    httpStatus: 200,
    errorCode: null,
    discoveredRounds: 2,
    attemptedRounds: 2,
    succeededRounds: 1,
    partialRounds: 1,
    busyRounds: 0,
    durationMs: 0,
  });
  assert.doesNotMatch(JSON.stringify(events), new RegExp(secret, "u"));
  assert.doesNotMatch(JSON.stringify(events), /cookie|raw.body|stack|binding/iu);
});

test("a mixed busy and claimed wave represents busy work and remains partial", async () => {
  const available = round("260102");
  const busy = round("260101");
  const { deps, observed } = controlledDependencies([available, busy], {
    claim: () => ({
      claimed: [claimedRound(available)],
      busy: [busy],
      skippedFinal: 0,
      deferredPending: 0,
      nextPendingRetryAt: null,
      nextIndex: 2,
    }),
  });

  const response = await responseFor({ from, to, cursor: null }, deps);
  const payload = await response.json() as {
    status: string;
    processedRounds: number;
    remainingUnresolvedRounds: number;
    rounds: Array<{ gmTs: string; status: string; error: { code: string } | null }>;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.status, "partial");
  assert.equal(payload.processedRounds, 1);
  assert.equal(payload.remainingUnresolvedRounds, 1);
  assert.deepEqual(payload.rounds.map(({ gmTs, status, error }) => ({ gmTs, status, code: error?.code ?? null })), [
    { gmTs: "260102", status: "FINAL", code: null },
    { gmTs: "260101", status: "SYNCING", code: "ROUND_BUSY" },
  ]);
  assert.deepEqual(observed.detailCalls, ["260102"]);
});

test("a malformed claim result is a sanitized internal programming error", async () => {
  const secret = "malformed-claim-secret";
  const { deps } = controlledDependencies([round("260101")], {
    claim: () => ({
      claimed: [],
      busy: [],
      skippedFinal: 0,
      deferredPending: 0,
      nextPendingRetryAt: secret,
      nextIndex: -1,
    }),
  });

  const response = await responseFor({ from, to, cursor: null }, deps);
  const payload = await response.json() as { error: { code: string; message: string } };

  assert.equal(response.status, 500);
  assert.deepEqual(payload.error, {
    code: "INTERNAL_ERROR",
    message: "요청을 처리하지 못했습니다.",
    field: null,
    retryable: false,
  });
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(secret, "u"));
});

test("a generic recordRoundError failure is internal and does not erase its peer", async () => {
  const secret = "generic-record-error-secret";
  const { deps, observed } = controlledDependencies([round("260102"), round("260101")], {
    fetch: (ref) => {
      if (ref.gmTs === "260102") throw new OddsHistoryValidationError("BETMAN_UNAVAILABLE", "provider failed", null, true);
      return roundDocument(ref);
    },
    recordError: () => { throw new Error(secret); },
  });

  const response = await responseFor({ from, to, cursor: null }, deps);
  const payload = await response.json() as {
    status: string;
    rounds: Array<{ gmTs: string; error: { code: string; message: string } | null }>;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.status, "partial");
  assert.equal(payload.rounds.find(({ gmTs }) => gmTs === "260102")?.error?.code, "INTERNAL_ERROR");
  assert.deepEqual(observed.persistCalls, ["260101"]);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(secret, "u"));
});

test("a generic release failure is internal and preserves persisted peers", async () => {
  const secret = "generic-release-secret";
  const { deps, observed } = controlledDependencies([round("260102"), round("260101")], {
    release: (key) => {
      if (key === "G101:260102") throw new Error(secret);
    },
  });

  const response = await responseFor({ from, to, cursor: null }, deps);
  const payload = await response.json() as {
    status: string;
    rounds: Array<{ gmTs: string; status: string; error: { code: string; message: string } | null }>;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.status, "partial");
  assert.deepEqual(observed.persistCalls.sort(), ["260101", "260102"]);
  assert.deepEqual(payload.rounds.find(({ gmTs }) => gmTs === "260102"), {
    gmTs: "260102",
    status: "FINAL",
    inserted: 1,
    updatedPending: 0,
    preservedFinal: 0,
    excluded: emptyExcluded,
    error: { code: "INTERNAL_ERROR", message: "요청을 처리하지 못했습니다." },
  });
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(secret, "u"));
});

test("an explicitly classified recordRoundError database failure keeps its code without erasing its peer", async () => {
  const secret = "record-error-secret";
  const { deps, observed } = controlledDependencies([round("260102"), round("260101")], {
    fetch: (ref) => {
      if (ref.gmTs === "260102") throw new OddsHistoryValidationError("BETMAN_UNAVAILABLE", "provider failed", null, true);
      return roundDocument(ref);
    },
    recordError: () => {
      throw new OddsHistoryValidationError("DATABASE_UNAVAILABLE", `Cookie: ${secret}`, null, true);
    },
  });

  const response = await responseFor({ from, to, cursor: null }, deps);
  const payload = await response.json() as {
    status: string;
    rounds: Array<{ gmTs: string; error: { code: string; message: string } | null }>;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.status, "partial");
  assert.equal(payload.rounds.find(({ gmTs }) => gmTs === "260102")?.error?.code, "DATABASE_UNAVAILABLE");
  assert.deepEqual(observed.persistCalls, ["260101"]);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(secret, "u"));
});

test("an explicitly classified release database failure keeps its code and preserves persisted peers", async () => {
  const secret = "release-secret";
  const { deps, observed } = controlledDependencies([round("260102"), round("260101")], {
    release: (key) => {
      if (key === "G101:260102") {
        throw new OddsHistoryValidationError("DATABASE_UNAVAILABLE", `Authorization: ${secret}`, null, true);
      }
    },
  });

  const response = await responseFor({ from, to, cursor: null }, deps);
  const payload = await response.json() as {
    status: string;
    remainingUnresolvedRounds: number;
    rounds: Array<{ gmTs: string; status: string; error: { code: string; message: string } | null }>;
  };

  assert.equal(response.status, 200);
  assert.equal(payload.status, "partial");
  assert.equal(payload.remainingUnresolvedRounds, 0);
  assert.deepEqual(observed.persistCalls.sort(), ["260101", "260102"]);
  assert.deepEqual(payload.rounds.find(({ gmTs }) => gmTs === "260102"), {
    gmTs: "260102",
    status: "FINAL",
    inserted: 1,
    updatedPending: 0,
    preservedFinal: 0,
    excluded: emptyExcluded,
    error: { code: "DATABASE_UNAVAILABLE", message: "D1 저장소를 사용할 수 없습니다." },
  });
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(secret, "u"));
});

test("an explicit non-final parsed round persists as PENDING without an in-request retry", async () => {
  const { deps, observed } = controlledDependencies([round("260101")], {
    fetch: (ref) => roundDocument(ref, false),
  });

  const result = await runOddsHistorySync({ from, to, cursor: null }, deps);

  assert.equal(result.rounds[0].status, "PENDING");
  assert.equal(result.status, "partial");
  assert.equal(result.remainingUnresolvedRounds, 1);
  assert.deepEqual(observed.detailCalls, ["260101"]);
  assert.deepEqual(observed.persistCalls, ["260101"]);
});

test("all attempted provider, schema, and final-conflict failures are request-level 502 errors", async () => {
  const cases: Array<{ expected: string; controls: Controls }> = [
    {
      expected: "BETMAN_UNAVAILABLE",
      controls: { fetch: () => { throw new OddsHistoryValidationError("BETMAN_UNAVAILABLE", "provider failed", null, true); } },
    },
    {
      expected: "BETMAN_SCHEMA_CHANGED",
      controls: { parse: () => { throw new BetmanHistorySchemaError("schema failed"); } },
    },
    {
      expected: "FINAL_CONFLICT",
      controls: { persist: () => { throw new Error("FINAL_CONFLICT: immutable row changed"); } },
    },
  ];

  for (const item of cases) {
    const { deps, observed } = controlledDependencies([round("260101")], item.controls);
    const response = await responseFor({ from, to, cursor: null }, deps);
    const payload = await response.json() as { error: { code: string } };
    assert.equal(response.status, 502);
    assert.equal(payload.error.code, item.expected);
    assert.deepEqual(observed.detailCalls, ["260101"]);
    assert.deepEqual(observed.released, ["G101:260101"]);
  }
});

test("zero discovery and completed FINAL skips are not misclassified as total failure", async () => {
  const empty = controlledDependencies([]);
  const emptyResponse = await responseFor({ from, to, cursor: null }, empty.deps);
  assert.equal(emptyResponse.status, 200);
  assert.deepEqual(await emptyResponse.json(), {
    status: "completed",
    processedRounds: 0,
    maxRoundsPerRequest: 5,
    maxParallelDetails: 2,
    rounds: [],
    hasMore: false,
    nextCursor: null,
    remainingUnresolvedRounds: 0,
    deferredPendingRounds: 0,
    nextPendingRetryAt: null,
    startedAt: instant,
    finishedAt: instant,
  });

  const final = controlledDependencies([round("260101")], {
    claim: () => ({ claimed: [], busy: [], skippedFinal: 1, deferredPending: 0, nextPendingRetryAt: null, nextIndex: 1 }),
  });
  const finalResponse = await responseFor({ from, to, cursor: null }, final.deps);
  assert.equal(finalResponse.status, 200);
  assert.equal((await finalResponse.json() as { status: string }).status, "completed");
});

test("all eligible leased candidates return 409 without treating cooldown as more work", async () => {
  const leased = [round("260102"), round("260101")];
  const { deps } = controlledDependencies(leased, {
    claim: () => ({ claimed: [], busy: leased, skippedFinal: 0, deferredPending: 0, nextPendingRetryAt: null, nextIndex: 2 }),
  });
  const response = await responseFor({ from, to, cursor: null }, deps);
  const payload = await response.json() as { error: { code: string; retryable: boolean } };
  assert.equal(response.status, 409);
  assert.equal(payload.error.code, "ROUND_BUSY");
  assert.equal(payload.error.retryable, true);
});

test("request-level provider failures use a fixed public message", async () => {
  const secret = "provider-cookie-secret";
  const { deps } = controlledDependencies([round("260101")]);
  deps.adapter.discoverRounds = async () => {
    throw new OddsHistoryValidationError(
      "BETMAN_UNAVAILABLE",
      `Cookie: ${secret}\nfull upstream body`,
      null,
      true,
    );
  };

  const response = await responseFor({ from, to, cursor: null }, deps);
  const payload = await response.json() as { error: { code: string; message: string } };

  assert.equal(response.status, 502);
  assert.equal(payload.error.code, "BETMAN_UNAVAILABLE");
  assert.equal(payload.error.message, "Betman에 연결할 수 없습니다.");
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(secret, "u"));
  assert.doesNotMatch(JSON.stringify(payload), /upstream body/u);
});

test("continuation expiry is checked after rediscovery", async () => {
  const { deps, observed } = controlledDependencies([round("260101")]);
  let clockReads = 0;
  deps.now = () => new Date(clockReads++ === 0
    ? "2026-08-21T00:29:59.000Z"
    : "2026-08-21T00:30:01.000Z");
  const cursor = encodeSyncCursor({
    version: 1,
    from,
    to,
    roundKeys: ["G101:260101"],
    nextIndex: 0,
    issuedAt: "2026-08-21T00:00:00.000Z",
  });

  await assert.rejects(
    () => runOddsHistorySync({ from, to, cursor }, deps),
    (error: unknown) => error instanceof OddsHistoryValidationError && error.code === "INVALID_CURSOR",
  );
  assert.equal(observed.sessions, 1);
  assert.equal(observed.discoveries, 1);
  assert.equal(observed.registered.length, 0);
});

test("JSON, date, and rediscovered cursor validation failures return 400", async () => {
  let runs = 0;
  const malformed = new Request("http://localhost/api/odds-history/sync", { method: "POST", body: "{" });
  const malformedResponse = await handleOddsHistorySync(malformed, {
    run: async () => {
      runs += 1;
      throw new Error("must not run");
    },
    now: () => new Date(instant),
  });
  assert.equal(malformedResponse.status, 400);
  assert.equal((await malformedResponse.json() as { error: { code: string } }).error.code, "INVALID_DATE");
  assert.equal(runs, 0);

  const { deps, observed } = controlledDependencies([round("260101")]);
  const invalidDate = await responseFor({ from: "2026-02-30", to, cursor: null }, deps);
  assert.equal(invalidDate.status, 400);

  const cursor = encodeSyncCursor({
    version: 1,
    from,
    to,
    roundKeys: ["G101:260999"],
    nextIndex: 0,
    issuedAt: instant,
  });
  const invalidCursor = await responseFor({ from, to, cursor }, deps);
  assert.equal(invalidCursor.status, 400);
  assert.equal((await invalidCursor.json() as { error: { code: string } }).error.code, "INVALID_CURSOR");
  assert.equal(observed.sessions, 1);
  assert.equal(observed.discoveries, 1);
  assert.equal(observed.registered.length, 0);
});

test("D1 failures return 503 and unexpected request failures return 500", async () => {
  const database = controlledDependencies([round("260101")], {
    register: () => {
      throw new OddsHistoryValidationError("DATABASE_UNAVAILABLE", "DB binding details", null, true);
    },
  });
  const databaseResponse = await responseFor({ from, to, cursor: null }, database.deps);
  assert.equal(databaseResponse.status, 503);
  assert.equal((await databaseResponse.json() as { error: { code: string } }).error.code, "DATABASE_UNAVAILABLE");

  const programming = controlledDependencies([round("260101")], {
    register: () => { throw new Error("register invariant secret"); },
  });
  const programmingResponse = await responseFor({ from, to, cursor: null }, programming.deps);
  const programmingPayload = await programmingResponse.json() as { error: { code: string } };
  assert.equal(programmingResponse.status, 500);
  assert.equal(programmingPayload.error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(programmingPayload), /invariant secret/u);

  const unexpected = controlledDependencies([round("260101")], {
    createSession: () => { throw new Error("unexpected stack details"); },
  });
  const unexpectedResponse = await responseFor({ from, to, cursor: null }, unexpected.deps);
  const payload = await unexpectedResponse.json() as { error: { code: string } };
  assert.equal(unexpectedResponse.status, 500);
  assert.equal(payload.error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(payload), /stack details/u);
});

test("generic persistence failures are internal while classified database failures remain 503", async () => {
  const programming = controlledDependencies([round("260101")], {
    persist: () => { throw new Error("INCLUDED invariant failed; Cookie: private"); },
  });
  const programmingResponse = await responseFor({ from, to, cursor: null }, programming.deps);
  const programmingPayload = await programmingResponse.json() as { error: { code: string; message: string } };
  assert.equal(programmingResponse.status, 500);
  assert.deepEqual(programmingPayload.error, {
    code: "INTERNAL_ERROR",
    message: "요청을 처리하지 못했습니다.",
    field: null,
    retryable: false,
  });
  assert.doesNotMatch(JSON.stringify(programmingPayload), /invariant|private/iu);

  const database = controlledDependencies([round("260101")], {
    persist: () => {
      throw new OddsHistoryValidationError("DATABASE_UNAVAILABLE", "binding details", null, true);
    },
  });
  const databaseResponse = await responseFor({ from, to, cursor: null }, database.deps);
  assert.equal(databaseResponse.status, 503);
  assert.equal((await databaseResponse.json() as { error: { code: string } }).error.code, "DATABASE_UNAVAILABLE");
});

test("POST bootstrap maps only missing DB loading to 503 and wiring bugs to 500", async () => {
  const unavailable = await handleOddsHistorySyncPost(post({ from, to }), {
    loadDatabase: async () => { throw new Error("cloudflare import unavailable"); },
    buildDependencies: () => { throw new Error("must not wire"); },
  });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json() as { error: { code: string } }).error.code, "DATABASE_UNAVAILABLE");

  const secret = "wiring-stack-secret";
  const unexpected = await handleOddsHistorySyncPost(post({ from, to }), {
    loadDatabase: async () => ({}) as D1Database,
    buildDependencies: () => { throw new Error(secret); },
  });
  const payload = await unexpected.json() as { error: { code: string; message: string } };
  assert.equal(unexpected.status, 500);
  assert.equal(payload.error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(secret, "u"));
});
