import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import { betmanHistoryMatches, betmanHistoryRounds } from "../db/schema.ts";

test("history schema exports two separate tables", () => {
  assert.equal(getTableName(betmanHistoryRounds), "betman_history_rounds");
  assert.equal(getTableName(betmanHistoryMatches), "betman_history_matches");
  assert.equal(getTableColumns(betmanHistoryRounds).leaseToken?.name, "lease_token");
});

test("migration has checks, foreign key, unique keys, and no delete trigger", () => {
  const sql = readFileSync("drizzle/0004_betman_odds_history.sql", "utf8");
  for (const token of ["CHECK", "REFERENCES `betman_history_rounds`", "UNIQUE", "idx_betman_history_matches_league_date"]) assert.match(sql, new RegExp(token));
  assert.match(sql, /`lease_token` text/u);
  const snapshot = JSON.parse(readFileSync("drizzle/meta/0004_snapshot.json", "utf8")) as {
    tables: { betman_history_rounds: { columns: Record<string, unknown> } };
  };
  assert.ok(snapshot.tables.betman_history_rounds.columns.lease_token);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+betman_history/i);
});
