import type { HistoryTeamOption, TeamIdentity } from "./betman-history-types.ts";
import type { LeagueCode } from "./leagues.ts";

export type TeamAliases = readonly [id: number, aliases: readonly string[]];
export type TeamDefinition = { id: number; name: string; aliases: readonly string[] };
type AliasEntry = TeamAliases | TeamDefinition;

function normalizeAlias(value: string) {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("en")
    .replace(/[\s\p{P}]/gu, "")
    .replace(/^fc/u, "")
    .replace(/fc$/u, "");
}

export function buildAliasIndex(entries: readonly AliasEntry[]) {
  const index = new Map<string, number>();
  for (const entry of entries) {
    const [teamId, aliases] = isTeamAliases(entry) ? entry : [entry.id, entry.aliases];
    for (const alias of aliases) {
      const normalized = normalizeAlias(alias);
      const existingTeamId = index.get(normalized);
      if (existingTeamId !== undefined && existingTeamId !== teamId) {
        throw new Error(`Alias collision for "${normalized}" between team IDs ${existingTeamId} and ${teamId}.`);
      }
      index.set(normalized, teamId);
    }
  }
  return index;
}

function isTeamAliases(entry: AliasEntry): entry is TeamAliases {
  return Array.isArray(entry);
}

export const TEAMS_BY_LEAGUE: Record<LeagueCode, readonly TeamDefinition[]> = {
  K1: [
    { id: 2759, name: "광주 FC", aliases: ["광주", "광주 FC", "광주FC", "Gwangju FC"] },
    { id: 2764, name: "포항 스틸러스", aliases: ["포항", "포항 스틸러스", "포항스틸러스", "Pohang Steelers"] },
    { id: 2761, name: "제주 SK", aliases: ["제주", "제주 SK", "제주 SKFC", "제주SKFC", "제주 유나이티드", "Jeju United FC"] },
    { id: 2766, name: "FC 서울", aliases: ["서울", "FC 서울", "FC서울", "서울 FC", "FC Seoul"] },
    { id: 2750, name: "대전 하나", aliases: ["대전", "대전 하나", "대전 하나시티즌", "대전하나시티즌", "Daejeon Citizen"] },
    { id: 2762, name: "전북 현대", aliases: ["전북", "전북 현대", "전북 현대모터스", "전북현대모터스", "Jeonbuk Motors"] },
    { id: 2767, name: "울산 HD", aliases: ["울산", "울산 HD", "울산 HDFC", "울산HDFC", "Ulsan Hyundai FC"] },
    { id: 2746, name: "강원 FC", aliases: ["강원", "강원 FC", "강원FC", "Gangwon FC"] },
    { id: 2748, name: "FC 안양", aliases: ["안양", "FC 안양", "FC안양", "안양 FC", "FC Anyang"] },
    { id: 2745, name: "부천 FC", aliases: ["부천", "부천 FC", "부천FC 1995", "부천FC1995", "Bucheon FC 1995"] },
    { id: 2763, name: "인천 유나이티드", aliases: ["인천", "인천 유나이티드", "인천유나이티드", "Incheon United"] },
    { id: 2768, name: "김천 상무", aliases: ["김천", "김천 상무", "김천상무 프로축구단", "김천상무프로축구단", "Gimcheon Sangmu FC"] },
    { id: 2747, name: "대구 FC", aliases: ["대구", "대구 FC", "Daegu FC"] },
    { id: 2756, name: "수원 FC", aliases: ["수원", "수원 FC", "Suwon City FC"] },
    { id: 2765, name: "수원 삼성", aliases: ["수원 삼성", "Suwon Bluewings"] },
  ],
  J1: [
    { id: 316, name: "아비스파 후쿠오카", aliases: ["아비스파 후쿠오카", "Avispa Fukuoka"] },
    { id: 291, name: "세레소 오사카", aliases: ["세레소 오사카", "Cerezo Osaka"] },
    { id: 310, name: "파지아노 오카야마", aliases: ["파지아노 오카야마", "Fagiano Okayama"] },
    { id: 292, name: "FC 도쿄", aliases: ["FC 도쿄", "FC도쿄", "FC Tokyo"] },
    { id: 293, name: "감바 오사카", aliases: ["감바 오사카", "Gamba Osaka"] },
    { id: 301, name: "제프 유나이티드 지바", aliases: ["제프 유나이티드 지바", "제프 유나이티드", "제프 지바", "JEF United Chiba"] },
    { id: 290, name: "가시마 앤틀러스", aliases: ["가시마 앤틀러스", "가시마", "Kashima"] },
    { id: 281, name: "가시와 레이솔", aliases: ["가시와 레이솔", "Kashiwa Reysol"] },
    { id: 294, name: "가와사키 프론탈레", aliases: ["가와사키 프론탈레", "Kawasaki Frontale"] },
    { id: 302, name: "교토 상가", aliases: ["교토 상가", "Kyoto Sanga"] },
    { id: 303, name: "마치다 젤비아", aliases: ["마치다 젤비아", "Machida Zelvia"] },
    { id: 305, name: "미토 홀리호크", aliases: ["미토 홀리호크", "Mito Hollyhock"] },
    { id: 288, name: "나고야 그램퍼스", aliases: ["나고야 그램퍼스", "Nagoya Grampus"] },
    { id: 282, name: "산프레체 히로시마", aliases: ["산프레체 히로시마", "Sanfrecce Hiroshima"] },
    { id: 283, name: "시미즈 에스펄스", aliases: ["시미즈 에스펄스", "Shimizu S-pulse"] },
    { id: 306, name: "도쿄 베르디", aliases: ["도쿄 베르디", "Tokyo Verdy"] },
    { id: 287, name: "우라와 레즈", aliases: ["우라와 레즈", "우라와", "Urawa"] },
    { id: 289, name: "비셀 고베", aliases: ["비셀 고베", "Vissel Kobe"] },
    { id: 285, name: "V-바렌 나가사키", aliases: ["V-바렌 나가사키", "V바렌 나가사키", "V-varen Nagasaki"] },
    { id: 296, name: "요코하마 F. 마리노스", aliases: ["요코하마 F. 마리노스", "요코하마 F마리노스", "Yokohama F. Marinos"] },
  ],
};

const teamIdsByAlias: Record<LeagueCode, ReadonlyMap<string, number>> = {
  K1: buildAliasIndex(TEAMS_BY_LEAGUE.K1),
  J1: buildAliasIndex(TEAMS_BY_LEAGUE.J1),
};

export function teamIdForAlias(league: LeagueCode, value: string): number | null {
  return teamIdsByAlias[league].get(normalizeAlias(value)) ?? null;
}

export function teamIdentityForAlias(league: LeagueCode, raw: string): TeamIdentity | null {
  const id = teamIdForAlias(league, raw);
  const team = id === null ? undefined : TEAMS_BY_LEAGUE[league].find((candidate) => candidate.id === id);
  return team ? { key: `${league}:${team.id}`, leagueCode: league, id: team.id, name: team.name } : null;
}

export function teamsForLeague(league: "all" | LeagueCode): HistoryTeamOption[] {
  const leagues = league === "all" ? (["K1", "J1"] as const) : [league];
  return leagues
    .flatMap((code) => TEAMS_BY_LEAGUE[code].map((team) => ({ key: `${code}:${team.id}` as const, leagueCode: code, id: team.id, name: team.name })))
    .sort((a, b) => a.leagueCode.localeCompare(b.leagueCode) || a.name.localeCompare(b.name, "ko"));
}
