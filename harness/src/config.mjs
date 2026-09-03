const DEFAULT_BASE_URL = "http://127.0.0.1:5173";
const DEFAULT_TIMEOUT_MS = 15_000;

export function loadConfig(env = process.env, overrides = {}) {
  let baseUrl;
  try {
    baseUrl = new URL(overrides.baseUrl ?? env.HARNESS_BASE_URL ?? DEFAULT_BASE_URL);
  } catch {
    throw new Error("Harness base URL must be a valid absolute URL.");
  }
  if (!["http:", "https:"].includes(baseUrl.protocol)) {
    throw new Error("HARNESS_BASE_URL은 http 또는 https 주소여야 합니다.");
  }

  const timeoutMs = Number(env.HARNESS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100) {
    throw new Error("HARNESS_TIMEOUT_MS는 100 이상의 정수여야 합니다.");
  }

  const fixtureId = env.HARNESS_FIXTURE_ID
    ? Number(env.HARNESS_FIXTURE_ID)
    : null;
  if (fixtureId !== null && (!Number.isInteger(fixtureId) || fixtureId <= 0)) {
    throw new Error("HARNESS_FIXTURE_ID는 양의 정수여야 합니다.");
  }

  return {
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    timeoutMs,
    fixtureId,
  };
}
