type BetmanRow = Record<string, unknown>;

export type BetmanOption = {
  label: string;
  odds: string;
};

export type BetmanMarket = {
  matchSeq: string;
  type: string;
  condition: string;
  options: BetmanOption[];
};

export type BetmanFixture = {
  key: string;
  date: string;
  kickoffAt: string;
  leagueName: string;
  homeTeam: string;
  awayTeam: string;
  homeKey: string;
  awayKey: string;
  markets: BetmanMarket[];
};

function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function canonicalTeam(value: string) {
  const compact = value.toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
  if (compact.includes("서울이랜드") || compact.includes("수원삼성")) return compact;
  const aliases: Array<[RegExp, string]> = [
    [/광주/, "광주"], [/포항/, "포항"], [/제주/, "제주"], [/fc서울|서울fc/, "서울"],
    [/대전/, "대전"], [/전북/, "전북"], [/울산/, "울산"], [/강원/, "강원"],
    [/안양/, "안양"], [/부천/, "부천"], [/인천/, "인천"], [/김천/, "김천"],
    [/대구/, "대구"], [/수원/, "수원"],
  ];
  return aliases.find(([pattern]) => pattern.test(compact))?.[1] ?? compact;
}

function formatKoreanDate(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = `${values.year}-${values.month}-${values.day}`;
  return { date, kickoffAt: `${date}T${values.hour}:${values.minute}:00+09:00` };
}

function parseDate(value: unknown) {
  const raw = text(value);
  if (!raw) return { date: "", kickoffAt: "" };
  if (/^\d{13}$/.test(raw)) return formatKoreanDate(new Date(Number(raw)));
  if (/^\d{10}$/.test(raw)) return formatKoreanDate(new Date(Number(raw) * 1000));
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 8) {
    const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    const time = digits.length >= 12 ? `${digits.slice(8, 10)}:${digits.slice(10, 12)}` : "";
    return { date, kickoffAt: time ? `${date}T${time}:00+09:00` : `${date}T00:00:00+09:00` };
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? { date: "", kickoffAt: "" } : formatKoreanDate(parsed);
}

function expandRows(compSchedules: { keys: unknown[]; datas: unknown[] }) {
  const keys = compSchedules.keys.map(text);
  return compSchedules.datas.map((data) => {
    if (!Array.isArray(data)) return data as BetmanRow;
    return Object.fromEntries(keys.map((key, index) => [key, data[index]]));
  }).filter((row): row is BetmanRow => Boolean(row) && typeof row === "object" && !Array.isArray(row));
}

function marketCondition(row: BetmanRow) {
  const subject = text(row.gameSubject);
  if (subject && subject !== "-") return subject;
  const type = text(row.gameName || row.betNm || row.betTypNm);
  const condition = text(row.winHandi);
  if (type.includes("언더오버") && condition) return `U/O ${condition}`;
  if (type.includes("핸디캡") && condition) return `H ${Number(condition) > 0 ? "+" : ""}${condition}`;
  if (type.includes("SUM")) return "총 득점";
  return "";
}

export function parseBetmanPayload(value: unknown): BetmanFixture[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Betman 응답 구조가 올바르지 않습니다.");
  }
  const compSchedules = (value as Record<string, unknown>).compSchedules;
  if (!compSchedules || typeof compSchedules !== "object" || Array.isArray(compSchedules)) {
    throw new Error("Betman 응답 구조가 올바르지 않습니다.");
  }
  const schedule = compSchedules as Record<string, unknown>;
  if (!Array.isArray(schedule.keys) || !Array.isArray(schedule.datas)) {
    throw new Error("Betman 응답 구조가 올바르지 않습니다.");
  }

  const grouped = new Map<string, BetmanFixture>();
  for (const row of expandRows({ keys: schedule.keys, datas: schedule.datas })) {
    const gameName = text(row.gameName || row.betNm || row.betTypNm);
    const isFootball = text(row.itemCode) === "SC" || text(row.matchSportId) === "SC" || text(row.itemName).includes("축구") || gameName.includes("축구");
    if (!isFootball) continue;
    const homeTeam = text(row.homeName);
    const awayTeam = text(row.awayName);
    if (!homeTeam || !awayTeam) continue;
    const { date, kickoffAt } = parseDate(row.gameDate);
    const leagueName = text(row.leagueName || row.leagueShortName);
    const homeKey = canonicalTeam(homeTeam);
    const awayKey = canonicalTeam(awayTeam);
    const fixtureKey = `${date}|${homeKey}|${awayKey}`;
    const options = [
      { label: text(row.winTxt), odds: text(row.winAllot) },
      { label: text(row.drawTxt), odds: text(row.drawAllot) },
      { label: text(row.loseTxt), odds: text(row.loseAllot) },
    ].filter((option) => option.label && Number(option.odds) > 0);
    if (!gameName || options.length < 2) continue;
    const fixture = grouped.get(fixtureKey) ?? {
      key: fixtureKey, date, kickoffAt, leagueName,
      homeTeam, awayTeam, homeKey, awayKey, markets: [],
    };
    fixture.markets.push({ matchSeq: text(row.matchSeq), type: gameName, condition: marketCondition(row), options });
    grouped.set(fixtureKey, fixture);
  }
  return [...grouped.values()].sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));
}
