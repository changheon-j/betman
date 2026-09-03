import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalysisCloseButton } from "../app/analysis-close-button.tsx";

test("renders an accessible native button with the close glyph", () => {
  const html = renderToStaticMarkup(createElement(AnalysisCloseButton, { onClose: () => undefined }));

  assert.match(html, /<button type="button" class="analysis-close" aria-label="상세분석 닫기">×<\/button>/);
});
