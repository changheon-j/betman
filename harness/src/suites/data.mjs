import { invariant, isNonEmptyString, percentNumber } from "../assertions.mjs";
import { assertHeadToHeadContract } from "./contracts.mjs";

function dayDistance(start, end) {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
}

async function ensureState(client, state) {
  if (!state.fixtures) state.fixtures = (await client.json("/api/fixtures")).body;
  if (!state.betman) state.betman = (await client.json("/api/betman-odds")).body;
}

function assertLeagueStandings(fixtures) {
  const leagueCodes = new Set(fixtures.leagues.map((league) => league.code));
  const standingsByLeague = fixtures.standingsByLeague;
  for (const [leagueCode, standings] of Object.entries(standingsByLeague)) {
    invariant(leagueCodes.has(leagueCode), `unknown standings league ${leagueCode}.`);
    invariant(Array.isArray(standings) && standings.length > 0, `${leagueCode} standings are empty.`);
    const ranks = new Set();
    const teamIds = new Set();
    const standingsByCode = new Map();
    for (const row of standings) {
      invariant(Number.isInteger(row.rank) && row.rank >= 1 && row.rank <= standings.length, `${leagueCode} standing rank is out of range.`);
      invariant(!ranks.has(row.rank), `${leagueCode} has a duplicate rank ${row.rank}.`);
      invariant(Number.isSafeInteger(row.teamId) && row.teamId > 0 && !teamIds.has(row.teamId), `${leagueCode} has a duplicate team ID.`);
      invariant(isNonEmptyString(row.teamCode) && !standingsByCode.has(row.teamCode), `${leagueCode} has a duplicate team code.`);
      ranks.add(row.rank);
      teamIds.add(row.teamId);
      standingsByCode.set(row.teamCode, row);
      invariant(row.played === row.won + row.drawn + row.lost, `${leagueCode} ${row.team} played total does not match.`);
      invariant(row.goalsFor - row.goalsAgainst === row.goalDifference, `${leagueCode} ${row.team} goal difference does not match.`);
    }
    for (let rank = 1; rank <= standings.length; rank += 1) invariant(ranks.has(rank), `${leagueCode} is missing rank ${rank}.`);
    for (const match of fixtures.matches.filter((item) => item.leagueCode === leagueCode)) {
      invariant(standingsByCode.get(match.homeCode)?.rank === match.homeRank, `match ${match.id} home rank does not match ${leagueCode} standings.`);
      invariant(standingsByCode.get(match.awayCode)?.rank === match.awayRank, `match ${match.id} away rank does not match ${leagueCode} standings.`);
    }
  }
}

export async function runData({ client, report, state }) {
  await ensureState(client, state);
  const fixtures = state.fixtures;

  await report.check("data", "fixtures stay inside the shared 14-day window", () => {
    invariant(dayDistance(fixtures.today, fixtures.rangeEnd) === 14, "fixture range must be exactly 14 days.");
    for (const match of fixtures.matches) {
      invariant(match.date >= fixtures.today && match.date <= fixtures.rangeEnd,
        `match ${match.id} date ${match.date} is outside ${fixtures.today} through ${fixtures.rangeEnd}.`);
    }
    return `${fixtures.today} through ${fixtures.rangeEnd}`;
  });

  await report.check("data", "standings are unique and linked within each league", () => {
    assertLeagueStandings(fixtures);
    return `${Object.keys(fixtures.standingsByLeague).length} league standing set(s)`;
  });

  const selectedFixture = fixtures.matches[0];
  if (selectedFixture) {
    await report.check("data", "selected fixture head-to-head records are historical and complete", async () => {
      const query = new URLSearchParams({
        fixture: String(selectedFixture.id),
        home: String(selectedFixture.homeTeamId),
        away: String(selectedFixture.awayTeamId),
        kickoff: selectedFixture.kickoffAt,
      });
      const { body } = await client.json(`/api/head-to-head?${query.toString()}`);
      assertHeadToHeadContract(body, selectedFixture.id, selectedFixture.kickoffAt);
      state.headToHead = body;
      return `fixture ${selectedFixture.id}, ${body.matches.length} record(s)`;
    });
  } else {
    report.skip("data", "selected fixture head-to-head records are historical and complete", "no scheduled fixture is available to query.");
  }

  if (state.prediction?.prediction) {
    await report.check("data", "prediction outcome percentages sum to 100", () => {
      const p = state.prediction.prediction.percent;
      const total = percentNumber(p.home) + percentNumber(p.draw) + percentNumber(p.away);
      invariant(Math.abs(total - 100) <= 0.2, `prediction percentages total ${total}%.`);
      return `${total}%`;
    });
  } else {
    report.skip("data", "prediction outcome percentages sum to 100", "the selected fixture has no provider prediction.");
  }

  const betman = state.betman;
  if (!betman.configured || betman.fixtures.length === 0) {
    report.skip("data", "Betman odds business rules", "the source URL or Betman fixture data is unavailable.");
  } else {
    await report.check("data", "Betman odds business rules", () => {
      let markets = 0;
      for (const fixture of betman.fixtures) {
        for (const market of fixture.markets) {
          invariant(market.options.length >= 2 && market.options.length <= 3, `Betman market ${market.matchSeq} must have two or three options.`);
          for (const option of market.options) invariant(Number(option.odds) > 0, `Betman option ${market.matchSeq}/${option.label} must have positive odds.`);
          markets += 1;
        }
      }
      return `${betman.fixtures.length} fixture(s), ${markets} market(s)`;
    });
  }
}
