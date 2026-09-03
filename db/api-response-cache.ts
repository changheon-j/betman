import {
  SharedCacheStorageError,
  type SharedCacheStore,
  type StoredCacheEntry,
} from "../app/lib/shared-api-cache.ts";

type CacheRow = {
  payload_json: string | null;
  fetched_at: string | null;
  expires_at: number;
  stale_until: number;
  lease_token: string | null;
  lease_until: number;
};

function changed(result: D1Result<unknown>) {
  return Number(result.meta.changes ?? 0) === 1;
}

async function d1Operation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SharedCacheStorageError) throw error;
    throw new SharedCacheStorageError();
  }
}

export function createD1ApiResponseCache(database: D1Database): SharedCacheStore {
  return {
    async read(key) {
      const row = await d1Operation(() => database.prepare(`
        -- api-cache-read
        SELECT payload_json, fetched_at, expires_at, stale_until, lease_token, lease_until
        FROM api_response_cache
        WHERE cache_key = ?
      `).bind(key).first<CacheRow>());
      return row ? {
        payloadJson: row.payload_json,
        fetchedAt: row.fetched_at,
        expiresAt: Number(row.expires_at),
        staleUntil: Number(row.stale_until),
        leaseToken: row.lease_token,
        leaseUntil: Number(row.lease_until),
      } : null;
    },

    async acquireLease(key, token, now, leaseUntil) {
      const result = await d1Operation(() => database.prepare(`
        -- api-cache-acquire
        INSERT INTO api_response_cache (
          cache_key, payload_json, fetched_at, expires_at, stale_until,
          lease_token, lease_until, updated_at
        ) VALUES (?, NULL, NULL, 0, 0, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          lease_token = excluded.lease_token,
          lease_until = excluded.lease_until,
          updated_at = excluded.updated_at
        WHERE api_response_cache.lease_until <= ?
      `).bind(key, token, leaseUntil, new Date(now).toISOString(), now).run());
      return changed(result);
    },

    async writeSuccess(key, token, entry: StoredCacheEntry) {
      const result = await d1Operation(() => database.prepare(`
        -- api-cache-write
        UPDATE api_response_cache SET
          payload_json = ?, fetched_at = ?, expires_at = ?, stale_until = ?,
          lease_token = NULL, lease_until = 0, updated_at = ?
        WHERE cache_key = ? AND lease_token = ?
      `).bind(
        entry.payloadJson,
        entry.fetchedAt,
        entry.expiresAt,
        entry.staleUntil,
        entry.fetchedAt,
        key,
        token,
      ).run());
      return changed(result);
    },

    async releaseLease(key, token) {
      await d1Operation(() => database.prepare(`
        -- api-cache-release
        UPDATE api_response_cache SET
          lease_token = NULL, lease_until = 0, updated_at = ?
        WHERE cache_key = ? AND lease_token = ?
      `).bind(new Date().toISOString(), key, token).run());
    },
  };
}

let schemaReady: Promise<D1Database> | null = null;

async function prepareCacheTable(database: D1Database) {
  await d1Operation(() => database.batch([
    database.prepare(`
      CREATE TABLE IF NOT EXISTS api_response_cache (
        cache_key TEXT PRIMARY KEY,
        payload_json TEXT,
        fetched_at TEXT,
        expires_at INTEGER NOT NULL DEFAULT 0,
        stale_until INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS idx_api_response_cache_stale_until
      ON api_response_cache(stale_until)
    `),
  ]));
  return database;
}

export async function getD1ApiResponseCache(): Promise<SharedCacheStore> {
  return d1Operation(async () => {
    const { env } = await import("cloudflare:workers");
    if (!env.DB) throw new SharedCacheStorageError();
    if (!schemaReady) {
      schemaReady = prepareCacheTable(env.DB).catch((error) => {
        schemaReady = null;
        throw error;
      });
    }
    return createD1ApiResponseCache(await schemaReady);
  });
}
