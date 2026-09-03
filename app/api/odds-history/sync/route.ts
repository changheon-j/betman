import {
  createAnonymousSession,
  createBetmanClosedAdapter,
} from "../../../lib/betman-history-adapter.ts";
import { parseClosedRoundDocument } from "../../../lib/betman-history-parser.ts";
import { OddsHistoryValidationError, oddsHistoryErrorResponse } from "../../../lib/odds-history-contract.ts";
import { createOddsHistoryStore } from "../../../lib/odds-history-store.ts";
import {
  handleOddsHistorySync,
  runOddsHistorySync,
  syncErrorResponse,
  type SyncDependencies,
  type SyncRouteDependencies,
} from "../../../lib/odds-history-sync.ts";

export { handleOddsHistorySync, type SyncRouteDependencies };

export type SyncPostBootstrapDependencies = {
  loadDatabase: () => Promise<D1Database | null>;
  buildDependencies: (database: D1Database) => SyncDependencies;
};

export async function handleOddsHistorySyncPost(
  request: Request,
  bootstrap: SyncPostBootstrapDependencies,
): Promise<Response> {
  let database: D1Database | null;
  try {
    database = await bootstrap.loadDatabase();
  } catch {
    return databaseUnavailableResponse();
  }
  if (!database) return databaseUnavailableResponse();
  try {
    const deps = bootstrap.buildDependencies(database);
    return handleOddsHistorySync(request, {
      run: (input) => runOddsHistorySync(input, deps),
      now: deps.now,
    });
  } catch (error) {
    return syncErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleOddsHistorySyncPost(request, {
    async loadDatabase() {
      const { env } = await import("cloudflare:workers");
      return env.DB ?? null;
    },
    buildDependencies: (database) => ({
      adapter: createBetmanClosedAdapter(),
      store: createOddsHistoryStore(database),
      createSession: () => createAnonymousSession(),
      parseRound: parseClosedRoundDocument,
      now: () => new Date(),
      correlationId: request.headers.get("cf-ray") ?? request.headers.get("x-request-id") ?? undefined,
      logger: (event) => console.info(JSON.stringify(event)),
    }),
  });
}

function databaseUnavailableResponse(): Response {
  return oddsHistoryErrorResponse(
    new OddsHistoryValidationError(
      "DATABASE_UNAVAILABLE",
      "D1 저장소를 사용할 수 없습니다.",
      null,
      true,
    ),
    503,
  );
}
