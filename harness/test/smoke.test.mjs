import assert from "node:assert/strict";
import test from "node:test";
import { createClient } from "../src/http.mjs";
import { runSmoke } from "../src/suites/smoke.mjs";

test("smoke uses GET transport and includes stored odds history without requesting sync", async () => {
  const requests = [];
  const report = { check: async (_suite, _name, operation) => operation() };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return new URL(request.url).pathname === "/"
      ? new Response("매치뷰", { headers: { "content-type": "text/html" } })
      : Response.json({});
  };

  try {
    const client = createClient({ baseUrl: "https://harness.test", timeoutMs: 15_000 });
    await runSmoke({ client, report });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.every((request) => request.method === "GET"), true);
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    "/",
    "/api/fixtures",
    "/api/betman-odds",
    "/api/market-predictions",
    "/api/odds-history",
  ]);
  assert.equal(requests.some((request) => new URL(request.url).pathname === "/api/odds-history/sync"), false);
});
