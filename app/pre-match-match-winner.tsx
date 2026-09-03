import { matchWinnerOdds, type PreMatchOddsPayload } from "./lib/pre-match-odds";

export function PreMatchBookmakers({
  bookmakers,
}: {
  bookmakers: PreMatchOddsPayload["bookmakers"];
}) {
  return (
    <div className="prematch-odds-wrap">
      <table className="prematch-match-winner-table">
        <thead><tr><th>북메이커</th><th>Home / Draw / Away</th></tr></thead>
        <tbody>
          {bookmakers.map((bookmaker) => {
            const odds = matchWinnerOdds(bookmaker);
            return (
              <tr key={bookmaker.id}>
                <th scope="row">{bookmaker.name}</th>
                {odds ? (
                  <td className="match-winner-odds"><strong>{odds.home.toFixed(2)} / {odds.draw.toFixed(2)} / {odds.away.toFixed(2)}</strong></td>
                ) : <td className="match-winner-unavailable">미제공</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
