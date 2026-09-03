import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PreMatchBookmakers } from "../app/pre-match-match-winner.tsx";

test("renders every bookmaker in API order with fixed Match Winner odds and unavailable rows", () => {
  const html = renderToStaticMarkup(createElement(PreMatchBookmakers, {
    bookmakers: [
      {
        id: 1,
        name: "1xBet",
        markets: [{
          id: 1,
          name: "Match Winner",
          values: [
            { label: "Away", odds: 1.9 },
            { label: "Home", odds: 4.1 },
            { label: "Draw", odds: 3.35 },
          ],
        }],
      },
      {
        id: 2,
        name: "Bet365",
        markets: [{
          id: 1,
          name: "Match Winner",
          values: [
            { label: "Home", odds: 2.1 },
            { label: "Away", odds: 3.2 },
          ],
        }],
      },
    ],
  }));

  assert.match(html, /<thead><tr><th>북메이커<\/th><th>Home \/ Draw \/ Away<\/th><\/tr><\/thead>/);
  assert.match(html, /<tbody><tr><th scope="row">1xBet<\/th><td class="match-winner-odds"><strong>4\.10 \/ 3\.35 \/ 1\.90<\/strong><\/td><\/tr><tr><th scope="row">Bet365<\/th><td class="match-winner-unavailable">미제공<\/td><\/tr><\/tbody>/);
  assert.equal((html.match(/<tbody>/g) ?? []).length, 1);
  assert.equal(html.includes("<select"), false);
  assert.equal(html.includes("<option"), false);
});
