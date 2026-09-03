export async function request(baseUrl, path, { timeoutMs, json = true } = {}) {
  const startedAt = performance.now();
  let response;

  try {
    response = await fetch(new URL(path, `${baseUrl}/`), {
      method: "GET",
      headers: { accept: json ? "application/json" : "text/html" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`GET ${path} 연결 실패: ${error.message}`, { cause: error });
  }

  const body = json ? await response.json() : await response.text();
  const durationMs = Math.round(performance.now() - startedAt);
  if (!response.ok) {
    const detail = typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body);
    throw new Error(`GET ${path} HTTP ${response.status}: ${detail}`);
  }

  return { body, status: response.status, durationMs };
}

export function createClient(config) {
  return {
    json: (path) => request(config.baseUrl, path, { timeoutMs: config.timeoutMs }),
    text: (path) => request(config.baseUrl, path, {
      timeoutMs: config.timeoutMs,
      json: false,
    }),
  };
}
