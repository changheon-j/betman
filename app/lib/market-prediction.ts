export type StableMarketIdentity = {
  matchId: number;
  betmanRound: string;
  matchSeq: string;
};

export type ParsedPredictionOption = {
  label: string;
  odds: number;
  probability: number;
  expectedReturn: number;
};

export type ParsedPredictionInput = StableMarketIdentity & {
  matchDate: string;
  kickoffTime: string;
  homeTeam: string;
  awayTeam: string;
  marketIndex: number;
  marketType: string;
  marketCondition: string;
  options: ParsedPredictionOption[];
  probabilitySum: number;
};

export type PredictionSelectionUpdate = {
  predictionKey: string;
  selectedOptionIndex: number | null;
};

export type PredictionSelectionRepository = {
  readSelectionTargets(predictionKeys: string[]): Promise<Array<{ predictionKey: string; optionCount: number }>>;
  writeSelections(updates: PredictionSelectionUpdate[]): Promise<number>;
};

const PROBABILITY_TOLERANCE = 0.001;
const MAX_TEXT_LENGTH = 120;
const STABLE_PREDICTION_COLUMNS = ["betman_round", "match_seq"] as const;
const PREDICTION_SELECTION_COLUMNS = ["selected_option_index"] as const;

export function missingStablePredictionColumns(rows: Array<{ name?: unknown }>) {
  const existing = new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === "string"));
  return STABLE_PREDICTION_COLUMNS.filter((column) => !existing.has(column));
}

export function missingPredictionSelectionColumns(rows: Array<{ name?: unknown }>) {
  const existing = new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === "string"));
  return PREDICTION_SELECTION_COLUMNS.filter((column) => !existing.has(column));
}

function requiredText(value: unknown, field: string, maximum = MAX_TEXT_LENGTH) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const text = value.trim();
  if (text.length > maximum) throw new Error(`${field} is too long`);
  return text;
}

function optionalText(value: unknown, field: string, maximum = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (text.length > maximum) throw new Error(`${field} is too long`);
  return text;
}

function safeInteger(value: unknown, field: string, minimum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${field} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function digits(value: unknown, field: string) {
  const result = requiredText(value, field, 32);
  if (!/^\d+$/.test(result)) throw new Error(`${field} must contain digits only`);
  return result;
}

function strictIsoDate(value: unknown, field: string) {
  const result = requiredText(value, field, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result);
  if (!match) throw new Error(`${field} must use YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${field} must be a real calendar date`);
  }
  return result;
}

export function isoDateBoundary(value: string, endOfDay: boolean) {
  const date = strictIsoDate(value, "date");
  return new Date(`${date}T${endOfDay ? "23:59:59.999" : "00:00:00"}+09:00`).toISOString();
}

function strictTime(value: unknown, field: string) {
  const result = requiredText(value, field, 5);
  const match = /^(\d{2}):(\d{2})$/.exec(result);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error(`${field} must use a valid HH:mm time`);
  }
  return result;
}

export function makePredictionKey(input: StableMarketIdentity) {
  const matchId = safeInteger(input.matchId, "matchId", 1);
  const betmanRound = digits(input.betmanRound, "betmanRound");
  const matchSeq = digits(input.matchSeq, "matchSeq");
  return `fixture:${matchId}|round:${betmanRound}|game:${matchSeq}`;
}

export function savedProbabilitiesForMarket(
  saved: {
    betmanRound?: string | null;
    matchSeq?: string | null;
    options: Array<{ label: string; probability: number }>;
  },
  current: { betmanRound: string; matchSeq: string; optionLabels: string[] },
) {
  if (!saved.betmanRound || !saved.matchSeq) return null;
  if (saved.betmanRound !== current.betmanRound || saved.matchSeq !== current.matchSeq) return null;
  if (saved.options.length !== current.optionLabels.length) return null;
  if (saved.options.some((option, index) => option.label !== current.optionLabels[index])) return null;
  return saved.options.map((option) => String(option.probability));
}

export function excludePredictionsByKey<T extends { predictionKey: string }>(
  records: T[],
  deletedKeys: Set<string>,
) {
  return records.filter((record) => !deletedKeys.has(record.predictionKey));
}

export function parsePredictionKeys(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("predictionKeys must contain at least one entry");
  }
  if (value.length > 100) throw new Error("predictionKeys cannot contain more than 100 entries");

  return [...new Set(value.map((key) => requiredText(key, "predictionKey", 512)))];
}

export function togglePredictionSelection(current: number | null, clicked: number): number | null {
  if (!Number.isInteger(clicked) || clicked < 0 || clicked > 2) throw new Error("selectedOptionIndex must be 0, 1, or 2");
  return current === clicked ? null : clicked;
}

