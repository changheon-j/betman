export type LeagueCode = "K1" | "J1";

export type LeagueConfig = {
  id: number;
  code: LeagueCode;
  name: string;
  apiName: string;
  seasonYear: "calendar" | "ending";
  seasonStartMonth: number;
};

export const SUPPORTED_LEAGUES = [
  { id: 292, code: "K1", name: "K리그1", apiName: "K League 1", seasonYear: "calendar", seasonStartMonth: 1 },
  { id: 98, code: "J1", name: "J리그1", apiName: "J1 League", seasonYear: "ending", seasonStartMonth: 7 },
] as const satisfies readonly LeagueConfig[];

export function resolveLeagueSeason(league: LeagueConfig, date: string) {
  const [calendarYear, month] = date.split("-").map(Number);
  const season = league.seasonYear === "ending" && month >= league.seasonStartMonth
    ? calendarYear + 1
    : calendarYear;
  const seasonStartYear = league.seasonYear === "ending" ? season - 1 : season;

  return {
    season,
    seasonStart: `${seasonStartYear}-${String(league.seasonStartMonth).padStart(2, "0")}-01`,
  };
}
