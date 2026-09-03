import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LeagueErrorsWarning } from "../app/league-errors-warning.tsx";

test("renders an accessible partial-league warning without hiding successful schedules", () => {
  const html = renderToStaticMarkup(createElement(LeagueErrorsWarning, {
    leagueErrors: { J1: "standings unavailable" },
  }));

  assert.match(html, /role="status"/);
  assert.match(html, /J리그1/);
  assert.match(html, /standings unavailable/);
  assert.match(html, /성공한 리그의 경기 일정은 계속 표시합니다/);
});

test("renders nothing when every league succeeds", () => {
  assert.equal(renderToStaticMarkup(createElement(LeagueErrorsWarning, { leagueErrors: {} })), "");
});
