export async function replaceCacheAfterPersist<T>(
  candidate: T,
  persist: () => Promise<unknown>,
) {
  await persist();
  return candidate;
}
