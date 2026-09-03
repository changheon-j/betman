import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";

test("기본 설정을 반환한다", () => {
  const config = loadConfig({});
  assert.equal(config.baseUrl, "http://127.0.0.1:5173");
  assert.equal(config.timeoutMs, 15_000);
  assert.equal(config.fixtureId, null);
});

test("환경 변수 설정을 정규화한다", () => {
  const config = loadConfig({
    HARNESS_BASE_URL: "https://example.com/",
    HARNESS_TIMEOUT_MS: "20000",
    HARNESS_FIXTURE_ID: "123",
  });
  assert.equal(config.baseUrl, "https://example.com");
  assert.equal(config.timeoutMs, 20_000);
  assert.equal(config.fixtureId, 123);
});

test("CLI base URL overrides the environment target and is validated", () => {
  const config = loadConfig(
    { HARNESS_BASE_URL: "https://environment.example/" },
    { baseUrl: "http://127.0.0.1:4173/" },
  );
  assert.equal(config.baseUrl, "http://127.0.0.1:4173");
  assert.throws(() => loadConfig({}, { baseUrl: "not-a-url" }), /base URL/i);
  assert.throws(() => loadConfig({}, { baseUrl: "file:///tmp/app" }), /http/i);
});

test("잘못된 설정을 거부한다", () => {
  assert.throws(() => loadConfig({ HARNESS_BASE_URL: "file:///tmp/app" }), /http/);
  assert.throws(() => loadConfig({ HARNESS_TIMEOUT_MS: "10" }), /100/);
  assert.throws(() => loadConfig({ HARNESS_FIXTURE_ID: "abc" }), /양의 정수/);
});
