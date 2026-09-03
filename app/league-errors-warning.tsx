import type { LeagueCode } from "./lib/leagues";

const leagueNames: Record<LeagueCode, string> = {
  K1: "K리그1",
  J1: "J리그1",
};

export function LeagueErrorsWarning({
  leagueErrors,
}: {
  leagueErrors: Partial<Record<LeagueCode, string>>;
}) {
  const failures = (Object.keys(leagueNames) as LeagueCode[])
    .flatMap((leagueCode) => leagueErrors[leagueCode]
      ? [{ leagueCode, message: leagueErrors[leagueCode] as string }]
      : []);

  if (failures.length === 0) return null;

  return <aside className="league-errors-warning" role="status" aria-live="polite" aria-atomic="true">
    <strong>일부 리그 데이터를 불러오지 못했습니다.</strong>
    <ul>
      {failures.map(({ leagueCode, message }) => <li key={leagueCode}>
        <b>{leagueNames[leagueCode]}</b>: {message}
      </li>)}
    </ul>
    <p>성공한 리그의 경기 일정은 계속 표시합니다.</p>
  </aside>;
}
