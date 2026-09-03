import { OddsHistoryValidationError, oddsHistoryErrorResponse, parseOddsHistoryQuery } from "../../lib/odds-history-contract.ts";
import { createOddsHistoryStore, type OddsHistoryStore } from "../../lib/odds-history-store.ts";

type OddsHistoryGetDependencies = {
  store: OddsHistoryStore;
  now: () => Date;
};

export async function handleOddsHistoryGet(request: Request, deps: OddsHistoryGetDependencies): Promise<Response> {
  const now = deps.now();
  let query;
  try {
    query = parseOddsHistoryQuery(new URL(request.url), now);
  } catch (error) {
    if (error instanceof OddsHistoryValidationError) return oddsHistoryErrorResponse(error, 400);
    return oddsHistoryErrorResponse(databaseUnavailable(), 503);
  }
  try {
    return Response.json(await deps.store.query(query, now.toISOString()));
  } catch {
    return oddsHistoryErrorResponse(databaseUnavailable(), 503);
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { env } = await import("cloudflare:workers");
    if (!env.DB) return oddsHistoryErrorResponse(databaseUnavailable(), 503);
    return handleOddsHistoryGet(request, { store: createOddsHistoryStore(env.DB), now: () => new Date() });
  } catch {
    return oddsHistoryErrorResponse(databaseUnavailable(), 503);
  }
}

function databaseUnavailable() {
  return new OddsHistoryValidationError("DATABASE_UNAVAILABLE", "D1 저장소를 사용할 수 없습니다.", null, true);
}
