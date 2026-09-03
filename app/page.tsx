"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from "react";
import { AnalysisCloseButton } from "./analysis-close-button";
import {
  focusFixtureDetail,
  predictionErrorForFixture,
  predictionForFixture,
  reconcileSelectedFixtureId,
  selectedFixture,
} from "./fixture-workspace";
import { LeagueErrorsWarning } from "./league-errors-warning";
import { PreMatchBookmakers } from "./pre-match-match-winner";
import { SavedOptionButton } from "./saved-option-button";
import { OddsHistory } from "./odds-history";
import { findBetmanFixture } from "./lib/betman-matcher";
import {
  changedPredictionSelections,
  excludePredictionsByKey,
  savedProbabilitiesForMarket,
  togglePredictionSelection as togglePredictionOptionSelection,
} from "./lib/market-prediction";
import {
  headToHeadErrorForFixture,
  headToHeadForFixture,
  headToHeadLoadingForFixture,
  headToHeadWinnerClasses,
  type HeadToHeadPayload,
} from "./lib/head-to-head";
import type { LeagueCode } from "./lib/leagues";
import { preMatchOddsForFixture, type PreMatchOddsPayload } from "./lib/pre-match-odds";

type Result = "W" | "D" | "L";
type RecentMatch = [string, string, string, Result];
type Match = {
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

type FixturePayload = {
  source: string;
  today: string;
  rangeEnd: string;
  statsThrough: string;
  fetchedAt: string;
  matches: Match[];
  standingsByLeague: Partial<Record<LeagueCode, Standing[]>>;
  leagues: Array<{ id: number; code: LeagueCode; name: string; apiName: string; season: number }>;
  leagueErrors: Partial<Record<LeagueCode, string>>;
};

type FixtureMeta = Omit<FixturePayload, "matches" | "standingsByLeague" | "leagueErrors">;
type PreMatchOddsResponse = PreMatchOddsPayload & { fetchedAt?: string; cacheSeconds?: number; error?: string };

type Standing = {
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

type BetmanOption = {
  label: string;
  odds: string;
};

type BetmanMarket = {
  matchSeq: string;
  type: string;
  condition: string;
  options: BetmanOption[];
};

type BetmanFixture = {
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

type BetmanPayload = {
  configured: boolean;
  sourceUrl?: string;
  gmId?: string;
  gmTs?: string;
  updatedAt?: string;
  fetchedAt?: string;
  cacheSeconds?: number;
  fixtures: BetmanFixture[];
  error?: string;
};

type ApiPrediction = {
  winner: { id: number | null; name: string; comment: string };
  winOrDraw: boolean;
  underOver: string;
  goals: { home: string; away: string };
  advice: string;
  percent: { home: string; draw: string; away: string };
  teams: { homeId: number | null; awayId: number | null };
  comparison: { home: string; away: string };
};

type PredictionPayload = {
  source?: string;
  fixtureId?: number;
  fetchedAt?: string;
  prediction: ApiPrediction | null;
  error?: string;
};

type SaveStatus = {
  tone: "success" | "error";
  message: string;
};

type SavedMarketPrediction = {
  predictionKey: string;
  matchId: number;
  matchDate: string;
  kickoffTime: string;
  homeTeam: string;
  awayTeam: string;
  marketIndex: number;
  marketType: string;
  marketCondition: string;
  betmanRound: string | null;
  matchSeq: string | null;
  options: Array<{ label: string; odds: number; probability: number; expectedReturn: number }>;
  probabilitySum: number;
  savedAt: string;
  selectedOptionIndex: number | null;
};

function marketStateKey(matchId: number, betmanRound: string, matchSeq: string) {
  return `${matchId}-${betmanRound}-${matchSeq}`;
}

const emblemByTeam: Record<string, string> = {
  "전북": "jeonbuk", "전북 현대": "jeonbuk",
  "울산": "ulsan", "울산 HD": "ulsan",
  "서울": "seoul", "FC 서울": "seoul",
  "포항": "pohang", "포항 스틸러스": "pohang",
  "대전": "daejeon", "대전 하나": "daejeon",
  "광주": "gwangju", "광주 FC": "gwangju",
  "제주": "jeju", "제주 SK": "jeju",
  "강원": "gangwon", "강원 FC": "gangwon",
  "안양": "anyang", "FC 안양": "anyang",
  "김천": "gimcheon", "김천 상무": "gimcheon",
  "인천": "incheon", "인천 유나이티드": "incheon",
  "부천": "bucheon", "부천 FC": "bucheon",
};

function getKoreanToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

const DEFAULT_END_DATE = getKoreanToday();
const DEFAULT_START_DATE = `${DEFAULT_END_DATE.slice(0, 4)}-01-01`;

function formatDate(value?: string) {
  return value ? value.replaceAll("-", ".") : "";
}

function getExpectedReturn(probability: string, odds: string) {
  if (probability.trim() === "") return null;
  const probabilityValue = Number(probability);
  if (!Number.isFinite(probabilityValue) || probabilityValue < 0 || probabilityValue > 1) return null;
  return probabilityValue * Number(odds) - 1;
}

function formatSavedAt(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function perGame(goals: string, played: number) {
  const [scored, conceded] = goals.split("/").map((value) => Number(value.trim()));
  const divisor = Math.max(played, 1);
  return [(scored / divisor).toFixed(2), (conceded / divisor).toFixed(2)];
}

function percentNumber(value: string) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
}

function underOverLabel(value: string) {
  if (value.startsWith("-")) return `${value.slice(1)}골 언더`;
  if (value.startsWith("+")) return `${value.slice(1)}골 오버`;
  return value || "제공 없음";
}

function predictionHeadline(prediction: ApiPrediction, homeTeam: string, awayTeam: string) {
  const team = prediction.winner.id === prediction.teams.homeId
    ? homeTeam
    : prediction.winner.id === prediction.teams.awayId
      ? awayTeam
      : prediction.winner.name;
  const comment = prediction.winner.comment.toLowerCase();
  if (comment.includes("win or draw")) return `${team} 승 또는 무승부`;
  if (comment.includes("draw")) return "무승부 가능성 우세";
  return team ? `${team} 승리 우세` : "우세 결과 미정";
}

function Form({ values }: { values: readonly Result[] }) {
  return <span className="form-row" aria-label={`최근 전적 ${values.join(", ")}`}>
    {values.map((value, index) => <i className={`form form-${value.toLowerCase()}`} key={`${value}-${index}`}>{value}</i>)}
  </span>;
}

function Crest({ code, logo, large = false }: { code: string; logo?: string; large?: boolean }) {
  const emblem = emblemByTeam[code];
  const image = emblem ? `/team-emblems/${emblem}.png` : logo;
  return <span className={`crest crest-${code} ${image ? "has-emblem" : ""} ${large ? "crest-large" : ""}`}>
    {image ? <img src={image} alt="" /> : code.slice(0, 1)}
  </span>;
}

export default function Home() {
  const [section, setSection] = useState<"matches" | "standings" | "odds" | "saved">("matches");
  const [filter, setFilter] = useState<"all" | "weekend">("all");
  const [matches, setMatches] = useState<Match[]>([]);
  const [standingsByLeague, setStandingsByLeague] = useState<FixturePayload["standingsByLeague"]>({});
  const [leagueErrors, setLeagueErrors] = useState<FixturePayload["leagueErrors"]>({});
  const [standingLeague, setStandingLeague] = useState<LeagueCode>("K1");
  const [fixtureMeta, setFixtureMeta] = useState<FixtureMeta | null>(null);
  const [fixturesLoading, setFixturesLoading] = useState(true);
  const [fixturesError, setFixturesError] = useState("");
  const [selectedId, setSelectedId] = useState(0);
  const [marketProbabilities, setMarketProbabilities] = useState<Record<string, string>>({});
  const [saveStatuses, setSaveStatuses] = useState<Record<string, SaveStatus>>({});
  const [savingRows, setSavingRows] = useState<Record<string, boolean>>({});
  const [savedFromDate, setSavedFromDate] = useState(DEFAULT_START_DATE);
  const [savedToDate, setSavedToDate] = useState(DEFAULT_END_DATE);
  const [savedPredictions, setSavedPredictions] = useState<SavedMarketPrediction[]>([]);
  const [restorablePredictions, setRestorablePredictions] = useState<SavedMarketPrediction[]>([]);
  const [selectedPredictionKeys, setSelectedPredictionKeys] = useState<string[]>([]);
  const [savedSelectionDrafts, setSavedSelectionDrafts] = useState<Record<string, number | null>>({});
  const [savedLoading, setSavedLoading] = useState(false);
  const [savingSavedSelections, setSavingSavedSelections] = useState(false);
  const [savedNotice, setSavedNotice] = useState<SaveStatus | null>(null);
  const [betmanUrlInput, setBetmanUrlInput] = useState("");
  const [betmanRound, setBetmanRound] = useState<BetmanPayload>({ configured: false, fixtures: [] });
  const [betmanLoading, setBetmanLoading] = useState(true);
  const [betmanSaving, setBetmanSaving] = useState(false);
  const [betmanNotice, setBetmanNotice] = useState<SaveStatus | null>(null);
  const [apiPrediction, setApiPrediction] = useState<{ fixtureId: number; data: ApiPrediction | null } | null>(null);
  const [predictionLoading, setPredictionLoading] = useState(false);
  const [predictionError, setPredictionError] = useState<{ fixtureId: number; message: string } | null>(null);
  const [preMatchOdds, setPreMatchOdds] = useState<PreMatchOddsResponse | null>(null);
  const [preMatchOddsLoading, setPreMatchOddsLoading] = useState(false);
  const [preMatchOddsError, setPreMatchOddsError] = useState<{ fixtureId: number; message: string } | null>(null);
  const [headToHead, setHeadToHead] = useState<HeadToHeadPayload | null>(null);
  const [headToHeadError, setHeadToHeadError] = useState<{ fixtureId: number; message: string } | null>(null);
  const analysisPanelRef = useRef<HTMLElement | null>(null);
  const lastDetailTriggerRef = useRef<HTMLButtonElement | null>(null);
  const selected = selectedFixture(matches, selectedId);
  const [homeGoalsPerGame, homeConcededPerGame] = selected ? perGame(selected.homeGoals, selected.homePlayed) : ["0.00", "0.00"];
  const [awayGoalsPerGame, awayConcededPerGame] = selected ? perGame(selected.awayGoals, selected.awayPlayed) : ["0.00", "0.00"];
  const selectedBetmanFixture = selected ? findBetmanFixture(selected, betmanRound.fixtures) : undefined;
  const betmanMarkets = selectedBetmanFixture?.markets ?? [];
  const currentApiPrediction = predictionForFixture(selected?.id, apiPrediction);
  const currentPredictionError = predictionErrorForFixture(selected?.id, predictionError);
  const currentPreMatchOdds = preMatchOddsForFixture(selected?.id, preMatchOdds);
  const currentPreMatchOddsError = selected && preMatchOddsError?.fixtureId === selected.id ? preMatchOddsError.message : "";
  const currentPreMatchOddsLoading = Boolean(selected && !currentPreMatchOdds && !currentPreMatchOddsError);
  const currentHeadToHead = headToHeadForFixture(selected?.id, headToHead);
  const currentHeadToHeadError = headToHeadErrorForFixture(selected?.id, headToHeadError);
  const currentHeadToHeadLoading = headToHeadLoadingForFixture(selected?.id, headToHead, headToHeadError);
  const selectedStandings = standingsByLeague[standingLeague] ?? [];
  const selectedLeagueName = standingLeague === "K1" ? "K리그1" : "J리그1";
  const selectedLeagueSeason = fixtureMeta?.leagues.find((league) => league.code === standingLeague)?.season;
  const seasonSummary = fixtureMeta?.leagues.map((league) => `${league.code} ${league.season}`).join(" · ") ?? "현재";
  const displayedMatches = filter === "weekend"
    ? matches.filter((match) => {
      const day = new Date(`${match.date}T00:00:00+09:00`).getDay();
      return day === 0 || day === 6;
    })
    : matches;
  const allSavedSelected = savedPredictions.length > 0 && savedPredictions.every((prediction) => selectedPredictionKeys.includes(prediction.predictionKey));
  const pendingSavedSelections = changedPredictionSelections(savedPredictions, savedSelectionDrafts);
  const hasUnsavedSavedSelections = pendingSavedSelections.length > 0;

  useEffect(() => {
    if (!hasUnsavedSavedSelections) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasUnsavedSavedSelections]);

  useEffect(() => {
    let cancelled = false;
    setFixturesLoading(true);
    fetch("/api/fixtures")
      .then(async (response) => {
        const payload = await response.json() as FixturePayload & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "경기 일정을 불러오지 못했습니다.");
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setMatches(payload.matches);
        setStandingsByLeague(payload.standingsByLeague);
        setLeagueErrors(payload.leagueErrors);
        setSelectedId((current) => reconcileSelectedFixtureId(payload.matches, current));
        const {
          matches: ignoredMatches,
          standingsByLeague: ignoredStandings,
          leagueErrors: ignoredLeagueErrors,
          ...meta
        } = payload;
        void ignoredMatches;
        void ignoredStandings;
        void ignoredLeagueErrors;
        setFixtureMeta(meta);
        setFixturesError("");
      })
      .catch((error) => {
        if (!cancelled) setFixturesError(error instanceof Error ? error.message : "경기 일정을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!cancelled) setFixturesLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selected?.id) {
      setPredictionLoading(false);
      setPredictionError(null);
      setApiPrediction(null);
      return;
    }
    const fixtureId = selected.id;
    let cancelled = false;
    setPredictionLoading(true);
    setPredictionError(null);
    setApiPrediction(null);
    fetch(`/api/predictions?fixture=${fixtureId}`)
      .then(async (response) => {
        const payload = await response.json() as PredictionPayload;
        if (!response.ok) throw new Error(payload.error ?? "경기 예측을 불러오지 못했습니다.");
        return payload;
      })
      .then((payload) => {
        if (!cancelled) setApiPrediction({ fixtureId, data: payload.prediction });
      })
      .catch((error) => {
        if (!cancelled) setPredictionError({
          fixtureId,
          message: error instanceof Error ? error.message : "경기 예측을 불러오지 못했습니다.",
        });
      })
      .finally(() => {
        if (!cancelled) setPredictionLoading(false);
      });
    return () => { cancelled = true; };
  }, [selected?.id]);

  useEffect(() => {
    if (!selected?.id) return;
    const panel = analysisPanelRef.current;
    if (!panel) return;

    focusFixtureDetail(panel, {
      isSmallViewport: window.matchMedia?.("(max-width: 1050px)").matches ?? false,
      prefersReducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    });
  }, [selected?.id]);

  useEffect(() => {
    setHeadToHead(null);
    setHeadToHeadError(null);
    if (!selected?.id) return;

    const fixtureId = selected.id;
    const controller = new AbortController();
    const query = new URLSearchParams({
      fixture: String(fixtureId),
      home: String(selected.homeTeamId),
      away: String(selected.awayTeamId),
      kickoff: selected.kickoffAt,
    });

    fetch(`/api/head-to-head?${query.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as HeadToHeadPayload & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "최근 맞대결을 불러오지 못했습니다.");
        return payload;
      })
      .then((payload) => {
        if (!controller.signal.aborted && payload.fixtureId === fixtureId) setHeadToHead(payload);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setHeadToHeadError({
          fixtureId,
          message: error instanceof Error ? error.message : "최근 맞대결을 불러오지 못했습니다.",
        });
      });

    return () => controller.abort();
  }, [selected?.id, selected?.homeTeamId, selected?.awayTeamId, selected?.kickoffAt]);

  useEffect(() => {
    setPreMatchOdds(null);
    setPreMatchOddsError(null);
    if (!selected?.id) {
      setPreMatchOddsLoading(false);
      return;
    }

    const fixtureId = selected.id;
    let cancelled = false;
    setPreMatchOddsLoading(true);
    fetch(`/api/pre-match-odds?fixture=${fixtureId}`)
      .then(async (response) => {
        const payload = await response.json() as PreMatchOddsResponse;
        if (!response.ok) throw new Error(payload.error ?? "사전 배당을 불러오지 못했습니다.");
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setPreMatchOdds(payload);
      })
      .catch((error) => {
        if (!cancelled) setPreMatchOddsError({
          fixtureId,
          message: error instanceof Error ? error.message : "사전 배당을 불러오지 못했습니다.",
        });
      })
      .finally(() => {
        if (!cancelled) setPreMatchOddsLoading(false);
      });
    return () => { cancelled = true; };
  }, [selected?.id]);

  useEffect(() => {
    let cancelled = false;
    setBetmanLoading(true);
    fetch("/api/betman-odds")
      .then(async (response) => {
        const payload = await response.json() as BetmanPayload;
        if (!response.ok) throw new Error(payload.error ?? "Betman 배당을 불러오지 못했습니다.");
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setBetmanRound(payload);
        setBetmanUrlInput(payload.sourceUrl ?? "");
        setBetmanNotice(null);
      })
      .catch((error) => {
        if (!cancelled) setBetmanNotice({ tone: "error", message: error instanceof Error ? error.message : "Betman 배당을 불러오지 못했습니다." });
      })
      .finally(() => {
        if (!cancelled) setBetmanLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function saveBetmanRound() {
    setBetmanSaving(true);
    setBetmanNotice(null);
    try {
      const response = await fetch("/api/betman-odds", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceUrl: betmanUrlInput }),
      });
      const payload = await response.json() as BetmanPayload;
      if (!response.ok) throw new Error(payload.error ?? "회차 URL을 저장하지 못했습니다.");
      setBetmanRound(payload);
      setBetmanUrlInput(payload.sourceUrl ?? betmanUrlInput);
      setBetmanNotice({ tone: "success", message: `회차 URL 저장 완료 · 축구 경기 ${payload.fixtures.length}개` });
    } catch (error) {
      setBetmanNotice({ tone: "error", message: error instanceof Error ? error.message : "회차 URL을 저장하지 못했습니다." });
    } finally {
      setBetmanSaving(false);
      setBetmanLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/market-predictions")
      .then(async (response) => {
        if (!response.ok) throw new Error("저장된 확률을 불러오지 못했습니다.");
        return response.json() as Promise<{ predictions?: SavedMarketPrediction[] }>;
      })
      .then((payload) => {
        if (cancelled) return;
        setRestorablePredictions(payload.predictions ?? []);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!betmanRound.gmTs || restorablePredictions.length === 0 || matches.length === 0) return;
    const restored: Record<string, string> = {};
    for (const prediction of restorablePredictions) {
      if (!prediction.betmanRound || !prediction.matchSeq || prediction.betmanRound !== betmanRound.gmTs) continue;
      const match = matches.find((candidate) => candidate.id === prediction.matchId);
      if (!match) continue;
      const fixture = findBetmanFixture(match, betmanRound.fixtures);
      const market = fixture?.markets.find((candidate) => candidate.matchSeq === prediction.matchSeq);
      if (!market) continue;
      const probabilities = savedProbabilitiesForMarket(prediction, {
        betmanRound: betmanRound.gmTs,
        matchSeq: market.matchSeq,
        optionLabels: market.options.map((option) => option.label),
      });
      if (!probabilities) continue;
      const rowKey = marketStateKey(prediction.matchId, prediction.betmanRound, prediction.matchSeq);
      probabilities.forEach((probability, optionIndex) => {
        restored[`${rowKey}-${optionIndex}`] = probability;
      });
    }
    setMarketProbabilities((current) => ({ ...restored, ...current }));
  }, [betmanRound, matches, restorablePredictions]);

  async function saveMarketPrediction(market: BetmanMarket, marketIndex: number) {
    if (!selected) return;
    if (!betmanRound.gmTs || !market.matchSeq) {
      setBetmanNotice({ tone: "error", message: "저장할 Betman 회차와 게임번호를 확인할 수 없습니다." });
      return;
    }
    const rowKey = marketStateKey(selected.id, betmanRound.gmTs, market.matchSeq);
    const probabilities = market.options.map((_, optionIndex) => marketProbabilities[`${rowKey}-${optionIndex}`] ?? "");
    if (probabilities.some((probability) => probability === "")) {
      setSaveStatuses((current) => ({ ...current, [rowKey]: { tone: "error", message: "모든 확률을 입력해 주세요." } }));
      return;
    }

    const probabilityValues = probabilities.map(Number);
    const probabilitySum = probabilityValues.reduce((sum, probability) => sum + probability, 0);
    if (Math.abs(probabilitySum - 1) > 0.001) {
      setSaveStatuses((current) => ({ ...current, [rowKey]: { tone: "error", message: `합계 ${probabilitySum.toFixed(3)} · 1.000 필요` } }));
      return;
    }

    setSavingRows((current) => ({ ...current, [rowKey]: true }));
    setSaveStatuses((current) => {
      const next = { ...current };
      delete next[rowKey];
      return next;
    });

    try {
      const response = await fetch("/api/market-predictions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          matchId: selected.id,
          matchDate: selected.date,
          kickoffTime: selected.time,
          homeTeam: selected.home,
          awayTeam: selected.away,
          marketIndex,
          marketType: market.type,
          marketCondition: market.condition,
          betmanRound: betmanRound.gmTs,
          matchSeq: market.matchSeq,
          options: market.options.map((option, optionIndex) => ({
            label: option.label,
            odds: Number(option.odds),
            probability: probabilityValues[optionIndex],
          })),
        }),
      });
      const payload = await response.json() as { error?: string; prediction?: { predictionKey: string } };
      if (!response.ok || !payload.prediction) throw new Error(payload.error ?? "저장하지 못했습니다.");
      setSaveStatuses((current) => ({ ...current, [rowKey]: { tone: "success", message: "저장 완료" } }));
    } catch (error) {
      setSaveStatuses((current) => ({ ...current, [rowKey]: { tone: "error", message: error instanceof Error ? error.message : "저장하지 못했습니다." } }));
    } finally {
      setSavingRows((current) => ({ ...current, [rowKey]: false }));
    }
  }

  async function loadSavedPredictions(from = savedFromDate, to = savedToDate) {
    if (hasUnsavedSavedSelections && !window.confirm("저장하지 않은 선택 변경이 있습니다. 변경을 버리고 다시 조회할까요?")) return;
    if (!from || !to) {
      setSavedNotice({ tone: "error", message: "시작일과 종료일을 입력해 주세요." });
      return;
    }
    if (from > to) {
      setSavedNotice({ tone: "error", message: "시작일은 종료일보다 늦을 수 없습니다." });
      return;
    }
    setSavedLoading(true);
    setSavedNotice(null);
    setSelectedPredictionKeys([]);
    try {
      const query = new URLSearchParams({ from, to });
      const response = await fetch(`/api/market-predictions?${query.toString()}`);
      const payload = await response.json() as { error?: string; predictions?: SavedMarketPrediction[] };
      if (!response.ok) throw new Error(payload.error ?? "저장 내역을 불러오지 못했습니다.");
      setSavedPredictions(payload.predictions ?? []);
      setSavedSelectionDrafts({});
    } catch (error) {
      setSavedNotice({ tone: "error", message: error instanceof Error ? error.message : "저장 내역을 불러오지 못했습니다." });
    } finally {
      setSavedLoading(false);
    }
  }

  function openSavedSection() {
    setSection("saved");
    void loadSavedPredictions();
  }

  function navigateSection(nextSection: "matches" | "standings" | "odds" | "saved") {
    if (section === "saved" && nextSection !== "saved" && hasUnsavedSavedSelections) {
      if (!window.confirm("저장하지 않은 선택 변경이 있습니다. 변경을 버리고 이동할까요?")) return;
      setSavedSelectionDrafts({});
    }
    setSection(nextSection);
  }

  function toggleSavedOption(prediction: SavedMarketPrediction, optionIndex: number) {
    if (!prediction.options[optionIndex]) return;
    setSavedSelectionDrafts((current) => {
      const currentSelection = Object.prototype.hasOwnProperty.call(current, prediction.predictionKey)
        ? current[prediction.predictionKey] ?? null
        : prediction.selectedOptionIndex;
      const nextSelection = togglePredictionOptionSelection(currentSelection, optionIndex);
      const next = { ...current };
      if (nextSelection === prediction.selectedOptionIndex) delete next[prediction.predictionKey];
      else next[prediction.predictionKey] = nextSelection;
      return next;
    });
    setSavedNotice(null);
  }

  async function saveSavedSelections() {
    const updates = changedPredictionSelections(savedPredictions, savedSelectionDrafts);
    if (updates.length === 0) return;
    setSavingSavedSelections(true);
    setSavedNotice(null);
    try {
      const response = await fetch("/api/market-predictions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      const payload = await response.json() as { error?: string; updated?: number };
      if (!response.ok || payload.updated !== updates.length) throw new Error(payload.error ?? "선택 상태를 저장하지 못했습니다.");
      const savedByKey = new Map(updates.map((update) => [update.predictionKey, update.selectedOptionIndex]));
      setSavedPredictions((current) => current.map((prediction) => savedByKey.has(prediction.predictionKey)
        ? { ...prediction, selectedOptionIndex: savedByKey.get(prediction.predictionKey) ?? null }
        : prediction));
      setSavedSelectionDrafts({});
      setSavedNotice({ tone: "success", message: `${updates.length}건의 선택을 저장했습니다.` });
    } catch (error) {
      setSavedNotice({ tone: "error", message: error instanceof Error ? error.message : "선택 상태를 저장하지 못했습니다." });
    } finally {
      setSavingSavedSelections(false);
    }
  }

  function togglePredictionSelection(predictionKey: string, checked: boolean) {
    setSelectedPredictionKeys((current) => checked
      ? current.includes(predictionKey) ? current : [...current, predictionKey]
      : current.filter((key) => key !== predictionKey));
  }

  async function deleteSelectedPredictions() {
    if (selectedPredictionKeys.length === 0) {
      setSavedNotice({ tone: "error", message: "삭제할 저장 내역을 선택해 주세요." });
      return;
    }
    if (!window.confirm(`선택한 ${selectedPredictionKeys.length}건을 삭제할까요?`)) return;
    setSavedLoading(true);
    setSavedNotice(null);
    try {
      const response = await fetch("/api/market-predictions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ predictionKeys: selectedPredictionKeys }),
      });
      const payload = await response.json() as { error?: string; deleted?: number };
      if (!response.ok) throw new Error(payload.error ?? "삭제하지 못했습니다.");
      const deletedKeys = new Set(selectedPredictionKeys);
      const deletedRecords = savedPredictions.filter((prediction) => deletedKeys.has(prediction.predictionKey));
      setSavedPredictions((current) => current.filter((prediction) => !deletedKeys.has(prediction.predictionKey)));
      setRestorablePredictions((current) => excludePredictionsByKey(current, deletedKeys));
      setMarketProbabilities((current) => {
        const next = { ...current };
        for (const prediction of deletedRecords) {
          if (!prediction.betmanRound || !prediction.matchSeq) continue;
          const rowKey = marketStateKey(prediction.matchId, prediction.betmanRound, prediction.matchSeq);
          prediction.options.forEach((_, optionIndex) => delete next[`${rowKey}-${optionIndex}`]);
        }
        return next;
      });
      setSelectedPredictionKeys([]);
      setSavedNotice({ tone: "success", message: `${payload.deleted ?? deletedRecords.length}건을 삭제했습니다.` });
    } catch (error) {
      setSavedNotice({ tone: "error", message: error instanceof Error ? error.message : "삭제하지 못했습니다." });
    } finally {
      setSavedLoading(false);
    }
  }

  function openMatchDetail(matchId: number, trigger: HTMLButtonElement) {
    lastDetailTriggerRef.current = trigger;
    setSelectedId(matchId);
  }

  function closeMatchDetail() {
    setSelectedId(0);
    requestAnimationFrame(() => lastDetailTriggerRef.current?.focus());
  }

  return (
    <main>
      <header className="site-header">
        <div className="header-inner">
          <button className="brand" onClick={() => navigateSection("matches")} aria-label="매치뷰 홈">
            <span className="brand-mark">M</span>
            <span><b>매치뷰</b><small>K1 · J1 GUIDE</small></span>
          </button>
          <nav className="desktop-nav" aria-label="주요 메뉴">
            <button className={section === "matches" ? "active" : ""} onClick={() => navigateSection("matches")}>경기</button>
            <button className={section === "standings" ? "active" : ""} onClick={() => navigateSection("standings")}>순위</button>
            <button className={section === "odds" ? "active" : ""} aria-label="배당기록 · Betman 마감게임 · D1 아카이브" onClick={() => navigateSection("odds")}>배당기록</button>
            <button className={section === "saved" ? "active" : ""} onClick={openSavedSection}>저장된경기</button>
          </nav>
          <div className="demo-pill"><span />{
            section === "matches" || section === "standings" ? `API-Football · ${seasonSummary}`
              : section === "odds" ? "Betman 마감게임 · D1 아카이브" : "D1 저장 데이터"
          }</div>
        </div>
      </header>

      <div className={`content-shell ${section === "matches" ? selected ? "detail-open" : "list-only" : ""}`}>
        {section === "saved" ? (
          <section className="saved-page">
            <div className="section-heading saved-heading">
              <div><p className="eyebrow">SAVED PREDICTIONS</p><h1>저장된경기</h1><p>입력한 확률과 배당, 기대수익을 저장일자 순으로 확인하세요.</p></div>
              <span>최신 입력일자 순</span>
            </div>

            <div className="saved-toolbar">
              <div className="date-filter saved-date-filter">
                <label><span>입력일자 From</span><input type="date" value={savedFromDate} onChange={(event) => setSavedFromDate(event.target.value)} /></label>
                <i>—</i>
                <label><span>입력일자 To</span><input type="date" value={savedToDate} onChange={(event) => setSavedToDate(event.target.value)} /></label>
              </div>
              <div className="saved-toolbar-actions">
                <button className="search-filter" type="button" disabled={savedLoading || savingSavedSelections} onClick={() => void loadSavedPredictions()}>{savedLoading ? "조회 중" : "조회"}</button>
                <button className="save-selections" type="button" disabled={!hasUnsavedSavedSelections || savedLoading || savingSavedSelections} onClick={() => void saveSavedSelections()}>{savingSavedSelections ? "저장 중" : "선택 저장"} <b>{pendingSavedSelections.length}</b></button>
                <button className="delete-saved" type="button" disabled={selectedPredictionKeys.length === 0 || savedLoading || savingSavedSelections} onClick={() => void deleteSelectedPredictions()}>선택 삭제 <b>{selectedPredictionKeys.length}</b></button>
              </div>
            </div>

            <div className="saved-result-meta">
              <p>조회 결과 <strong>{savedPredictions.length}</strong>건</p>
              {savedNotice && <span className={savedNotice.tone} role="status">{savedNotice.message}</span>}
            </div>

            <div className="saved-grid-wrap">
              <table className="saved-grid">
                <thead><tr>
                  <th><input type="checkbox" aria-label="저장 내역 전체 선택" checked={allSavedSelected} onChange={(event) => setSelectedPredictionKeys(event.target.checked ? savedPredictions.map((prediction) => prediction.predictionKey) : [])} /></th>
                  <th>입력일자</th><th>경기</th><th>경기일시</th><th>게임유형</th><th>사전조건</th><th>선택 1</th><th>선택 2</th><th>선택 3</th>
                </tr></thead>
                <tbody>
                  {savedPredictions.map((prediction) => <tr key={prediction.predictionKey}>
                    <td><input type="checkbox" aria-label={`${prediction.homeTeam} 대 ${prediction.awayTeam} ${prediction.marketType} 선택`} checked={selectedPredictionKeys.includes(prediction.predictionKey)} onChange={(event) => togglePredictionSelection(prediction.predictionKey, event.target.checked)} /></td>
                    <td><time>{formatSavedAt(prediction.savedAt)}</time></td>
                    <td><strong className="saved-match">{prediction.homeTeam}<small>vs</small>{prediction.awayTeam}</strong></td>
                    <td><time>{prediction.matchDate}<small>{prediction.kickoffTime}</small></time></td>
                    <td><strong>{prediction.marketType}</strong></td>
                    <td>{prediction.marketCondition}</td>
                    {[0, 1, 2].map((optionIndex) => {
                      const option = prediction.options[optionIndex];
                      const selectedOptionIndex = Object.prototype.hasOwnProperty.call(savedSelectionDrafts, prediction.predictionKey)
                        ? savedSelectionDrafts[prediction.predictionKey] ?? null
                        : prediction.selectedOptionIndex;
                      const selected = selectedOptionIndex === optionIndex;
                      const dirty = Object.prototype.hasOwnProperty.call(savedSelectionDrafts, prediction.predictionKey);
                      return <td className="saved-choice-cell" key={optionIndex}>{option ? <SavedOptionButton
                        matchLabel={`${prediction.homeTeam} 대 ${prediction.awayTeam}`}
                        option={option}
                        selected={selected}
                        dirty={dirty}
                        disabled={savedLoading || savingSavedSelections}
                        onToggle={() => toggleSavedOption(prediction, optionIndex)}
                      /> : <span className="saved-empty">—</span>}</td>;
                    })}
                  </tr>)}
                  {!savedLoading && savedPredictions.length === 0 && <tr><td className="saved-empty-row" colSpan={9}>조회 기간에 저장된 경기가 없습니다.</td></tr>}
                  {savedLoading && <tr><td className="saved-empty-row" colSpan={9}>저장 내역을 불러오는 중입니다.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        ) : section === "odds" ? (
          <OddsHistory />
        ) : section === "standings" ? (
          <section className="standings-page">
            <div className="standings-tabs" aria-label="리그 순위 선택">
              {(["K1", "J1"] as const).map((leagueCode) => <button
                type="button"
                key={leagueCode}
                className={standingLeague === leagueCode ? "active" : ""}
                aria-pressed={standingLeague === leagueCode}
                onClick={() => setStandingLeague(leagueCode)}
              >{leagueCode === "K1" ? "K리그1" : "J리그1"}</button>)}
            </div>
            <div className="section-heading"><div><p className="eyebrow">API-FOOTBALL · {selectedLeagueSeason ?? "현재"} SEASON</p><h1>{selectedLeagueName} 순위</h1></div><span>{fixtureMeta ? `${formatDate(fixtureMeta.statsThrough)} 종료 경기 기준` : "현재 시즌 기준"}</span></div>
            {fixturesLoading ? <div className="empty-state">순위 데이터를 불러오는 중입니다.</div> : fixturesError ? <div className="empty-state">{fixturesError}</div> : leagueErrors[standingLeague] ? <div className="empty-state">{leagueErrors[standingLeague]}</div> : (
              <div className="standings-card">
                <div className="standing-head"><span>순위 / 팀</span><span>경기</span><span>승점</span><span>득실</span><span>득점</span><span>실점</span></div>
                {selectedStandings.map((standing) => <div className="standing-row" key={standing.teamId}>
                  <span><b className={standing.rank <= 6 ? "rank-top" : standing.rank >= 10 ? "rank-bottom" : ""}>{standing.rank}</b><Crest code={standing.teamCode} logo={standing.logo} />{standing.team}</span>
                  <span>{standing.played}</span><strong>{standing.points}</strong><span>{standing.goalDifference > 0 ? `+${standing.goalDifference}` : standing.goalDifference}</span><span>{standing.goalsFor}</span><span>{standing.goalsAgainst}</span>
                </div>)}
                {selectedStandings.length === 0 && <div className="empty-state">표시할 순위 데이터가 없습니다.</div>}
              </div>
            )}
            <p className="odds-footnote">{fixtureMeta ? `${formatDate(fixtureMeta.today)} 경기 시작 전 시점입니다.` : "현재 경기 시작 전 시점입니다."} 승점, 다득점, 득실차, 다승 순으로 정렬했습니다.</p>
          </section>
        ) : fixturesLoading ? (
          <section className="fixtures-state empty-state" data-testid="fixture-loading">
            <p className="eyebrow">API-FOOTBALL</p>
            <h1>K리그1과 J리그1 경기 일정을 불러오는 중입니다</h1>
            <p>한국시간 오늘부터 14일 이내 예정 경기를 준비하고 있습니다.</p>
          </section>
        ) : fixturesError ? (
          <section className="fixtures-state empty-state">
            <p className="eyebrow">API-FOOTBALL</p>
            <h1>경기 일정을 불러오지 못했습니다</h1>
            <p>{fixturesError}</p>
            <button className="search-filter" type="button" onClick={() => window.location.reload()}>다시 시도</button>
          </section>
        ) : matches.length === 0 ? (
          <section className="fixtures-state empty-state">
            <LeagueErrorsWarning leagueErrors={leagueErrors} />
            <h1>조회 기간에 예정 경기가 없습니다</h1>
            <p>{fixtureMeta ? `${formatDate(fixtureMeta.today)}부터 ${formatDate(fixtureMeta.rangeEnd)}까지의 경기 일정입니다.` : "한국시간 오늘부터 14일 이내의 경기 일정입니다."}</p>
          </section>
        ) : (
          <>
            <section className="match-column">
              <div className="intro-row">
                <div><p className="eyebrow">API-FOOTBALL · K1 + J1</p><h1>예정 경기</h1></div>
                <span className="sync-time">{fixtureMeta ? `${formatDate(fixtureMeta.today)} ~ ${formatDate(fixtureMeta.rangeEnd)}` : "오늘부터 14일"}</span>
              </div>
              <div className="betman-source-card">
                <div className="betman-source-copy">
                  <b>Betman 프로토 회차 URL</b>
                  <small>{betmanRound.configured ? `저장된 회차 ${betmanRound.gmTs} · 수정 후 저장하면 기존 URL이 교체됩니다.` : "프로토 승부식 구매투표지 URL을 한 번 저장하면 각 경기 배당을 자동으로 연결합니다."}</small>
                </div>
                <div className="betman-source-form">
                  <input
                    type="url"
                    value={betmanUrlInput}
                    placeholder="https://www.betman.co.kr/main/mainPage/gamebuy/gameSlip.do?gmId=G101&gmTs=..."
                    aria-label="Betman 프로토 회차 URL"
                    onChange={(event) => setBetmanUrlInput(event.target.value)}
                  />
                  <button type="button" disabled={betmanSaving || !betmanUrlInput.trim()} onClick={() => void saveBetmanRound()}>{betmanSaving ? "확인 중" : "저장"}</button>
                </div>
                {betmanNotice && <span className={`betman-source-notice ${betmanNotice.tone}`} role="status">{betmanNotice.message}</span>}
              </div>
              <div className="filters">
                <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>2주 전체</button>
                <button className={filter === "weekend" ? "active" : ""} onClick={() => setFilter("weekend")}>주말 경기</button>
              </div>
              <LeagueErrorsWarning leagueErrors={leagueErrors} />
              <div className="match-list">
                {displayedMatches.map((match, index, array) => (
                  <div className="match-group" key={match.id}>
                    {(index === 0 || array[index - 1].dateLabel !== match.dateLabel) && <div className="date-divider"><b>{match.dateLabel}</b></div>}
                    <article className={`match-card ${selectedId === match.id ? "selected" : ""}`}>
                      <span className={`league-badge league-${match.leagueCode.toLowerCase()}`}>{match.leagueName} · {match.round}</span>
                      <button className="match-main" onClick={(event) => openMatchDetail(match.id, event.currentTarget)}>
                        <div className="team team-home"><div><strong>{match.home}</strong><small>{match.homeRank}위 · {match.homeRecord}</small></div><Crest code={match.homeCode} logo={match.homeLogo} /></div>
                        <div className="kickoff"><b>{match.time}</b><small>경기 예정</small></div>
                        <div className="team"><Crest code={match.awayCode} logo={match.awayLogo} /><div><strong>{match.away}</strong><small>{match.awayRank}위 · {match.awayRecord}</small></div></div>
                        <div className="card-form"><Form values={match.homeForm} /><span>최근 5경기</span><Form values={match.awayForm} /></div>
                      </button>
                      <button className="detail-link" onClick={(event) => openMatchDetail(match.id, event.currentTarget)}>분석 보기 <span>→</span></button>
                    </article>
                  </div>
                ))}
              </div>
            </section>

            {selected && <aside className="analysis-panel" id="analysis" ref={analysisPanelRef} tabIndex={-1} aria-label="경기 상세 분석">
              <div className="panel-topline"><span>{selected.dateShort} · {selected.time} · {selected.round}</span><b>경기 예정</b><AnalysisCloseButton onClose={closeMatchDetail} /></div>
              <div className="versus">
                <div><Crest code={selected.homeCode} logo={selected.homeLogo} large /><strong>{selected.home}</strong><small>{selected.homeRank}위</small></div>
                <span><b>VS</b><small>{selected.venue}</small></span>
                <div><Crest code={selected.awayCode} logo={selected.awayLogo} large /><strong>{selected.away}</strong><small>{selected.awayRank}위</small></div>
              </div>
              {betmanLoading ? (
                <div className="betman-unavailable" role="status"><span>BETMAN</span><b>배당 정보를 확인하고 있습니다</b><small>저장된 프로토 회차를 조회하는 중입니다.</small></div>
              ) : betmanMarkets.length === 0 ? (
                <div className="betman-unavailable"><span>BETMAN</span><b>현재 배당이 확정되지 않았습니다</b><small>{betmanRound.configured ? "저장된 회차에 이 경기의 배당 정보가 없습니다." : "경기 목록 위에서 프로토 회차 URL을 먼저 저장해 주세요."}</small></div>
              ) : (
                <section className="betman-odds-card" aria-labelledby="betman-odds-title">
                  <div className="betman-odds-heading">
                    <div>
                      <span className="betman-live-badge">BETMAN</span>
                      <h2 id="betman-odds-title">Betman 프로토 승부식 배당</h2>
                    </div>
                    <small>{betmanRound.gmTs ? `회차 ${betmanRound.gmTs}` : "저장 회차"} · {betmanMarkets.length}개 게임유형</small>
                  </div>
                  <div className="betman-odds-wrap">
                    <table className="betman-odds-table">
                      <thead>
                        <tr><th>게임유형</th><th>선택 1</th><th>선택 2</th><th>선택 3</th></tr>
                      </thead>
                      <tbody>
                        {betmanMarkets.map((market, marketIndex) => {
                        const rowKey = marketStateKey(selected.id, betmanRound.gmTs ?? "unknown", market.matchSeq);
                        const probabilityValues = market.options.map((_, optionIndex) => marketProbabilities[`${rowKey}-${optionIndex}`] ?? "");
                        const enteredValues = probabilityValues.filter((value) => value !== "").map(Number);
                        const probabilitySum = enteredValues.reduce((sum, value) => sum + value, 0);
                        const isComplete = enteredValues.length === market.options.length;
                        const isValidSum = isComplete && Math.abs(probabilitySum - 1) <= 0.001;
                        const saveStatus = saveStatuses[rowKey];
                        return <tr key={market.matchSeq || `${market.type}-${market.condition}`} data-testid="betman-odds-row">
                          <th scope="row">
                            <strong>{market.type}</strong>
                            <small>{market.matchSeq ? `No. ${market.matchSeq}` : ""}{market.matchSeq && market.condition ? " · " : ""}{market.condition}</small>
                            <span className={`probability-sum ${isValidSum ? "valid" : isComplete ? "invalid" : ""}`}>합계 {probabilitySum.toFixed(3)}</span>
                            <button
                              type="button"
                              className="market-save"
                              data-testid="market-save-button"
                              aria-label={`${market.type} ${market.condition} 확률 저장`}
                              disabled={savingRows[rowKey]}
                              onClick={() => void saveMarketPrediction(market, marketIndex)}
                            >{savingRows[rowKey] ? "저장 중" : "저장"}</button>
                            {saveStatus && <em className={`market-save-status ${saveStatus.tone}`} role="status">{saveStatus.message}</em>}
                          </th>
                          {[0, 1, 2].map((optionIndex) => {
                            const option = market.options[optionIndex];
                            const probabilityKey = `${rowKey}-${optionIndex}`;
                            const probability = marketProbabilities[probabilityKey] ?? "";
                            const expectedReturn = option ? getExpectedReturn(probability, option.odds) : null;
                            return <td key={optionIndex} className={!option ? "empty-option" : ""}>
                              {option ? <div className="market-option">
                                <div className="market-price"><span>{option.label}</span><b>{option.odds}</b></div>
                                <label className="probability-input">
                                  <span>확률</span>
                                  <input
                                    type="number"
                                    inputMode="decimal"
                                    min="0"
                                    max="1"
                                    step="0.01"
                                    placeholder="0.00"
                                    value={probability}
                                    data-testid="probability-input"
                                    aria-label={`${market.type} ${market.condition} ${option.label} 확률`}
                                    onChange={(event) => {
                                      const nextValue = event.target.value;
                                      const numericValue = Number(nextValue);
                                      if (nextValue === "" || (Number.isFinite(numericValue) && numericValue >= 0 && numericValue <= 1)) {
                                        setMarketProbabilities((current) => ({ ...current, [probabilityKey]: nextValue }));
                                        setSaveStatuses((current) => {
                                          const next = { ...current };
                                          delete next[rowKey];
                                          return next;
                                        });
                                      }
                                    }}
                                  />
                                </label>
                                <div className="expected-return">
                                  <span>기대수익</span>
                                  <b className={expectedReturn === null ? "" : expectedReturn >= 0 ? "positive" : "negative"}>
                                    {expectedReturn === null ? "—" : `${expectedReturn >= 0 ? "+" : ""}${expectedReturn.toFixed(3)}`}
                                  </b>
                                </div>
                              </div> : <span>—</span>}
                            </td>;
                          })}
                        </tr>;
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p>기대수익 = 입력확률 × 배당률 − 1 · 배당은 저장된 Betman 프로토 회차의 현재 조회값입니다.</p>
                </section>
              )}
              <section className="prematch-odds-card" aria-labelledby="prematch-odds-title">
                <div className="prematch-odds-heading">
                  <div><span className="api-odds-badge">API</span><h2 id="prematch-odds-title">API-Football 사전 배당</h2></div>
                  {currentPreMatchOdds?.fetchedAt && <small>{new Date(currentPreMatchOdds.fetchedAt).toLocaleString("ko-KR")} 조회</small>}
                </div>
                {currentPreMatchOddsLoading || preMatchOddsLoading && !currentPreMatchOdds ? (
                  <div className="prematch-odds-state" role="status">사전 배당을 불러오는 중입니다.</div>
                ) : currentPreMatchOddsError ? (
                  <div className="prematch-odds-state error" role="alert">{currentPreMatchOddsError}</div>
                ) : !currentPreMatchOdds || currentPreMatchOdds.bookmakers.length === 0 ? (
                  <div className="prematch-odds-state">현재 제공된 사전 배당이 없습니다.</div>
                ) : (
                  <PreMatchBookmakers bookmakers={currentPreMatchOdds.bookmakers} />
                )}
              </section>
              <div className="status-note"><span>i</span> 일정·전적과 사전 배당은 API-Football, 확률 저장 배당은 Betman 회차 데이터입니다.</div>

              <section className="panel-section prediction-section" aria-labelledby="prediction-title">
                <div className="panel-title prediction-title-row">
                  <h2 id="prediction-title">경기 예측</h2>
                  <span>API-FOOTBALL PREDICTIONS</span>
                </div>
                {predictionLoading ? (
                  <div className="prediction-state">예측 데이터를 분석하고 있습니다.</div>
                ) : currentPredictionError ? (
                  <div className="prediction-state prediction-error">{currentPredictionError}</div>
                ) : !currentApiPrediction ? (
                  <div className="prediction-state">현재 제공된 예측 데이터가 없습니다.</div>
                ) : (
                  <>
                    <div className="prediction-highlight">
                      <span>우세 시나리오</span>
                      <strong>{predictionHeadline(currentApiPrediction, selected.home, selected.away)}</strong>
                      <small>{underOverLabel(currentApiPrediction.underOver)} 조합 예측</small>
                    </div>
                    <div className="prediction-probabilities" aria-label="승무패 예측 확률">
                      {[
                        ["홈승", selected.home, currentApiPrediction.percent.home, "home"],
                        ["무승부", "DRAW", currentApiPrediction.percent.draw, "draw"],
                        ["원정승", selected.away, currentApiPrediction.percent.away, "away"],
                      ].map(([label, team, value, tone]) => <div className={`prediction-probability prediction-${tone}`} key={tone}>
                        <span>{label}<small>{team}</small></span>
                        <strong>{value}</strong>
                        <i><b style={{ width: `${percentNumber(value)}%` }} /></i>
                      </div>)}
                    </div>
                    <div className="prediction-insights">
                      <div><span>득점 기준 예측</span><strong>{underOverLabel(currentApiPrediction.underOver)}</strong></div>
                      <div><span>팀 종합 비교</span><strong>{selected.home} {currentApiPrediction.comparison.home} · {selected.away} {currentApiPrediction.comparison.away}</strong></div>
                    </div>
                    <p className="prediction-disclaimer">API-Football의 통계 기반 예측이며 실제 경기 결과를 보장하지 않습니다.</p>
                  </>
                )}
              </section>

              <section className="panel-section">
                <div className="panel-title"><h2>최근 흐름</h2><span>최근 5경기</span></div>
                <div className="flow-compare">
                  <div><b>{selected.home}</b><Form values={selected.homeForm} /><strong>승점 {selected.homeRecentPoints}</strong></div>
                  <div><b>{selected.away}</b><Form values={selected.awayForm} /><strong>승점 {selected.awayRecentPoints}</strong></div>
                </div>
              </section>

              <section className="panel-section">
                <div className="panel-title"><h2>시즌 비교</h2><span>{fixtureMeta ? `${formatDate(fixtureMeta.statsThrough)} 종료 경기 기준` : "현재 시즌 기준"}</span></div>
                <div className="compare-grid">
                  <div><strong>{selected.homeRank}<small>위</small></strong><span>현재 순위</span><strong>{selected.awayRank}<small>위</small></strong></div>
                  <div><strong>{selected.homeGoals}</strong><span>득점 / 실점</span><strong>{selected.awayGoals}</strong></div>
                  <div><strong>{homeGoalsPerGame}</strong><span>경기당 득점</span><strong>{awayGoalsPerGame}</strong></div>
                  <div><strong>{homeConcededPerGame}</strong><span>경기당 실점</span><strong>{awayConcededPerGame}</strong></div>
                </div>
              </section>

              <section className="panel-section">
                <div className="panel-title"><h2>최근 경기</h2><span>리그 경기만</span></div>
                <div className="recent-columns">
                  {[selected.recentHome, selected.recentAway].map((items, column) => <div key={column}>
                    <b>{column === 0 ? selected.home : selected.away}</b>
                    {items.map((item, idx) => <div className="recent-row" key={`${item[0]}-${idx}`}><i className={`form form-${item[3].toLowerCase()}`}>{item[3]}</i><span>{item[0]} <small>{item[2]}</small></span><strong>{item[1]}</strong></div>)}
                  </div>)}
                </div>
              </section>

              <section className="panel-section h2h">
                <div className="panel-title"><h2>최근 맞대결</h2><span>최근 {currentHeadToHead?.length ?? 0}경기 · 홈팀 기준</span></div>
                <div className="h2h-list" aria-live="polite">
                  {currentHeadToHead?.map(([date, selectedHomeWasHome, score, result]) => {
                    const leftTeam = selectedHomeWasHome ? selected.home : selected.away;
                    const rightTeam = selectedHomeWasHome ? selected.away : selected.home;
                    const [leftTeamClass, rightTeamClass] = headToHeadWinnerClasses(selectedHomeWasHome, result);
                    return <div className="h2h-row" key={date}>
                      <time>{date.slice(2).replaceAll(".", ".")}</time>
                      <i className={`form form-${result.toLowerCase()}`}>{result}</i>
                      <span className={leftTeamClass}>{leftTeam}</span>
                      <strong>{score}</strong>
                      <span className={rightTeamClass}>{rightTeam}</span>
                    </div>;
                  })}
                  {currentHeadToHeadLoading ? (
                    <div className="empty-state">최근 맞대결을 불러오는 중입니다.</div>
                  ) : currentHeadToHeadError ? (
                    <div className="empty-state">최근 맞대결을 불러오지 못했습니다.</div>
                  ) : currentHeadToHead?.length === 0 ? (
                    <div className="empty-state">최근 맞대결 기록이 없습니다.</div>
                  ) : null}
                </div>
              </section>
              <p className="data-footnote">일정과 전적은 API-Football 현재 시즌 데이터이며, 배당은 사용자가 저장한 Betman 프로토 회차에서 조회합니다.{fixtureMeta ? ` · API 조회 ${new Date(fixtureMeta.fetchedAt).toLocaleString("ko-KR")}` : ""}</p>
            </aside>}
          </>
        )}
      </div>

      <nav className="mobile-nav" aria-label="모바일 메뉴">
        <button className={section === "matches" ? "active" : ""} onClick={() => navigateSection("matches")}><span>●</span>경기</button>
        <button className={section === "standings" ? "active" : ""} onClick={() => navigateSection("standings")}><span>≡</span>순위</button>
        <button className={section === "odds" ? "active" : ""} onClick={() => navigateSection("odds")}><span>▦</span>배당기록</button>
        <button className={section === "saved" ? "active" : ""} onClick={openSavedSection}><span>▣</span>저장된경기</button>
      </nav>
    </main>
  );
}
