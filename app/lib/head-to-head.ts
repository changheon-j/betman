import type { ApiFixture } from "./fixture-data.ts";

export type HeadToHeadMatch = [string, boolean, string, "W" | "D" | "L"];

export type HeadToHeadQuery = {
  fixtureId: number;
  homeTeamId: number;
  awayTeamId: number;
  kickoffAt: string;
};

export type HeadToHeadPayload = {
  fixtureId: number;
  fetchedAt?: string;
  cacheSeconds?: number;
  matches: HeadToHeadMatch[];
};

export function headToHeadWinnerClasses(
  selectedHomeWasHome: boolean,
  result: HeadToHeadMatch[3],
): [string, string] {
  if (result === "D") return ["", ""];
  const leftTeamWon = result === "W" ? selectedHomeWasHome : !selectedHomeWasHome;
  return leftTeamWon ? ["winning-team", ""] : ["", "winning-team"];
}

type ApiFootballResponse = {
  errors?: Record<string, unknown> | unknown[];
  response?: ApiFixture[];
};

const API_URL = "https://v3.football.api-sports.io/fixtures/headtohead";
const ISO_DATE_TIME_WITH_TIMEZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function parsePositiveId(value: string | null, name: string): number {
  if (value === null || !/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new Error(`${name} must be a positive safe integer`);
  return id;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidIsoDateTime(value: string): boolean {
  const parts = ISO_DATE_TIME_WITH_TIMEZONE.exec(value);
  if (!parts) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth[month - 1]
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59;
}

function hasProviderErrors(errors: ApiFootballResponse["errors"]): boolean {
  return Array.isArray(errors) ? errors.length > 0 : Boolean(errors && Object.keys(errors).length > 0);
}

function isRateLimited(errors: ApiFootballResponse["errors"]): boolean {
  return typeof errors === "object" && errors !== null && !Array.isArray(errors) && Object.hasOwn(errors, "rateLimit");
}

export class HeadToHeadProviderError extends Error {
  constructor(public readonly status: 429 | 502, message: string) {
    super(message);
    this.name = "HeadToHeadProviderError";
  }
}

export function parseHeadToHeadQuery(searchParams: URLSearchParams): HeadToHeadQuery {
  const fixtureId = parsePositiveId(searchParams.get("fixture"), "fixture");
  const homeTeamId = parsePositiveId(searchParams.get("home"), "home");
  const awayTeamId = parsePositiveId(searchParams.get("away"), "away");
  if (homeTeamId === awayTeamId) throw new Error("home and away teams must be different");

  const kickoffAt = searchParams.get("kickoff");
  if (kickoffAt === null || !isValidIsoDateTime(kickoffAt) || Number.isNaN(Date.parse(kickoffAt))) {
    throw new Error("kickoff must be an ISO 8601 date-time with a timezone");
  }

  return { fixtureId, homeTeamId, awayTeamId, kickoffAt };
}

export function buildHeadToHeadMatches(fixtures: ApiFixture[], query: HeadToHeadQuery): HeadToHeadMatch[] {
  const kickoffMs = Date.parse(query.kickoffAt);

  return fixtures
    .filter((fixture) => ["FT", "AET", "PEN"].includes(fixture.fixture.status.short))
    .filter((fixture) => fixture.goals.home !== null && fixture.goals.away !== null)
    .filter((fixture) => Date.parse(fixture.fixture.date) < kickoffMs)
    .filter((fixture) => (
      (fixture.teams.home.id === query.homeTeamId && fixture.teams.away.id === query.awayTeamId)
      || (fixture.teams.home.id === query.awayTeamId && fixture.teams.away.id === query.homeTeamId)
    ))
    .sort((left, right) => Date.parse(right.fixture.date) - Date.parse(left.fixture.date))
    .slice(0, 10)
    .map((fixture) => {
      const selectedHomeWasHome = fixture.teams.home.id === query.homeTeamId;
      const selectedGoals = selectedHomeWasHome ? fixture.goals.home as number : fixture.goals.away as number;
      const opponentGoals = selectedHomeWasHome ? fixture.goals.away as number : fixture.goals.home as number;
      const result = selectedGoals > opponentGoals ? "W" : selectedGoals < opponentGoals ? "L" : "D";
      return [
        fixture.fixture.date.slice(0, 10).replaceAll("-", "."),
        selectedHomeWasHome,
        `${fixture.goals.home}–${fixture.goals.away}`,
        result,
      ];
    });
}

export async function requestHeadToHead(
  query: HeadToHeadQuery,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<HeadToHeadMatch[]> {
  let response: Response;
  let body: ApiFootballResponse;

  try {
    const params = new URLSearchParams({
      h2h: `${query.homeTeamId}-${query.awayTeamId}`,
      last: "20",
      timezone: "Asia/Seoul",
    });
    response = await fetcher(`${API_URL}?${params.toString()}`, { headers: { "x-apisports-key": apiKey } });
    body = await response.json() as ApiFootballResponse;
  } catch {
    throw new HeadToHeadProviderError(502, "API-Football head-to-head request failed");
  }

  if (isRateLimited(body.errors)) {
    throw new HeadToHeadProviderError(429, "API-Football head-to-head rate limit exceeded");
  }
  if (!response.ok || hasProviderErrors(body.errors) || !Array.isArray(body.response)) {
    throw new HeadToHeadProviderError(502, "API-Football head-to-head request failed");
  }

  return buildHeadToHeadMatches(body.response, query);
}

export function headToHeadForFixture(
  selectedId: number | undefined,
  payload: HeadToHeadPayload | null,
): HeadToHeadMatch[] | null {
  return selectedId !== undefined && payload?.fixtureId === selectedId ? payload.matches : null;
}

export function headToHeadErrorForFixture(
  selectedId: number | undefined,
  error: { fixtureId: number; message: string } | null,
): string {
  return selectedId !== undefined && error?.fixtureId === selectedId ? error.message : "";
}

export function headToHeadLoadingForFixture(
  selectedId: number | undefined,
  payload: HeadToHeadPayload | null,
  error: { fixtureId: number; message: string } | null,
): boolean {
  return selectedId !== undefined
    && payload?.fixtureId !== selectedId
    && error?.fixtureId !== selectedId;
}
