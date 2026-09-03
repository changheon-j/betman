import { createAnonymousSession, createBetmanClosedAdapter } from "../app/lib/betman-history-adapter.ts";
import { parseClosedRoundDocument } from "../app/lib/betman-history-parser.ts";
import { betmanHistorySmokeSummary } from "../app/lib/betman-history-smoke.ts";

function koreanCalendarDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: "year" | "month" | "day") => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function shiftDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${String(shifted.getUTCFullYear()).padStart(4, "0")}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const to = koreanCalendarDate(new Date());
  const from = shiftDays(to, -6);
  const session = await createAnonymousSession();
  const adapter = createBetmanClosedAdapter();
  const [newest] = await adapter.discoverRounds(from, to, session);
  if (!newest) {
    console.log(JSON.stringify(betmanHistorySmokeSummary(null)));
    return;
  }
  const document = await adapter.fetchRound(newest, session);
  const parsed = parseClosedRoundDocument(document);
  console.log(JSON.stringify(betmanHistorySmokeSummary(parsed)));
}

main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
});
