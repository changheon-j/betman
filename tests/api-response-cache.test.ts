import assert from "node:assert/strict";
import test from "node:test";
import { createD1ApiResponseCache } from "../db/api-response-cache.ts";
import type { StoredCacheEntry } from "../app/lib/shared-api-cache.ts";

type Row = {
  cache_key: string;
  payload_json: string | null;
  fetched_at: string | null;
  expires_at: number;
  stale_until: number;
  lease_token: string | null;
  lease_until: number;
  updated_at: string;
};

class FakeStatement {
  constructor(readonly database: FakeD1, readonly sql: string, readonly values: unknown[] = []) {}

  bind(...values: unknown[]) {
    return new FakeStatement(this.database, this.sql, values);
  }

  first<T>() {
    return Promise.resolve(this.database.first(this) as T | null);
  }

  run<T>() {
    return Promise.resolve(this.database.run(this) as T);
  }
}

class FakeD1 {
  rows = new Map<string, Row>();

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  first(statement: FakeStatement) {
    assert.match(statement.sql, /api-cache-read/);
    const row = this.rows.get(String(statement.values[0]));
    return row ? structuredClone(row) : null;
  }

  run(statement: FakeStatement) {
    let changes = 0;
    if (statement.sql.includes("api-cache-acquire")) {
      const [key, token, leaseUntil, updatedAt, now] = statement.values;
      const current = this.rows.get(String(key));
      if (!current) {
        this.rows.set(String(key), {
          cache_key: String(key), payload_json: null, fetched_at: null,
          expires_at: 0, stale_until: 0, lease_token: String(token),
          lease_until: Number(leaseUntil), updated_at: String(updatedAt),
        });
        changes = 1;
      } else if (current.lease_until <= Number(now)) {
        current.lease_token = String(token);
        current.lease_until = Number(leaseUntil);
        current.updated_at = String(updatedAt);
        changes = 1;
      }
    } else if (statement.sql.includes("api-cache-write")) {
      const [payloadJson, fetchedAt, expiresAt, staleUntil, updatedAt, key, token] = statement.values;
      const current = this.rows.get(String(key));
      if (current && current.lease_token === token) {
        Object.assign(current, {
          payload_json: String(payloadJson), fetched_at: String(fetchedAt),
          expires_at: Number(expiresAt), stale_until: Number(staleUntil),
          lease_token: null, lease_until: 0, updated_at: String(updatedAt),
        });
        changes = 1;
      }
    } else if (statement.sql.includes("api-cache-release")) {
      const [updatedAt, key, token] = statement.values;
      const current = this.rows.get(String(key));
      if (current && current.lease_token === token) {
        current.lease_token = null;
        current.lease_until = 0;
        current.updated_at = String(updatedAt);
        changes = 1;
      }
    } else {
      throw new Error(`Unsupported statement: ${statement.sql}`);
    }
    return { success: true, meta: { changes }, results: [] };
  }
}

const asDatabase = (fake: FakeD1) => fake as unknown as D1Database;

function stored(payload: unknown = { ok: true }): StoredCacheEntry {
  return {
    payloadJson: JSON.stringify(payload),
    fetchedAt: "2026-09-03T00:00:00.000Z",
    expiresAt: 1_000,
    staleUntil: 2_000,
    leaseToken: null,
    leaseUntil: 0,
  };
}

test("reads one cache key and maps the D1 row without exposing snake-case fields", async () => {
  const fake = new FakeD1();
  fake.rows.set("fixtures", {
    cache_key: "fixtures",
    payload_json: JSON.stringify({ matches: [1] }),
    fetched_at: "2026-09-03T00:00:00.000Z",
    expires_at: 1_000,
    stale_until: 2_000,
    lease_token: "owner",
    lease_until: 3_000,
    updated_at: "2026-09-03T00:00:01.000Z",
  });

  assert.deepEqual(await createD1ApiResponseCache(asDatabase(fake)).read("fixtures"), {
    payloadJson: JSON.stringify({ matches: [1] }),
    fetchedAt: "2026-09-03T00:00:00.000Z",
    expiresAt: 1_000,
    staleUntil: 2_000,
    leaseToken: "owner",
    leaseUntil: 3_000,
  });
});

test("only one owner acquires an active lease and an expired lease can be replaced", async () => {
  const store = createD1ApiResponseCache(asDatabase(new FakeD1()));

  assert.equal(await store.acquireLease("fixtures", "owner-a", 1_000, 16_000), true);
  assert.equal(await store.acquireLease("fixtures", "owner-b", 1_001, 16_001), false);
  assert.equal(await store.acquireLease("fixtures", "owner-b", 16_000, 31_000), true);
});

test("a stale owner cannot overwrite a successor while the current owner can save", async () => {
  const fake = new FakeD1();
  const store = createD1ApiResponseCache(asDatabase(fake));
  await store.acquireLease("fixtures", "owner-a", 1_000, 2_000);
  await store.acquireLease("fixtures", "owner-b", 2_000, 17_000);

  assert.equal(await store.writeSuccess("fixtures", "owner-a", stored({ owner: "a" })), false);
  assert.equal(await store.writeSuccess("fixtures", "owner-b", stored({ owner: "b" })), true);
  assert.equal(fake.rows.get("fixtures")?.payload_json, JSON.stringify({ owner: "b" }));
  assert.equal(fake.rows.get("fixtures")?.lease_token, null);
});

test("only the matching owner token releases a lease", async () => {
  const fake = new FakeD1();
  const store = createD1ApiResponseCache(asDatabase(fake));
  await store.acquireLease("fixtures", "owner", 1_000, 16_000);

  await store.releaseLease("fixtures", "stale-owner");
  assert.equal(fake.rows.get("fixtures")?.lease_token, "owner");
  await store.releaseLease("fixtures", "owner");
  assert.equal(fake.rows.get("fixtures")?.lease_token, null);
  assert.equal(fake.rows.get("fixtures")?.lease_until, 0);
});
