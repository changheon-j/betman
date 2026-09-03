import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  BETMAN_HISTORY_ORIGIN,
  BETMAN_MAX_BODY_BYTES,
  BETMAN_TIMEOUT_MS,
  createAnonymousSession,
  createBetmanClosedAdapter,
  mapWithConcurrency,
} from "../app/lib/betman-history-adapter.ts";

const entryPath = "/main/mainPage/gamebuy/closedGameList.do";
const slipPath = "/main/mainPage/gamebuy/closedGameSlip.do";
const detailPath = "/buyPsblGame/gameInfoInq.do";
const closedListPath = "/buyPsblGame/closedList.do";
const listFixture = await readFile(new URL("./fixtures/betman-history/closed-round-list.html", import.meta.url), "utf8");

function providerResponse(body: BodyInit | null, url: string, init: ResponseInit = {}): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
}

function html(body: string, url: string, headers: HeadersInit = {}): Response {
  return providerResponse(body, url, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

function json(body: unknown, url = `${BETMAN_HISTORY_ORIGIN}${detailPath}`): Response {
  return providerResponse(JSON.stringify(body), url, { status: 200, headers: { "content-type": "application/json" } });
}

function pageTwo(): string {
  return `<!doctype html><html lang="ko"><body><main data-page-kind="closed-round-list">
    <article data-closed-round>
      <a href="${slipPath}?gmId=G101&amp;gmTs=260103">프로토 승부식 260103회차</a>
      <span>경기 개최 기간</span>
      <time data-role="event-from" datetime="2026-08-18">2026.08.18</time>
      <time data-role="event-to" datetime="2026-08-19">2026.08.19</time>
    </article>
    <article data-closed-round>
      <a href="${slipPath}?gmId=G101&amp;gmTs=260105">중복 회차</a>
      <span>경기 개최 기간</span>
      <time data-role="event-from" datetime="2026-08-20">2026.08.20</time>
      <time data-role="event-to" datetime="2026-08-22">2026.08.22</time>
    </article>
  </main></body></html>`;
}

function slip(gmTs = "260105", state = "FINAL"): string {
  return `<!doctype html><html lang="ko"><body data-page-kind="closed-game-detail" data-round-status="${state}">
    <input type="hidden" name="gmId" value="G101">
    <input type="hidden" name="gmTs" value="${gmTs}">
  </body></html>`;
}

function finalPayload(gmTs = "260105") {
  return {
    gmId: "G101",
    gmTs,
    roundStatus: "FINAL",
    compSchedules: {
      keys: ["itemCode", "leagueName", "gameKind", "marketName", "condition", "matchSeq", "gameDate", "homeName", "awayName", "resultStatus", "homeScore", "awayScore", "result", "options"],
      datas: [["SC", "K리그1", "일반", "축구 승무패", "-", "1", "202608211900", "울산HD", "FC서울", "COMPLETED", "1", "0", "H", [{ label: "승", odds: "2.10" }, { label: "무", odds: "3.10" }, { label: "패", odds: "3.20" }]]],
    },
  };
}

function scriptedFetch(calls: Request[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    const url = new URL(request.url);
    if (url.pathname === entryPath) {
      return html("<!doctype html><html><body data-page-kind=\"closed-round-list\"></body></html>", request.url, { "set-cookie": "JSESSIONID=redacted; Path=/; HttpOnly" });
    }
    if (url.pathname === closedListPath) {
      const body = await request.json() as { draw: number };
      return html(body.draw === 2 ? pageTwo() : listFixture, request.url);
    }
    if (url.pathname === slipPath) return html(slip(url.searchParams.get("gmTs") ?? ""), request.url);
    if (url.pathname === detailPath) return json(finalPayload());
    throw new Error(`unexpected test URL ${url.pathname}`);
  }) as typeof fetch;
}

test("keeps anonymous cookies inside one adapter request chain and paginates sequentially", async () => {
  const calls: Request[] = [];
  const fetchImpl = scriptedFetch(calls);
  const adapter = createBetmanClosedAdapter(fetchImpl);
  const session = await createAnonymousSession(fetchImpl);
  const rounds = await adapter.discoverRounds("2026-08-18", "2026-08-21", session);
  const document = await adapter.fetchRound(rounds[0], session);

  assert.deepEqual(rounds.map((round) => round.gmTs), ["260105", "260103"]);
  assert.equal(rounds[0].sourceUrl, `${BETMAN_HISTORY_ORIGIN}${slipPath}?gmId=G101&gmTs=260105`);
  assert.equal(document.providerFinal, true);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [entryPath, closedListPath, closedListPath, slipPath, detailPath]);
  assert.equal(calls[0].headers.get("cookie"), null);
  for (const request of calls.slice(1)) assert.equal(request.headers.get("cookie"), "JSESSIONID=redacted");
});

