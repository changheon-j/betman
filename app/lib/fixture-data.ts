import type { LeagueCode, LeagueConfig } from "./leagues.ts";

export type ApiTeam = { id: number; name: string; logo: string };

export type ApiFixture = {
  fixture: {
    id: number;
    date: string;
    status: { short: string };
    venue: { name: string | null };
  };
  league: { round: string };
  teams: { home: ApiTeam; away: ApiTeam };
  goals: { home: number | null; away: number | null };
};

export type ApiStanding = {
  rank: number;
  team: ApiTeam;
  points: number;
  goalsDiff: number;
  all: {
    played: number;
    win: number;
    draw: number;
    lose: number;
    goals: { for: number; against: number };
  };
};

export type ApiStandingEnvelope = {
  league?: { standings?: ApiStanding[][] };
};

type Result = "W" | "D" | "L";

type RecentMatch = [string, string, "홈" | "원정", Result];

export type Standing = {
  rank: number;
  teamId: number;
  team: string;
  teamCode: string;
  logo: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
  goalDifference: number;
  goalsFor: number;
  goalsAgainst: number;
};

export type Match = {
  id: number;
  leagueId: number;
  leagueCode: LeagueCode;
  leagueName: string;
  kickoffAt: string;
  date: string;
  dateLabel: string;
  dateShort: string;
  round: string;
  time: string;
  venue: string;
  homeTeamId: number;
  awayTeamId: number;
  home: string;
  away: string;
  homeCode: string;
  awayCode: string;
  homeLogo: string;
  awayLogo: string;
  homeRank: number;
  awayRank: number;
  homeForm: Result[];
  awayForm: Result[];
  homeRecord: string;
  awayRecord: string;
  homeGoals: string;
  awayGoals: string;
  homePlayed: number;
  awayPlayed: number;
  homeRecentPoints: number;
  awayRecentPoints: number;
  recentHome: RecentMatch[];
  recentAway: RecentMatch[];
};

type TeamStats = {
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  matches: Array<{
    date: string;
    opponent: string;
    venue: "홈" | "원정";
    goalsFor: number;
    goalsAgainst: number;
    result: Result;
  }>;
};

export type LeaguePayload = {
  matches: Match[];
  standings: Standing[];
};

export type FulfilledLeaguePayload = LeaguePayload & {
  status: "fulfilled";
  league: LeagueConfig;
};

export type RejectedLeaguePayload = {
  status: "rejected";
  league: LeagueConfig;
  reason: unknown;
};

export type FixturePayload = {
  matches: Match[];
  standingsByLeague: Partial<Record<LeagueCode, Standing[]>>;
  leagues: readonly LeagueConfig[];
  leagueErrors: Partial<Record<LeagueCode, string>>;
};

const teamLabels: Record<string, { name: string; code: string }> = {
  "Daegu FC": { name: "대구 FC", code: "대구" },
  "Daejeon Citizen": { name: "대전 하나", code: "대전" },
  "FC Seoul": { name: "FC 서울", code: "서울" },
  "Gangwon FC": { name: "강원 FC", code: "강원" },
  "Gimcheon Sangmu FC": { name: "김천 상무", code: "김천" },
  "Gwangju FC": { name: "광주 FC", code: "광주" },
  "Incheon United": { name: "인천 유나이티드", code: "인천" },
  "Jeju United FC": { name: "제주 SK", code: "제주" },
  "Jeonbuk Motors": { name: "전북 현대", code: "전북" },
  "Pohang Steelers": { name: "포항 스틸러스", code: "포항" },
  "Suwon City FC": { name: "수원 FC", code: "수원" },
  "Ulsan Hyundai FC": { name: "울산 HD", code: "울산" },
  "FC Anyang": { name: "FC 안양", code: "안양" },
  "Bucheon FC 1995": { name: "부천 FC", code: "부천" },
};

const venueLabels: Record<string, string> = {
  "DGB Daegu Bank Park": "DGB대구은행파크",
  "Daejeon World Cup Stadium": "대전월드컵경기장",
  "Gangneung Stadium": "강릉종합운동장",
  "Gimcheon Stadium": "김천종합운동장",
  "Jeju World Cup Stadium": "제주월드컵경기장",
  "Jeonju World Cup Stadium": "전주월드컵경기장",
  "Seoul World Cup Stadium": "서울월드컵경기장",
  "Steelyard Stadium": "포항스틸야드",
  "Suwon Sports Complex": "수원종합운동장",
  "Ulsan Munsu Football Stadium": "울산문수축구경기장",
  "Anyang Stadium": "안양종합운동장",
  "Bucheon Stadium": "부천종합운동장",
  "Gwangju Football Stadium": "광주축구전용구장",
  "Incheon Football Stadium": "인천축구전용경기장",
};

function isCompletedFixture(item: ApiFixture) {
  return ["FT", "AET", "PEN"].includes(item.fixture.status.short)
    && item.goals.home !== null && item.goals.away !== null;
}

function resultFor(goalsFor: number, goalsAgainst: number): Result {
  return goalsFor > goalsAgainst ? "W" : goalsFor < goalsAgainst ? "L" : "D";
}

function labelTeam(team: ApiTeam) {
  return teamLabels[team.name] ?? { name: team.name, code: team.name };
}

function getStats(stats: Map<number, TeamStats>, teamId: number) {
  const existing = stats.get(teamId);
  if (existing) return existing;
  const created: TeamStats = { played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, matches: [] };
  stats.set(teamId, created);
  return created;
}

function addResult(stats: TeamStats, goalsFor: number, goalsAgainst: number) {
  stats.played += 1;
  stats.goalsFor += goalsFor;
  stats.goalsAgainst += goalsAgainst;
  if (goalsFor > goalsAgainst) stats.won += 1;
  else if (goalsFor < goalsAgainst) stats.lost += 1;
  else stats.drawn += 1;
}

