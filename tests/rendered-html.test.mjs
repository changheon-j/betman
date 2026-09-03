import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the K1 and J1 match guide", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>매치뷰 \| K리그1 · J리그1 경기 가이드<\/title>/);
  assert.match(html, /배당기록/);
  assert.match(html, /저장된경기/);
  assert.match(html, /API-Football · 현재/);
  assert.match(html, /Betman 마감게임 · D1 아카이브/);
  assert.match(html, /K리그1과 J리그1 경기 일정을 불러오는 중입니다/);
  assert.match(html, /한국시간 오늘부터 14일 이내 예정 경기/);
  assert.match(html, /data-testid="fixture-loading"/);
  assert.doesNotMatch(html, /2024\.08\.07|2024\.08\.21|2026\.07\.25/);
  assert.doesNotMatch(html, /샘플 데이터|데모 데이터|화면 기능 검증을 위한 샘플/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview/);
});