test("uses provider event bounds and fails closed when those bounds are absent", async () => {
  const noBounds = `<!doctype html><html><body data-page-kind="closed-round-list"><article data-closed-round>
    <a href="${slipPath}?gmId=G101&amp;gmTs=260106">프로토 승부식</a>
    <time data-role="announced-at" datetime="2026-08-20T08:00:00.000Z">결과 발표</time>
  </article></body></html>`;
  let call = 0;
  const fetchImpl = (async () => {
    call += 1;
    return call === 1
      ? html("<html><body data-page-kind=\"closed-round-list\"></body></html>", `${BETMAN_HISTORY_ORIGIN}${entryPath}`, { "set-cookie": "JSESSIONID=redacted; Path=/" })
      : html(noBounds, `${BETMAN_HISTORY_ORIGIN}${entryPath}`);
  }) as typeof fetch;
  const session = await createAnonymousSession(fetchImpl);
  await assert.rejects(
    () => createBetmanClosedAdapter(fetchImpl).discoverRounds("2026-08-18", "2026-08-21", session),
    /BETMAN_SCHEMA_CHANGED/u,
  );
});

test("rejects an off-origin round link instead of normalizing its IDs", async () => {
  const advertised = `<!doctype html><html><body data-page-kind="closed-round-list"><article data-closed-round>
    <a href="https://example.com${slipPath}?gmId=G101&amp;gmTs=260106">프로토 승부식</a>
    <time data-role="event-from" datetime="2026-08-20">2026.08.20</time>
    <time data-role="event-to" datetime="2026-08-20">2026.08.20</time>
  </article></body></html>`;
  const fetchImpl = (async () => html(advertised, `${BETMAN_HISTORY_ORIGIN}${entryPath}`)) as typeof fetch;
  await assert.rejects(
    () => createBetmanClosedAdapter(fetchImpl).discoverRounds("2026-08-18", "2026-08-21", { cookie: "JSESSIONID=redacted" }),
    /BETMAN_SCHEMA_CHANGED/u,
  );
});

test("sorts discovered gmTs values by numeric value", async () => {
  const advertised = `<!doctype html><html><body data-page-kind="closed-round-list">
    ${["00009", "10"].map((gmTs) => `<article data-closed-round>
      <a href="${slipPath}?gmId=G101&amp;gmTs=${gmTs}">프로토 승부식</a>
      <time data-role="event-from" datetime="2026-08-20">2026.08.20</time>
      <time data-role="event-to" datetime="2026-08-20">2026.08.20</time>
    </article>`).join("")}
  </body></html>`;
  const fetchImpl = (async () => html(advertised, `${BETMAN_HISTORY_ORIGIN}${entryPath}`)) as typeof fetch;
  const rounds = await createBetmanClosedAdapter(fetchImpl).discoverRounds(
    "2026-08-18",
    "2026-08-21",
    { cookie: "JSESSIONID=redacted" },
  );
  assert.deepEqual(rounds.map((round) => round.gmTs), ["10", "00009"]);
});

test("rejects off-origin redirects and cancels cumulative multi-chunk overflow", async () => {
  const offOriginFetch = (async () => html("<html></html>", "https://example.com/redirected")) as typeof fetch;
  let cancelCount = 0;
  const oversizedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(BETMAN_MAX_BODY_BYTES - 1));
      controller.enqueue(new Uint8Array(1));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelCount += 1;
    },
  });
  const oversizedFetch = (async () => providerResponse(
    oversizedBody,
    `${BETMAN_HISTORY_ORIGIN}${entryPath}`,
    { headers: { "content-type": "text/html", "set-cookie": "JSESSIONID=redacted" } },
  )) as typeof fetch;
  await assert.rejects(() => createAnonymousSession(offOriginFetch), /BETMAN_UNAVAILABLE/u);
  await assert.rejects(() => createAnonymousSession(oversizedFetch), /BETMAN_SCHEMA_CHANGED/u);
  assert.equal(cancelCount, 1);
});