function toStanding(row: ApiStanding): Standing {
  const team = labelTeam(row.team);
  return {
    rank: row.rank,
    teamId: row.team.id,
    team: team.name,
    teamCode: team.code,
    logo: row.team.logo,
    played: row.all.played,
    won: row.all.win,
    drawn: row.all.draw,
    lost: row.all.lose,
    points: row.points,
    goalDifference: row.goalsDiff,
    goalsFor: row.all.goals.for,
    goalsAgainst: row.all.goals.against,
  };
}

export function extractOfficialStandings(responses: ApiStandingEnvelope[]) {
  return responses.flatMap((response) => response.league?.standings?.flat() ?? []);
}

export function buildLeaguePayload(
  league: LeagueConfig,
  upcoming: ApiFixture[],
  past: ApiFixture[],
  officialStandings: ApiStanding[],
): LeaguePayload {
  const stats = new Map<number, TeamStats>();
  const completed = past.filter(isCompletedFixture).sort((a, b) => a.fixture.date.localeCompare(b.fixture.date));

  for (const item of completed) {
    const homeGoals = item.goals.home as number;
    const awayGoals = item.goals.away as number;
    const homeStats = getStats(stats, item.teams.home.id);
    const awayStats = getStats(stats, item.teams.away.id);
    addResult(homeStats, homeGoals, awayGoals);
    addResult(awayStats, awayGoals, homeGoals);
    homeStats.matches.push({ date: item.fixture.date, opponent: labelTeam(item.teams.away).name, venue: "홈", goalsFor: homeGoals, goalsAgainst: awayGoals, result: resultFor(homeGoals, awayGoals) });
    awayStats.matches.push({ date: item.fixture.date, opponent: labelTeam(item.teams.home).name, venue: "원정", goalsFor: awayGoals, goalsAgainst: homeGoals, result: resultFor(awayGoals, homeGoals) });
  }

  const standings = officialStandings.map(toStanding);
  const rankByTeam = new Map(standings.map((standing) => [standing.teamId, standing.rank]));
  const matches = upcoming
    .sort((a, b) => a.fixture.date.localeCompare(b.fixture.date))
    .map((item) => {
      const date = new Date(item.fixture.date);
      const home = labelTeam(item.teams.home);
      const away = labelTeam(item.teams.away);
      const homeStats = getStats(stats, item.teams.home.id);
      const awayStats = getStats(stats, item.teams.away.id);
      const recent = (teamStats: TeamStats): RecentMatch[] => teamStats.matches.slice(-5).reverse().map((match) => [
        match.opponent,
        `${match.goalsFor}–${match.goalsAgainst}`,
        match.venue,
        match.result,
      ]);
      return {
        id: item.fixture.id,
        leagueId: league.id,
        leagueCode: league.code,
        leagueName: league.name,
        kickoffAt: item.fixture.date,
        date: item.fixture.date.slice(0, 10),
        dateLabel: new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "long" }).format(date),
        dateShort: new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", weekday: "short" }).format(date),
        round: `${item.league.round.match(/(\d+)$/)?.[1] ?? item.league.round}R`,
        time: item.fixture.date.slice(11, 16),
        venue: venueLabels[item.fixture.venue.name ?? ""] ?? item.fixture.venue.name ?? "경기장 미정",
        homeTeamId: item.teams.home.id,
        awayTeamId: item.teams.away.id,
        home: home.name,
        away: away.name,
        homeCode: home.code,
        awayCode: away.code,
        homeLogo: item.teams.home.logo,
        awayLogo: item.teams.away.logo,
        homeRank: rankByTeam.get(item.teams.home.id) ?? 0,
        awayRank: rankByTeam.get(item.teams.away.id) ?? 0,
        homeForm: homeStats.matches.slice(-5).map((match) => match.result),
        awayForm: awayStats.matches.slice(-5).map((match) => match.result),
        homeRecord: `${homeStats.won}승 ${homeStats.drawn}무 ${homeStats.lost}패`,
        awayRecord: `${awayStats.won}승 ${awayStats.drawn}무 ${awayStats.lost}패`,
        homeGoals: `${homeStats.goalsFor} / ${homeStats.goalsAgainst}`,
        awayGoals: `${awayStats.goalsFor} / ${awayStats.goalsAgainst}`,
        homePlayed: homeStats.played,
        awayPlayed: awayStats.played,
        homeRecentPoints: homeStats.matches.slice(-5).reduce((sum, match) => sum + (match.result === "W" ? 3 : match.result === "D" ? 1 : 0), 0),
        awayRecentPoints: awayStats.matches.slice(-5).reduce((sum, match) => sum + (match.result === "W" ? 3 : match.result === "D" ? 1 : 0), 0),
        recentHome: recent(homeStats),
        recentAway: recent(awayStats),
      };
    });

  return { matches, standings };
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : "리그 데이터를 불러오지 못했습니다.";
}

export function mergeLeaguePayloads(results: Array<FulfilledLeaguePayload | RejectedLeaguePayload>): FixturePayload {
  const standingsByLeague: FixturePayload["standingsByLeague"] = {};
  const leagueErrors: FixturePayload["leagueErrors"] = {};
  const matches: Match[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      matches.push(...result.matches);
      standingsByLeague[result.league.code] = result.standings;
    } else {
      leagueErrors[result.league.code] = errorMessage(result.reason);
    }
  }

  return {
    matches: matches.sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt)),
    standingsByLeague,
    leagues: results.map((result) => result.league),
    leagueErrors,
  };
}
