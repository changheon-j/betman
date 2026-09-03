export type PreMatchOddsPayload = {
  fixtureId: number;
  bookmakers: Array<{
    id: number;
    name: string;
    markets: Array<{
      id: number;
      name: string;
      values: Array<{ label: string; odds: number }>;
    }>;
  }>;
};

export type MatchWinnerOdds = { home: number; draw: number; away: number };

function normalizeOddsLabel(value: string) {
  return value.normalize("NFC").toLocaleLowerCase("en").replace(/\s+/g, "");
}

export function matchWinnerOdds(
  bookmaker: PreMatchOddsPayload["bookmakers"][number] | null | undefined,
): MatchWinnerOdds | null {
  const market = bookmaker?.markets.find((item) => normalizeOddsLabel(item.name) === "matchwinner");
  if (!market) return null;
  const byLabel = new Map(market.values.map((value) => [normalizeOddsLabel(value.label), value.odds]));
  const home = byLabel.get("home");
  const draw = byLabel.get("draw");
  const away = byLabel.get("away");
  return home === undefined || draw === undefined || away === undefined ? null : { home, draw, away };
}

export function preMatchOddsForFixture<T extends { fixtureId: number }>(
  selectedFixtureId: number | null | undefined,
  payload: T | null,
): T | null {
  return payload && payload.fixtureId === selectedFixtureId ? payload : null;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isValidId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseOdd(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const odds = Number(value);
  return Number.isFinite(odds) && odds > 0 ? odds : null;
}

function normalizeMarkets(bets: unknown) {
  if (!Array.isArray(bets)) return [];

  const seenMarketIds = new Set<number>();
  const markets: PreMatchOddsPayload["bookmakers"][number]["markets"] = [];
  for (const bet of bets) {
    if (!isRecord(bet) || !isValidId(bet.id) || !isNonEmptyString(bet.name) || !Array.isArray(bet.values)) continue;

    const values = bet.values.flatMap((value) => {
      if (!isRecord(value) || !isNonEmptyString(value.value)) return [];
      const odds = parseOdd(value.odd);
      return odds === null ? [] : [{ label: value.value, odds }];
    });
    if (values.length === 0 || seenMarketIds.has(bet.id)) continue;

    seenMarketIds.add(bet.id);
    markets.push({ id: bet.id, name: bet.name, values });
  }
  return markets;
}

export function parseFixtureId(value: string | null): number {
  if (value === null || !/^[1-9]\d*$/.test(value)) throw new Error("fixture must be a positive integer");
  const fixtureId = Number(value);
  if (!Number.isSafeInteger(fixtureId)) throw new Error("fixture must be a positive safe integer");
  return fixtureId;
}

export function normalizePreMatchOdds(fixtureId: number, response: unknown[]): PreMatchOddsPayload {
  const seenBookmakerIds = new Set<number>();
  const bookmakers: PreMatchOddsPayload["bookmakers"] = [];

  for (const item of response) {
    if (!isRecord(item) || !Array.isArray(item.bookmakers)) continue;
    for (const bookmaker of item.bookmakers) {
      if (!isRecord(bookmaker) || !isValidId(bookmaker.id) || !isNonEmptyString(bookmaker.name)) continue;
      const markets = normalizeMarkets(bookmaker.bets);
      if (markets.length === 0 || seenBookmakerIds.has(bookmaker.id)) continue;

      seenBookmakerIds.add(bookmaker.id);
      bookmakers.push({ id: bookmaker.id, name: bookmaker.name, markets });
    }
  }

  return { fixtureId, bookmakers };
}
