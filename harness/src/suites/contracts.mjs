import {
  invariant,
  isFiniteNumber,
  isIsoDate,
  isNonEmptyString,
  isObject,
  percentNumber,
} from "../assertions.mjs";

const REQUIRED_LEAGUE_CODES = new Set(["K1", "J1"]);
const REQUIRED_LEAGUE_IDS = { K1: 292, J1: 98 };

function invariantExactKeys(value, expected, label) {
  invariant(isObject(value), `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  invariant(actual.length === required.length && actual.every((key, index) => key === required[index]), `${label} keys/shape are invalid.`);
}

function invariantPositiveSafeInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer.`);
}

function invariantNonNegativeSafeInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative safe integer.`);
}

function gregorianDateParts(value) {
  if (typeof value !== "string") return null;
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12) return null;
  const daysInMonth = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : ([4, 6, 9, 11].includes(month) ? 30 : 31);
  return day >= 1 && day <= daysInMonth ? { year, month, day } : null;
}

function oneCalendarYearAfter(value) {
  const parts = gregorianDateParts(value);
  if (!parts) return null;
  const targetYear = parts.year + 1;
  if (targetYear > 9999) return null;
  const targetDay = parts.month === 2 && parts.day === 29 ? 28 : parts.day;
  return `${String(targetYear).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

function isKoreanKickoff(value) {
  if (typeof value !== "string") return false;
  const matched = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\+09:00$/u.exec(value);
  return matched !== null && gregorianDateParts(matched[1]) !== null;
}

function invariantNullableCanonicalIsoDateTime(value, label) {
  invariant(value === null || isCanonicalIsoDateTime(value), `${label} must be null or a canonical ISO date-time.`);
}

function expectedLeagueSeason(leagueCode, today) {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return leagueCode === "J1" && month >= 7 ? year + 1 : year;
}

export function assertFixtureContract(data) {
  invariant(isObject(data), "fixtures response must be an object.");
  invariant(isNonEmptyString(data.source), "fixtures source is required.");
  invariant(isIsoDate(data.today), "fixtures today must be YYYY-MM-DD.");
  invariant(isIsoDate(data.rangeEnd), "fixtures rangeEnd must be YYYY-MM-DD.");
  invariant(isIsoDate(data.statsThrough), "fixtures statsThrough must be YYYY-MM-DD.");
  invariant(Array.isArray(data.matches), "fixtures matches must be an array.");
  invariant(Array.isArray(data.leagues), "fixtures leagues must be an array.");
  invariant(isObject(data.standingsByLeague), "fixtures standingsByLeague must be an object.");

  const leagueCodes = new Set();
  for (const league of data.leagues) {
    invariant(isObject(league), "league metadata must be an object.");
    invariant(Number.isSafeInteger(league.id) && league.id > 0, "league id must be a positive integer.");
    invariant(REQUIRED_LEAGUE_CODES.has(league.code), `unsupported league code: ${league.code}`);
    invariant(league.id === REQUIRED_LEAGUE_IDS[league.code], `${league.code} league id must be ${REQUIRED_LEAGUE_IDS[league.code]}.`);
    const expectedSeason = expectedLeagueSeason(league.code, data.today);
    invariant(league.season === expectedSeason, `${league.code} season must be ${expectedSeason}.`);
    invariant(!leagueCodes.has(league.code), `duplicate league code: ${league.code}`);
    invariant(isNonEmptyString(league.name) && isNonEmptyString(league.apiName), `league ${league.code} name is required.`);
    leagueCodes.add(league.code);
  }
  for (const code of REQUIRED_LEAGUE_CODES) invariant(leagueCodes.has(code), `${code} league metadata is required.`);

  const matchIds = new Set();
  for (const match of data.matches) {
    invariant(isObject(match), "fixture match must be an object.");
    invariant(Number.isSafeInteger(match.id) && match.id > 0, "fixture match id must be a positive integer.");
    invariant(!matchIds.has(match.id), `duplicate fixture match id: ${match.id}`);
    matchIds.add(match.id);
    invariant(leagueCodes.has(match.leagueCode), `match ${match.id} has an unsupported league code: ${match.leagueCode}`);
    invariant(isIsoDate(match.date), `match ${match.id} date must be YYYY-MM-DD.`);
    invariant(isNonEmptyString(match.home) && isNonEmptyString(match.away), `match ${match.id} teams are required.`);
    invariant(Number.isInteger(match.homeRank) && Number.isInteger(match.awayRank), `match ${match.id} ranks are required.`);
  }

  for (const [leagueCode, standings] of Object.entries(data.standingsByLeague)) {
    invariant(leagueCodes.has(leagueCode), `standings have an unsupported league code: ${leagueCode}`);
    invariant(Array.isArray(standings), `standings for ${leagueCode} must be an array.`);
    if (leagueCode === "J1") invariant(standings.length === 20, "J1 standings must contain one 20-team official table.");
    const standingRanks = new Set();
    const standingTeamIds = new Set();
    let previousRank = 0;
    for (const row of standings) {
      invariant(isObject(row), `standing for ${leagueCode} must be an object.`);
      invariant(Number.isInteger(row.rank), "standing rank must be an integer.");
      invariant(Number.isSafeInteger(row.teamId) && row.teamId > 0, `standing ${row.rank} teamId must be a positive integer.`);
      invariant(!standingRanks.has(row.rank), `standings for ${leagueCode} have a duplicate rank: ${row.rank}`);
      invariant(!standingTeamIds.has(row.teamId), `standings for ${leagueCode} have a duplicate team: ${row.teamId}`);
      invariant(row.rank > previousRank, `standings for ${leagueCode} must preserve official rank order.`);
      standingRanks.add(row.rank);
      standingTeamIds.add(row.teamId);
      previousRank = row.rank;
      invariant(isNonEmptyString(row.team) && isNonEmptyString(row.teamCode), `standing ${row.rank} team and teamCode are required.`);
      for (const field of ["played", "won", "drawn", "lost", "points", "goalsFor", "goalsAgainst"]) {
        invariant(isFiniteNumber(row[field]), `standing ${row.rank} ${field} must be numeric.`);
      }
    }
  }
}

function isCanonicalIsoDateTime(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

export function assertHeadToHeadContract(data, fixtureId, kickoffAt) {
  invariant(isObject(data), "head-to-head response must be an object.");
  invariant(data.fixtureId === fixtureId, "head-to-head fixtureId does not match the requested fixture.");
  invariant(isCanonicalIsoDateTime(data.fetchedAt), "head-to-head fetchedAt must be a valid canonical date-time.");
  invariant(data.cacheSeconds === 1800, "head-to-head cacheSeconds must equal 1800.");
  invariant(Array.isArray(data.matches), "head-to-head matches must be an array.");
  invariant(data.matches.length <= 10, "head-to-head matches must contain at most ten records.");

  const kickoffDate = kickoffAt.slice(0, 10);
  for (const row of data.matches) {
    invariant(Array.isArray(row) && row.length === 4, "head-to-head row must be a four-value tuple.");
    invariant(typeof row[0] === "string" && /^\d{4}\.\d{2}\.\d{2}$/.test(row[0]), "head-to-head row date must be YYYY.MM.DD.");
    const date = row[0].replaceAll(".", "-");
    invariant(isIsoDate(date), "head-to-head row date must be valid.");
    invariant(date < kickoffDate, "head-to-head row must be historical and before the selected kickoff date.");
    invariant(typeof row[1] === "boolean", "head-to-head row home direction must be boolean.");
    invariant(typeof row[2] === "string" && /^\d+–\d+$/.test(row[2]), "head-to-head row score must be numeric.");
    invariant(["W", "D", "L"].includes(row[3]), "head-to-head row result must be W, D, or L.");
  }
}

function assertBetmanContract(data) {
  invariant(typeof data.configured === "boolean", "Betman configured must be boolean.");
  invariant(Array.isArray(data.fixtures), "Betman fixtures must be an array.");
  if (data.configured) {
    invariant(isNonEmptyString(data.sourceUrl), "Betman sourceUrl is required when configured.");
    invariant(isNonEmptyString(data.gmId) && isNonEmptyString(data.gmTs), "Betman gmId and gmTs are required when configured.");
  }
  for (const fixture of data.fixtures) {
    invariant(isIsoDate(fixture.date), "Betman fixture date must be YYYY-MM-DD.");
    invariant(isNonEmptyString(fixture.homeTeam) && isNonEmptyString(fixture.awayTeam), "Betman fixture teams are required.");
    invariant(Array.isArray(fixture.markets), "Betman fixture markets must be an array.");
    for (const market of fixture.markets) {
      invariant(isNonEmptyString(market.matchSeq) && isNonEmptyString(market.type), "Betman market identity is required.");
      invariant(Array.isArray(market.options), "Betman market options must be an array.");
      for (const option of market.options) {
        invariant(isNonEmptyString(option.label), "Betman option label is required.");
        invariant(Number.isFinite(Number(option.odds)) && Number(option.odds) > 0, "Betman option odds must be positive.");
      }
    }
  }
}

export function assertPreMatchOddsContract(data, fixtureId) {
  invariant(isObject(data), "pre-match odds response must be an object.");
  invariant(data.fixtureId === fixtureId, "pre-match odds fixtureId does not match the requested fixture.");
  invariant(typeof data.fetchedAt === "string" && !Number.isNaN(Date.parse(data.fetchedAt)), "pre-match odds fetchedAt must be a date-time.");
  invariant(Number.isSafeInteger(data.cacheSeconds) && data.cacheSeconds > 0, "pre-match odds cacheSeconds must be a positive integer.");
  invariant(Array.isArray(data.bookmakers), "pre-match odds bookmakers must be an array.");
  for (const bookmaker of data.bookmakers) {
    invariant(isObject(bookmaker), "bookmaker must be an object.");
    invariant(Number.isSafeInteger(bookmaker.id) && bookmaker.id > 0, "bookmaker id must be a positive integer.");
    invariant(isNonEmptyString(bookmaker.name), "bookmaker name is required.");
    invariant(Array.isArray(bookmaker.markets) && bookmaker.markets.length > 0, "bookmaker markets must be a non-empty array.");
    for (const market of bookmaker.markets) {
      invariant(isObject(market), "odds market must be an object.");
      invariant(Number.isSafeInteger(market.id) && market.id > 0, "odds market id must be a positive integer.");
      invariant(isNonEmptyString(market.name), "odds market name is required.");
      invariant(Array.isArray(market.values) && market.values.length > 0, "odds market values must be a non-empty array.");
      for (const value of market.values) {
        invariant(isObject(value), "odds value must be an object.");
        invariant(isNonEmptyString(value.label), "odds value label is required.");
        invariant(isFiniteNumber(value.odds) && value.odds > 0, "odds value odds must be positive.");
      }
    }
  }
}

export function assertOddsHistoryContract(data) {
  invariantExactKeys(data, ["query", "teams", "records", "pagination", "excludedCounts", "archive"], "odds history response");
  invariantExactKeys(data.query, ["league", "team", "from", "to", "page", "pageSize"], "odds history query");
  invariant(["all", "K1", "J1"].includes(data.query.league), "odds history query league is invalid.");
  const queryTeam = typeof data.query.team === "string" ? /^(K1|J1):([1-9]\d*)$/u.exec(data.query.team) : null;
  invariant(data.query.team === null || queryTeam !== null, "odds history query team is invalid.");
  if (queryTeam) {
    invariantPositiveSafeInteger(Number(queryTeam[2]), "odds history query team ID");
    invariant(data.query.league === "all" || data.query.league === queryTeam[1], "odds history query team league is invalid.");
  }
  invariant(gregorianDateParts(data.query.from) !== null && gregorianDateParts(data.query.to) !== null && data.query.from <= data.query.to, "odds history query date range is invalid.");
  const maximumQueryDate = oneCalendarYearAfter(data.query.from);
  invariant(maximumQueryDate !== null && data.query.to <= maximumQueryDate, "odds history query must be within one calendar year.");
  invariantPositiveSafeInteger(data.query.page, "odds history query page");
  invariant(data.query.pageSize === 30, "odds history query/page size is invalid.");
  invariant(Array.isArray(data.teams) && Array.isArray(data.records), "odds history arrays are required.");
  invariantExactKeys(data.pagination, ["page", "pageSize", "total", "totalPages"], "odds history pagination");
  invariantPositiveSafeInteger(data.pagination.page, "odds history pagination page");
  invariant(data.pagination.pageSize === 30, "odds history pagination/page size is invalid.");
  invariantNonNegativeSafeInteger(data.pagination.total, "odds history pagination total");
  invariantNonNegativeSafeInteger(data.pagination.totalPages, "odds history pagination totalPages");
  invariant(data.pagination.page === data.query.page, "odds history pagination page must match the query.");
  invariant(data.pagination.pageSize === data.query.pageSize, "odds history pagination page size must match the query.");
  invariant(data.pagination.totalPages === Math.ceil(data.pagination.total / 30), "odds history pagination totalPages is inconsistent.");
  const expectedRecordCount = data.pagination.page > data.pagination.totalPages
    ? 0
    : Math.min(30, data.pagination.total - ((data.pagination.page - 1) * 30));
  invariant(data.records.length === expectedRecordCount, "odds history record count is inconsistent with pagination.");
  invariantExactKeys(data.excludedCounts, ["cancelled", "pendingResult", "missingOdds", "teamMatchFailed"], "odds history exclusions");
  invariantExactKeys(data.archive, ["pendingRounds", "cooldownPendingRounds", "errorRounds", "nextPendingRetryAt", "lastSuccessfulSyncAt"], "odds history archive");

  const teamKeys = new Set();
  for (const team of data.teams) {
    invariantExactKeys(team, ["key", "leagueCode", "id", "name"], "odds history team");
    invariant(["K1", "J1"].includes(team.leagueCode), "odds history team league is invalid.");
    invariantPositiveSafeInteger(team.id, "odds history team ID");
    invariant(team.key === `${team.leagueCode}:${team.id}`, "odds history team key is inconsistent.");
    invariant(isNonEmptyString(team.name), "odds history team name is required.");
    invariant(data.query.league === "all" || team.leagueCode === data.query.league, "odds history team league must match the query.");
    invariant(!teamKeys.has(team.key), "odds history team keys must be unique.");
    teamKeys.add(team.key);
  }
  if (data.query.team !== null) invariant(teamKeys.has(data.query.team), "odds history query team must exist in teams.");
  const sourceKeys = new Set();
  let previousRecord = null;
  for (const record of data.records) {
    invariantExactKeys(record, [
      "sourceKey", "round", "matchSeq", "leagueCode", "leagueName", "kickoffAt", "date",
      "homeTeamId", "awayTeamId", "homeTeam", "awayTeam", "betmanHomeTeam", "betmanAwayTeam",
      "score", "result", "odds", "finalizedAt",
    ], "odds history record");
    invariantExactKeys(record.score, ["home", "away"], "odds history score");
    invariantExactKeys(record.odds, ["home", "draw", "away"], "odds history odds");
    invariant(isNonEmptyString(record.sourceKey) && isNonEmptyString(record.round) && isNonEmptyString(record.matchSeq), "odds history record identity strings are required.");
    invariant(/^\d+$/u.test(record.round) && /^\d+$/u.test(record.matchSeq), "odds history round and match sequence must be numeric strings.");
    invariant(record.sourceKey === `G101:${record.round}:${record.matchSeq}`, "odds history source key is inconsistent.");
    invariant(!sourceKeys.has(record.sourceKey), "odds history record source keys must be unique.");
    sourceKeys.add(record.sourceKey);
    invariant(["K1", "J1"].includes(record.leagueCode), "unsupported odds history league.");
    invariant(data.query.league === "all" || record.leagueCode === data.query.league, "odds history record league must match the query.");
    invariant(isNonEmptyString(record.leagueName), "odds history league name is required.");
    invariant(isKoreanKickoff(record.kickoffAt), "odds history record must have an exact Korean kickoff.");
    invariant(gregorianDateParts(record.date) !== null && record.kickoffAt.slice(0, 10) === record.date, "odds history record date is invalid.");
    invariant(record.date >= data.query.from && record.date <= data.query.to, "odds history record date must be inside the query range.");
    invariantPositiveSafeInteger(record.homeTeamId, "odds history home team ID");
    invariantPositiveSafeInteger(record.awayTeamId, "odds history away team ID");
    if (queryTeam) {
      const queryTeamId = Number(queryTeam[2]);
      invariant(
        record.leagueCode === queryTeam[1] && (record.homeTeamId === queryTeamId || record.awayTeamId === queryTeamId),
        "odds history record team must match the query.",
      );
    }
    invariantNonNegativeSafeInteger(record.score.home, "odds history score home");
    invariantNonNegativeSafeInteger(record.score.away, "odds history score away");
    invariant(["H", "D", "A"].includes(record.result), "final result is required.");
    const scoreResult = record.score.home > record.score.away ? "H" : record.score.home < record.score.away ? "A" : "D";
    invariant(record.result === scoreResult, "odds history final result must match the score.");
    invariant(
      isFiniteNumber(record.odds.home) && record.odds.home > 0
        && isFiniteNumber(record.odds.draw) && record.odds.draw > 0
        && isFiniteNumber(record.odds.away) && record.odds.away > 0,
      "three positive final odds are required.",
    );
    invariant(
      isNonEmptyString(record.homeTeam) && isNonEmptyString(record.awayTeam)
        && isNonEmptyString(record.betmanHomeTeam) && isNonEmptyString(record.betmanAwayTeam),
      "canonical and raw team names are required.",
    );
    invariant(isCanonicalIsoDateTime(record.finalizedAt), "odds history finalizedAt must be a canonical ISO date-time.");
    invariant(Date.parse(record.finalizedAt) >= Date.parse(record.kickoffAt), "odds history finalizedAt must not precede kickoff.");
    if (previousRecord !== null) {
      const ordered = previousRecord.kickoffAt > record.kickoffAt
        || (previousRecord.kickoffAt === record.kickoffAt && (
          previousRecord.round > record.round
          || (previousRecord.round === record.round && previousRecord.matchSeq > record.matchSeq)
        ));
      invariant(ordered, "odds history record order must match the producer contract.");
    }
    previousRecord = record;
  }

  for (const key of ["cancelled", "pendingResult", "missingOdds", "teamMatchFailed"]) {
    invariantNonNegativeSafeInteger(data.excludedCounts[key], `odds history excluded ${key}`);
  }
  for (const key of ["pendingRounds", "cooldownPendingRounds", "errorRounds"]) {
    invariantNonNegativeSafeInteger(data.archive[key], `odds history archive ${key}`);
  }
  invariant(data.archive.cooldownPendingRounds <= data.archive.pendingRounds, "odds history archive cooldown count exceeds pending rounds.");
  invariantNullableCanonicalIsoDateTime(data.archive.nextPendingRetryAt, "odds history archive nextPendingRetryAt");
  invariantNullableCanonicalIsoDateTime(data.archive.lastSuccessfulSyncAt, "odds history archive lastSuccessfulSyncAt");
  invariant(
    (data.archive.cooldownPendingRounds === 0) === (data.archive.nextPendingRetryAt === null),
    "odds history archive retry timestamp must match cooldown rounds.",
  );
}

function assertPredictionContract(data, fixtureId) {
  invariant(data.fixtureId === fixtureId, "prediction fixtureId does not match the requested fixture.");
  invariant(data.prediction === null || isObject(data.prediction), "prediction must be an object or null.");
  if (!data.prediction) return false;
  invariant(isObject(data.prediction.percent), "prediction percent must be an object.");
  for (const key of ["home", "draw", "away"]) {
    const value = percentNumber(data.prediction.percent[key]);
    invariant(Number.isFinite(value) && value >= 0 && value <= 100, `prediction ${key} percent is invalid.`);
  }
  return true;
}

export function assertSavedPredictionContract(item) {
  invariant(isObject(item), "saved prediction must be an object.");
  invariant(isNonEmptyString(item.predictionKey), "saved prediction key is required.");
  invariant(Number.isSafeInteger(item.matchId) && item.matchId > 0, "saved prediction match ID is invalid.");
  invariant(isIsoDate(item.matchDate), "saved prediction match date is invalid.");
  invariant(typeof item.kickoffTime === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.kickoffTime), "saved prediction kickoff time is invalid.");
  invariant(isNonEmptyString(item.homeTeam) && isNonEmptyString(item.awayTeam), "saved prediction teams are required.");
  invariant(Number.isSafeInteger(item.marketIndex) && item.marketIndex >= 0, "saved prediction market index is invalid.");
  invariant(isNonEmptyString(item.marketType) && typeof item.marketCondition === "string", "saved prediction market fields are invalid.");
  const hasRound = isNonEmptyString(item.betmanRound);
  const hasSequence = isNonEmptyString(item.matchSeq);
  invariant(hasRound === hasSequence, "betmanRound and matchSeq must either both be present or both be absent.");
  if (hasRound) invariant(/^\d+$/.test(item.betmanRound) && /^\d+$/.test(item.matchSeq), "betmanRound and matchSeq must be numeric strings.");
  invariant(Array.isArray(item.options) && item.options.length >= 2 && item.options.length <= 3, "saved prediction must have two or three options.");
  let calculatedSum = 0;
  for (const option of item.options) {
    invariant(isNonEmptyString(option.label), "saved prediction option label is required.");
    invariant(isFiniteNumber(option.odds) && option.odds > 0, "saved prediction option odds are invalid. 배당");
    invariant(isFiniteNumber(option.probability) && option.probability >= 0 && option.probability <= 1, "saved prediction option probability is invalid.");
    invariant(isFiniteNumber(option.expectedReturn), "saved prediction option expected return is invalid.");
    invariant(Math.abs(option.expectedReturn - (option.probability * option.odds - 1)) <= 0.000001, "saved prediction expected return does not match its odds and probability.");
    calculatedSum += option.probability;
  }
  invariant(isFiniteNumber(item.probabilitySum) && Math.abs(item.probabilitySum - 1) <= 0.001, "saved prediction probability sum must equal one. 확률합");
  invariant(Math.abs(calculatedSum - item.probabilitySum) <= 0.001, "saved prediction option probabilities do not match the response total.");
  invariant(typeof item.savedAt === "string" && !Number.isNaN(Date.parse(item.savedAt)), "saved prediction timestamp is invalid.");
}

export async function runContracts({ client, config, report, state }) {
  await report.check("contracts", "fixtures and standings response contract", async () => {
    const { body } = await client.json("/api/fixtures");
    assertFixtureContract(body);
    state.fixtures = body;
    return `${body.matches.length} fixture(s), ${Object.keys(body.standingsByLeague).length} league standing set(s)`;
  });

  await report.check("contracts", "Betman odds response contract", async () => {
    const { body } = await client.json("/api/betman-odds");
    assertBetmanContract(body);
    state.betman = body;
    return body.configured ? `${body.fixtures.length} fixture(s)` : "source URL is not configured";
  });

  await report.check("contracts", "stored odds history response contract", async () => {
    const { body } = await client.json("/api/odds-history");
    assertOddsHistoryContract(body);
    return `${body.pagination.total} finalized match(es)`;
  });

  await report.check("contracts", "saved market predictions response contract", async () => {
    const { body } = await client.json("/api/market-predictions");
    invariant(Array.isArray(body.predictions), "saved predictions must be an array.");
    const keys = new Set();
    for (const item of body.predictions) {
      assertSavedPredictionContract(item);
      invariant(!keys.has(item.predictionKey), `duplicate saved prediction key: ${item.predictionKey}`);
      keys.add(item.predictionKey);
    }
    return `${body.predictions.length} saved prediction(s)`;
  });

  const fixtureId = config.fixtureId || state.fixtures?.matches?.[0]?.id;
  if (!fixtureId) {
    report.skip("contracts", "prediction and pre-match odds response contracts", "no scheduled fixture is available to query.");
    return;
  }

  await report.check("contracts", "prediction response contract", async () => {
    const { body } = await client.json(`/api/predictions?fixture=${fixtureId}`);
    const hasPrediction = assertPredictionContract(body, fixtureId);
    state.prediction = body;
    return hasPrediction ? `fixture ${fixtureId}` : `fixture ${fixtureId}, no provider prediction`;
  });

  await report.check("contracts", "pre-match odds response contract", async () => {
    const { body } = await client.json(`/api/pre-match-odds?fixture=${fixtureId}`);
    assertPreMatchOddsContract(body, fixtureId);
    state.preMatchOdds = body;
    return `${body.bookmakers.length} bookmaker(s)`;
  });
}
