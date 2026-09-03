import {
  isoDateBoundary,
  makePredictionKey,
  missingStablePredictionColumns,
  missingPredictionSelectionColumns,
  parsePredictionInput,
  parsePredictionKeys,
  savePredictionSelections,
} from "../../lib/market-prediction";

type MarketPredictionRow = {
  prediction_key: string;
  match_id: number;
  match_date: string;
  kickoff_time: string;
  home_team: string;
  away_team: string;
  market_index: number;
  market_type: string;
  market_condition: string;
  betman_round: string | null;
  match_seq: string | null;
  options_json: string;
  probability_sum: number;
  saved_at: string;
  selected_option_index: number | null;
};

async function tableColumns(database: D1Database) {
  const result = await database.prepare("PRAGMA table_info(market_predictions)").all<{ name: string }>();
  return result.results;
}

async function prepareTable() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS market_predictions (
        prediction_key TEXT PRIMARY KEY,
        match_id INTEGER NOT NULL,
        match_date TEXT NOT NULL,
        kickoff_time TEXT NOT NULL,
        home_team TEXT NOT NULL,
        away_team TEXT NOT NULL,
        market_index INTEGER NOT NULL,
        market_type TEXT NOT NULL,
        market_condition TEXT NOT NULL,
        betman_round TEXT,
        match_seq TEXT,
        options_json TEXT NOT NULL,
        probability_sum REAL NOT NULL,
        saved_at TEXT NOT NULL,
        selected_option_index INTEGER CHECK (selected_option_index IS NULL OR selected_option_index BETWEEN 0 AND 2)
      )
    `),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_market_predictions_saved_at ON market_predictions(saved_at)"),
  ]);

  for (const column of missingStablePredictionColumns(await tableColumns(env.DB))) {
    try {
      await env.DB.prepare(`ALTER TABLE market_predictions ADD COLUMN ${column} TEXT`).run();
    } catch (error) {
      if (missingStablePredictionColumns(await tableColumns(env.DB)).includes(column)) throw error;
    }
  }
  for (const column of missingPredictionSelectionColumns(await tableColumns(env.DB))) {
    try {
      await env.DB.prepare(`ALTER TABLE market_predictions ADD COLUMN ${column} INTEGER CHECK (${column} IS NULL OR ${column} BETWEEN 0 AND 2)`).run();
    } catch (error) {
      if (missingPredictionSelectionColumns(await tableColumns(env.DB)).includes(column)) throw error;
    }
  }
  return env.DB;
}

let schemaReady: ReturnType<typeof prepareTable> | null = null;

async function ensureTable() {
  if (!schemaReady) {
    schemaReady = prepareTable().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function dateBoundary(value: string | null, endOfDay: boolean) {
  if (!value) return null;
  try {
    return isoDateBoundary(value, endOfDay);
  } catch {
    throw new Error("조회일자는 실제 존재하는 YYYY-MM-DD 날짜여야 합니다.");
  }
}

export async function GET(request: Request) {
  try {
    const database = await ensureTable();
    const url = new URL(request.url);
    const from = dateBoundary(url.searchParams.get("from"), false);
    const to = dateBoundary(url.searchParams.get("to"), true);
    if (from && to && from > to) return Response.json({ error: "시작일은 종료일보다 늦을 수 없습니다." }, { status: 400 });
    const conditions: string[] = [];
    const bindings: string[] = [];
    if (from) { conditions.push("saved_at >= ?"); bindings.push(from); }
    if (to) { conditions.push("saved_at <= ?"); bindings.push(to); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const statement = database.prepare(`
      SELECT prediction_key, match_id, match_date, kickoff_time, home_team, away_team,
              market_index, market_type, market_condition, betman_round, match_seq, options_json,
             probability_sum, saved_at, selected_option_index
      FROM market_predictions
      ${where}
      ORDER BY saved_at DESC
      LIMIT 200
    `);
    const result = bindings.length
      ? await statement.bind(...bindings).all<MarketPredictionRow>()
      : await statement.all<MarketPredictionRow>();

    const predictions = result.results.map((row) => ({
      predictionKey: row.prediction_key,
      matchId: row.match_id,
      matchDate: row.match_date,
      kickoffTime: row.kickoff_time,
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      marketIndex: row.market_index,
      marketType: row.market_type,
      marketCondition: row.market_condition,
      betmanRound: row.betman_round,
      matchSeq: row.match_seq,
      options: JSON.parse(String(row.options_json)),
      probabilitySum: row.probability_sum,
      savedAt: row.saved_at,
      selectedOptionIndex: row.selected_option_index,
    }));

    return Response.json({ predictions });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "저장 데이터를 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const database = await ensureTable();
    const result = await savePredictionSelections(await request.json(), {
      async readSelectionTargets(predictionKeys) {
        const placeholders = predictionKeys.map(() => "?").join(", ");
        const rows = await database.prepare(`
          SELECT prediction_key, json_array_length(options_json) AS option_count
          FROM market_predictions
          WHERE prediction_key IN (${placeholders})
        `).bind(...predictionKeys).all<{ prediction_key: string; option_count: number }>();
        return rows.results.map((row) => ({ predictionKey: row.prediction_key, optionCount: Number(row.option_count) }));
      },
      async writeSelections(updates) {
        const results = await database.batch(updates.map((update) => database.prepare(`
          UPDATE market_predictions SET selected_option_index = ? WHERE prediction_key = ?
        `).bind(update.selectedOptionIndex, update.predictionKey)));
        return results.reduce((total, update) => total + (update.meta.changes ?? 0), 0);
      },
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "선택 상태를 저장하지 못했습니다." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const database = await ensureTable();
    const payload = (await request.json()) as { predictionKeys?: unknown };
    const predictionKeys = parsePredictionKeys(payload.predictionKeys);
    const placeholders = predictionKeys.map(() => "?").join(", ");
    const result = await database.prepare(`DELETE FROM market_predictions WHERE prediction_key IN (${placeholders})`).bind(...predictionKeys).run();
    return Response.json({ deleted: result.meta.changes ?? 0 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "삭제하지 못했습니다." }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const database = await ensureTable();
    const parsed = parsePredictionInput(await request.json());
    const {
      matchId, matchDate, kickoffTime, homeTeam, awayTeam, marketIndex,
      marketType, marketCondition, betmanRound, matchSeq, options, probabilitySum,
    } = parsed;
    const predictionKey = makePredictionKey({ matchId, betmanRound, matchSeq });
    const savedAt = new Date().toISOString();
    await database.prepare(`
      INSERT INTO market_predictions (
        prediction_key, match_id, match_date, kickoff_time, home_team, away_team,
        market_index, market_type, market_condition, betman_round, match_seq,
        options_json, probability_sum, saved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(prediction_key) DO UPDATE SET
        match_date = excluded.match_date,
        kickoff_time = excluded.kickoff_time,
        market_index = excluded.market_index,
        market_type = excluded.market_type,
        market_condition = excluded.market_condition,
        betman_round = excluded.betman_round,
        match_seq = excluded.match_seq,
        options_json = excluded.options_json,
        probability_sum = excluded.probability_sum,
        saved_at = excluded.saved_at
    `).bind(
      predictionKey, matchId, matchDate, kickoffTime, homeTeam, awayTeam,
      marketIndex, marketType, marketCondition, betmanRound, matchSeq,
      JSON.stringify(options), probabilitySum, savedAt
    ).run();

    return Response.json({
      prediction: { predictionKey, matchId, matchDate, kickoffTime, homeTeam, awayTeam, marketIndex, marketType, marketCondition, betmanRound, matchSeq, options, probabilitySum, savedAt },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "저장하지 못했습니다." }, { status: 400 });
  }
}
