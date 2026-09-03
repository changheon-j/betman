import { invariant, isObject } from "../assertions.mjs";

export async function runSmoke({ client, report }) {
  await report.check("smoke", "메인 화면 응답", async () => {
    const { body, durationMs } = await client.text("/");
    invariant(body.includes("매치뷰"), "HTML에서 서비스명 '매치뷰'를 찾지 못했습니다.");
    return `200 OK, ${durationMs}ms`;
  });

  // Fixture-specific odds remain in the contracts suite, after a fixture ID is known.
  for (const path of [
    "/api/fixtures",
    "/api/betman-odds",
    "/api/market-predictions",
    "/api/odds-history",
  ]) {
    await report.check("smoke", `${path} 응답`, async () => {
      const { body, durationMs } = await client.json(path);
      invariant(isObject(body), "JSON 루트가 객체가 아닙니다.");
      return `200 OK, ${durationMs}ms`;
    });
  }
}