export function changedPredictionSelections(
  predictions: Array<{ predictionKey: string; selectedOptionIndex: number | null }>,
  drafts: Record<string, number | null>,
): PredictionSelectionUpdate[] {
  return predictions.flatMap((prediction) => {
    if (!Object.prototype.hasOwnProperty.call(drafts, prediction.predictionKey)) return [];
    const selectedOptionIndex = drafts[prediction.predictionKey] ?? null;
    return selectedOptionIndex === prediction.selectedOptionIndex
      ? []
      : [{ predictionKey: prediction.predictionKey, selectedOptionIndex }];
  });
}

export function parsePredictionSelectionUpdates(value: unknown): PredictionSelectionUpdate[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("selection payload must be an object");
  const updates = (value as Record<string, unknown>).updates;
  if (!Array.isArray(updates) || updates.length === 0) throw new Error("updates must contain at least one entry");
  if (updates.length > 100) throw new Error("updates cannot contain more than 100 entries");
  const keys = new Set<string>();
  return updates.map((rawUpdate) => {
    if (!rawUpdate || typeof rawUpdate !== "object" || Array.isArray(rawUpdate)) throw new Error("selection update must be an object");
    const update = rawUpdate as Record<string, unknown>;
    const predictionKey = requiredText(update.predictionKey, "predictionKey", 512);
    if (keys.has(predictionKey)) throw new Error("predictionKey must not contain duplicate entries");
    keys.add(predictionKey);
    const selectedOptionIndex = update.selectedOptionIndex;
    if (selectedOptionIndex !== null && (!Number.isInteger(selectedOptionIndex) || (selectedOptionIndex as number) < 0 || (selectedOptionIndex as number) > 2)) {
      throw new Error("selectedOptionIndex must be 0, 1, 2, or null");
    }
    return { predictionKey, selectedOptionIndex: selectedOptionIndex as number | null };
  });
}

export async function savePredictionSelections(value: unknown, repository: PredictionSelectionRepository): Promise<{ updated: number }> {
  const updates = parsePredictionSelectionUpdates(value);
  const targets = await repository.readSelectionTargets(updates.map(({ predictionKey }) => predictionKey));
  const targetByKey = new Map(targets.map((target) => [target.predictionKey, target]));
  for (const update of updates) {
    const target = targetByKey.get(update.predictionKey);
    if (!target) throw new Error(`prediction not found: ${update.predictionKey}`);
    if (!Number.isInteger(target.optionCount) || target.optionCount < 2 || target.optionCount > 3) {
      throw new Error(`stored prediction has an invalid option range: ${update.predictionKey}`);
    }
    if (update.selectedOptionIndex !== null && update.selectedOptionIndex >= target.optionCount) {
      throw new Error(`selectedOptionIndex is outside the option range: ${update.predictionKey}`);
    }
  }
  const updated = await repository.writeSelections(updates);
  if (updated !== updates.length) throw new Error("some prediction selections were not updated");
  return { updated };
}

export function parsePredictionInput(value: unknown): ParsedPredictionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("prediction payload must be an object");
  const input = value as Record<string, unknown>;
  const matchId = safeInteger(input.matchId, "matchId", 1);
  const marketIndex = safeInteger(input.marketIndex, "marketIndex", 0);
  const betmanRound = digits(input.betmanRound, "betmanRound");
  const matchSeq = digits(input.matchSeq, "matchSeq");
  const matchDate = strictIsoDate(input.matchDate, "matchDate");
  const kickoffTime = strictTime(input.kickoffTime, "kickoffTime");
  const homeTeam = requiredText(input.homeTeam, "homeTeam");
  const awayTeam = requiredText(input.awayTeam, "awayTeam");
  const marketType = requiredText(input.marketType, "marketType");
  const marketCondition = optionalText(input.marketCondition, "marketCondition");
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 3) {
    throw new Error("options must contain two or three entries");
  }

  const labels = new Set<string>();
  const options = input.options.map((rawOption) => {
    if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) throw new Error("option must be an object");
    const option = rawOption as Record<string, unknown>;
    const label = requiredText(option.label, "option label", 40);
    if (labels.has(label)) throw new Error("option label must be unique");
    labels.add(label);
    if (typeof option.odds !== "number" || !Number.isFinite(option.odds) || option.odds <= 0) {
      throw new Error("option odds must be a positive number");
    }
    if (typeof option.probability !== "number" || !Number.isFinite(option.probability) || option.probability < 0 || option.probability > 1) {
      throw new Error("option probability must be a number from 0 to 1");
    }
    return {
      label,
      odds: option.odds,
      probability: option.probability,
      expectedReturn: option.probability * option.odds - 1,
    };
  });
  const probabilitySum = options.reduce((sum, option) => sum + option.probability, 0);
  if (Math.abs(probabilitySum - 1) > PROBABILITY_TOLERANCE) {
    throw new Error(`probability sum must be 1; received ${probabilitySum.toFixed(3)}`);
  }

  return {
    matchId,
    matchDate,
    kickoffTime,
    homeTeam,
    awayTeam,
    marketIndex,
    marketType,
    marketCondition,
    betmanRound,
    matchSeq,
    options,
    probabilitySum,
  };
}
