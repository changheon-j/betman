export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const isNonEmptyString = (value) =>
  typeof value === "string" && value.trim().length > 0;

export const isIsoDate = (value) => {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

export const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

export function percentNumber(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?%$/.test(value.trim())) {
    return Number.NaN;
  }
  return Number(value.replace("%", ""));
}
