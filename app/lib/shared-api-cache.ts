export type StoredCacheEntry = {
  payloadJson: string | null;
  fetchedAt: string | null;
  expiresAt: number;
  staleUntil: number;
  leaseToken: string | null;
  leaseUntil: number;
};

export interface SharedCacheStore {
  read(key: string): Promise<StoredCacheEntry | null>;
  acquireLease(key: string, token: string, now: number, leaseUntil: number): Promise<boolean>;
  writeSuccess(key: string, token: string, entry: StoredCacheEntry): Promise<boolean>;
  releaseLease(key: string, token: string): Promise<void>;
}

export type SharedCacheResult<T> = {
  value: T;
  cacheStatus: "fresh" | "refreshed" | "stale" | "uncached";
};

export class SharedCacheBusyError extends Error {
  readonly status = 503;

  constructor() {
    super("Shared cache refresh is already in progress");
    this.name = "SharedCacheBusyError";
  }
}

type SharedCacheOptions<T> = {
  key: string;
  ttlMs: number;
  staleTtlMs: number;
  store: SharedCacheStore;
  load: () => Promise<T>;
  canStore?: (value: T) => boolean;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  token?: () => string;
  inFlight?: Map<string, Promise<SharedCacheResult<unknown>>>;
};

const LEASE_MS = 15_000;
const FOLLOWER_WAIT_MS = 100;
const FOLLOWER_TIMEOUT_MS = 3_000;

export const defaultSharedInFlight = new Map<string, Promise<SharedCacheResult<unknown>>>();

function parseValue<T>(entry: StoredCacheEntry | null): T | null {
  if (!entry?.payloadJson || !entry.fetchedAt) return null;
  try {
    return JSON.parse(entry.payloadJson) as T;
  } catch {
    return null;
  }
}

function freshValue<T>(entry: StoredCacheEntry | null, now: number): T | null {
  return entry && entry.expiresAt > now ? parseValue<T>(entry) : null;
}

function staleValue<T>(entry: StoredCacheEntry | null, now: number): T | null {
  return entry && entry.staleUntil > now ? parseValue<T>(entry) : null;
}

async function refreshAsOwner<T>(
  options: SharedCacheOptions<T>,
  ownerToken: string,
  priorEntry: StoredCacheEntry | null,
  now: () => number,
): Promise<SharedCacheResult<T>> {
  try {
    const value = await options.load();
    if (options.canStore && !options.canStore(value)) {
      await options.store.releaseLease(options.key, ownerToken);
      const stale = staleValue<T>(priorEntry, now());
      return stale === null
        ? { value, cacheStatus: "uncached" }
        : { value: stale, cacheStatus: "stale" };
    }

    const requestedAt = now();
    await options.store.writeSuccess(options.key, ownerToken, {
      payloadJson: JSON.stringify(value),
      fetchedAt: new Date(requestedAt).toISOString(),
      expiresAt: requestedAt + options.ttlMs,
      staleUntil: requestedAt + options.staleTtlMs,
      leaseToken: null,
      leaseUntil: 0,
    });
    return { value, cacheStatus: "refreshed" };
  } catch (error) {
    await options.store.releaseLease(options.key, ownerToken);
    const stale = staleValue<T>(priorEntry, now());
    if (stale !== null) return { value: stale, cacheStatus: "stale" };
    throw error;
  }
}

async function coordinateRefresh<T>(options: SharedCacheOptions<T>): Promise<SharedCacheResult<T>> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const makeToken = options.token ?? (() => globalThis.crypto.randomUUID());
  const initial = await options.store.read(options.key);
  const fresh = freshValue<T>(initial, now());
  if (fresh !== null) return { value: fresh, cacheStatus: "fresh" };

  const ownerToken = makeToken();
  if (await options.store.acquireLease(options.key, ownerToken, now(), now() + LEASE_MS)) {
    return refreshAsOwner(options, ownerToken, initial, now);
  }

  const stale = staleValue<T>(initial, now());
  if (stale !== null) return { value: stale, cacheStatus: "stale" };

  for (let elapsed = 0; elapsed < FOLLOWER_TIMEOUT_MS; elapsed += FOLLOWER_WAIT_MS) {
    await wait(FOLLOWER_WAIT_MS);
    const current = await options.store.read(options.key);
    const shared = freshValue<T>(current, now());
    if (shared !== null) return { value: shared, cacheStatus: "fresh" };
  }

  const retryAt = now();
  const retryToken = makeToken();
  const latest = await options.store.read(options.key);
  if (await options.store.acquireLease(options.key, retryToken, retryAt, retryAt + LEASE_MS)) {
    return refreshAsOwner(options, retryToken, latest, now);
  }
  throw new SharedCacheBusyError();
}

export async function getOrRefreshShared<T>(options: SharedCacheOptions<T>): Promise<SharedCacheResult<T>> {
  const now = options.now ?? Date.now;
  const initial = await options.store.read(options.key);
  const fresh = freshValue<T>(initial, now());
  if (fresh !== null) return { value: fresh, cacheStatus: "fresh" };

  const inFlight = options.inFlight ?? defaultSharedInFlight;
  const existing = inFlight.get(options.key);
  if (existing) return existing as Promise<SharedCacheResult<T>>;

  const pending = coordinateRefresh(options);
  inFlight.set(options.key, pending as Promise<SharedCacheResult<unknown>>);
  try {
    return await pending;
  } finally {
    if (inFlight.get(options.key) === pending) inFlight.delete(options.key);
  }
}

