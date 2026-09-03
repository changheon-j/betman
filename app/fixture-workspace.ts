export function selectedFixture<T extends { id: number }>(matches: readonly T[], selectedId: number): T | null {
  return matches.find((match) => match.id === selectedId) ?? null;
}

export function reconcileSelectedFixtureId<T extends { id: number }>(matches: readonly T[], selectedId: number) {
  return selectedFixture(matches, selectedId)?.id ?? 0;
}

export function predictionForFixture<T>(
  selectedFixtureId: number | null | undefined,
  prediction: { fixtureId: number; data: T | null } | null,
): T | null {
  return prediction && prediction.fixtureId === selectedFixtureId ? prediction.data : null;
}

export function predictionErrorForFixture(
  selectedFixtureId: number | null | undefined,
  error: { fixtureId: number; message: string } | null,
) {
  return error && error.fixtureId === selectedFixtureId ? error.message : "";
}

type FixtureDetailPanel = {
  focus(options: { preventScroll: boolean }): void;
  scrollIntoView(options: { block: "start"; behavior: "auto" | "smooth" }): void;
};

export function focusFixtureDetail(
  panel: FixtureDetailPanel,
  options: { isSmallViewport: boolean; prefersReducedMotion: boolean },
) {
  panel.focus({ preventScroll: true });
  if (!options.isSmallViewport) return;

  panel.scrollIntoView({
    block: "start",
    behavior: options.prefersReducedMotion ? "auto" : "smooth",
  });
}