test("validates every manual redirect before a cookie-bearing follow-up", async () => {
  const calls: Request[] = [];
  const redirectModes: Array<RequestRedirect | undefined> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    redirectModes.push(init?.redirect);
    return providerResponse(null, request.url, {
      status: 302,
      headers: { location: "https://example.com/collect" },
    });
  }) as typeof fetch;

  await assert.rejects(
    () => createBetmanClosedAdapter(fetchImpl).discoverRounds(
      "2026-08-18",
      "2026-08-21",
      { cookie: "JSESSIONID=must-not-leak" },
    ),
    /BETMAN_UNAVAILABLE/u,
  );

  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).origin, BETMAN_HISTORY_ORIGIN);
  assert.equal(calls[0].headers.get("cookie"), "JSESSIONID=must-not-leak");
  assert.deepEqual(redirectModes, ["manual"]);
});

test("bounds approved-host redirect loops", async () => {
  const calls: Request[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    return providerResponse(null, request.url, {
      status: 302,
      headers: { location: `${BETMAN_HISTORY_ORIGIN}${entryPath}` },
    });
  }) as typeof fetch;

  await assert.rejects(() => createAnonymousSession(fetchImpl), /BETMAN_UNAVAILABLE/u);
  assert.equal(calls.length, 6);
  assert.ok(calls.every((request) => request.headers.get("cookie") === null));
});

test("aborts a stalled fetch at the fixed timeout without waiting in real time", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const observed: { signal: AbortSignal | null } = { signal: null };
  const stalledFetch = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    observed.signal = init?.signal instanceof AbortSignal ? init.signal : null;
    observed.signal?.addEventListener("abort", () => reject(observed.signal?.reason), { once: true });
  })) as typeof fetch;

  const pending = createAnonymousSession(stalledFetch);
  assert.equal(observed.signal?.aborted, false);
  context.mock.timers.tick(BETMAN_TIMEOUT_MS - 1);
  assert.equal(observed.signal?.aborted, false);
  context.mock.timers.tick(1);
  await assert.rejects(pending, /BETMAN_UNAVAILABLE/u);
  assert.equal(observed.signal?.aborted, true);
});

test("forwards only sanitized cookie pairs across multiple Set-Cookie values", async () => {
  const responseHeaders = new Headers({ "content-type": "text/html; charset=utf-8" });
  responseHeaders.append("set-cookie", "JSESSIONID=redacted; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/; HttpOnly");
  responseHeaders.append("set-cookie", "malformed-cookie-without-pair");
  responseHeaders.append("set-cookie", "ROUTE=redacted-route; Path=/; Secure");
  let call = 0;
  let forwarded: string | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    call += 1;
    const request = new Request(input, init);
    if (call === 1) {
      return providerResponse(
        '<html><body data-page-kind="closed-round-list"></body></html>',
        request.url,
        { headers: responseHeaders },
      );
    }
    forwarded = request.headers.get("cookie");
    return html('<html><body data-page-kind="closed-round-list"></body></html>', request.url);
  }) as typeof fetch;

  const session = await createAnonymousSession(fetchImpl);
  await createBetmanClosedAdapter(fetchImpl).discoverRounds("2026-08-18", "2026-08-21", session);
  assert.equal(session.cookie, "JSESSIONID=redacted; ROUTE=redacted-route");
  assert.equal(forwarded, "JSESSIONID=redacted; ROUTE=redacted-route");
});

test("rejects login pages, HTTP errors, and does not retry failed requests", async () => {
  let calls = 0;
  const failedFetch = (async () => {
    calls += 1;
    throw new TypeError("synthetic network failure");
  }) as typeof fetch;
  await assert.rejects(() => createAnonymousSession(failedFetch), /BETMAN_UNAVAILABLE/u);
  assert.equal(calls, 1);

  const loginFetch = (async () => html(
    '<html><body><form action="/login/login.do"><input type="password"></form></body></html>',
    `${BETMAN_HISTORY_ORIGIN}${entryPath}`,
    { "set-cookie": "JSESSIONID=redacted" },
  )) as typeof fetch;
  assert.equal((await createAnonymousSession(loginFetch)).cookie, "JSESSIONID=redacted");

  const httpFetch = (async () => providerResponse("unavailable", `${BETMAN_HISTORY_ORIGIN}${entryPath}`, { status: 503, headers: { "content-type": "text/html" } })) as typeof fetch;
  await assert.rejects(() => createAnonymousSession(httpFetch), /BETMAN_UNAVAILABLE/u);
});

