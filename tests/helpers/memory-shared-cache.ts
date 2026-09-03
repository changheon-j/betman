import type { SharedCacheStore, StoredCacheEntry } from "../../app/lib/shared-api-cache.ts";

export class MemorySharedCache implements SharedCacheStore {
  entries = new Map<string, StoredCacheEntry>();
  writes = 0;

  async read(key: string) {
    return this.entries.get(key) ?? null;
  }

  async acquireLease(key: string, token: string, now: number, leaseUntil: number) {
    const current = this.entries.get(key);
    if (current && current.leaseUntil > now) return false;
    this.entries.set(key, current
      ? { ...current, leaseToken: token, leaseUntil }
      : { payloadJson: null, fetchedAt: null, expiresAt: 0, staleUntil: 0, leaseToken: token, leaseUntil });
    return true;
  }

  async writeSuccess(key: string, token: string, entry: StoredCacheEntry) {
    if (this.entries.get(key)?.leaseToken !== token) return false;
    this.entries.set(key, entry);
    this.writes += 1;
    return true;
  }

  async releaseLease(key: string, token: string) {
    const current = this.entries.get(key);
    if (current?.leaseToken === token) this.entries.set(key, { ...current, leaseToken: null, leaseUntil: 0 });
  }
}

export function cachedEntry(value: unknown, expiresAt: number, staleUntil: number): StoredCacheEntry {
  return {
    payloadJson: JSON.stringify(value),
    fetchedAt: "2026-09-03T00:00:00.000Z",
    expiresAt,
    staleUntil,
    leaseToken: null,
    leaseUntil: 0,
  };
}