test("relies on page markers while allowing the site's shared login navigation", async () => {
  const requiredLoginFetch = (async () => html(
    "<html><body>로그인 후 마감게임을 이용하세요.</body></html>",
    `${BETMAN_HISTORY_ORIGIN}${entryPath}`,
    { "set-cookie": "JSESSIONID=redacted" },
  )) as typeof fetch;
  assert.equal((await createAnonymousSession(requiredLoginFetch)).cookie, "JSESSIONID=redacted");

  const ordinaryNavigationFetch = (async () => html(
    '<html><body data-page-kind="closed-round-list"><a href="/login">로그인</a></body></html>',
    `${BETMAN_HISTORY_ORIGIN}${entryPath}`,
    { "set-cookie": "JSESSIONID=redacted" },
  )) as typeof fetch;
  const session = await createAnonymousSession(ordinaryNavigationFetch);
  assert.equal(session.cookie, "JSESSIONID=redacted");
});

test("fetches only fixed slip/detail paths and validates the closed payload", async () => {
  const calls: Request[] = [];
  const fetchImpl = scriptedFetch(calls);
  const session = await createAnonymousSession(fetchImpl);
  const round = {
    gmId: "G101" as const,
    gmTs: "260105",
    sourceUrl: `${BETMAN_HISTORY_ORIGIN}${slipPath}?gmId=G101&gmTs=260105`,
    announcedAt: null,
  };
  const document = await createBetmanClosedAdapter(fetchImpl).fetchRound(round, session);
  const post = calls.at(-1)!;
  assert.equal(post.method, "POST");
  assert.equal(post.url, `${BETMAN_HISTORY_ORIGIN}${detailPath}`);
  assert.deepEqual(await post.json(), { gmId: "G101", gmTs: "260105", gameYear: "", _sbmInfo: { _sbmInfo: { debugMode: "false" } } });
  assert.equal(document.round, round);
  assert.deepEqual(document.payload, finalPayload());
  assert.match(document.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
});

test("rejects mismatched slip IDs and ambiguous detail final state", async () => {
  const round = { gmId: "G101" as const, gmTs: "260105", sourceUrl: `${BETMAN_HISTORY_ORIGIN}${slipPath}?gmId=G101&gmTs=260105`, announcedAt: null };
  let calls = 0;
  const mismatchFetch = (async (input: string | URL | Request) => {
    calls += 1;
    const url = new URL(input instanceof Request ? input.url : input);
    return url.pathname === slipPath ? html(slip("260999"), url.toString()) : json(finalPayload());
  }) as typeof fetch;
  await assert.rejects(() => createBetmanClosedAdapter(mismatchFetch).fetchRound(round, { cookie: "JSESSIONID=redacted" }), /BETMAN_SCHEMA_CHANGED/u);
  assert.equal(calls, 1);

  const ambiguousFetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return url.pathname === slipPath
      ? html(slip(), url.toString())
      : json({ ...finalPayload(), roundStatus: "UNKNOWN" });
  }) as typeof fetch;
  await assert.rejects(() => createBetmanClosedAdapter(ambiguousFetch).fetchRound(round, { cookie: "JSESSIONID=redacted" }), /BETMAN_SCHEMA_CHANGED/u);
});

test("returns providerFinal false for an explicit non-final closed round", async () => {
  const round = { gmId: "G101" as const, gmTs: "260105", sourceUrl: `${BETMAN_HISTORY_ORIGIN}${slipPath}?gmId=G101&gmTs=260105`, announcedAt: null };
  const payload = { ...finalPayload(), roundStatus: "OPEN" };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return url.pathname === slipPath ? html(slip("260105", "PENDING"), url.toString()) : json(payload);
  }) as typeof fetch;
  const document = await createBetmanClosedAdapter(fetchImpl).fetchRound(round, { cookie: "JSESSIONID=redacted" });
  assert.equal(document.providerFinal, false);
  assert.equal((document.payload as { roundStatus: string }).roundStatus, "OPEN");
});

test("never runs more than two detail workers and preserves input order", async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    return value * 10;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(results, [10, 20, 30, 40, 50]);
});
