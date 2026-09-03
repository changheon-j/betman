import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type TestProps = {
  matchLabel: string;
  option: { label: string; odds: number; probability: number; expectedReturn: number };
  selected: boolean;
  dirty: boolean;
  disabled: boolean;
  onToggle: () => void;
};

test("선택된 저장 경기 옵션을 주황색 단일 선택 버튼으로 표시한다", async () => {
  let loadedModule: null | { SavedOptionButton?: (props: TestProps) => unknown } = null;
  try {
    loadedModule = await import("../app/saved-option-button.tsx");
  } catch {
    // RED: the component does not exist yet.
  }
  assert.equal(typeof loadedModule?.SavedOptionButton, "function");

  const html = renderToStaticMarkup(createElement(loadedModule!.SavedOptionButton! as never, {
    matchLabel: "광주 FC 대 인천 유나이티드",
    option: { label: "무", odds: 3.15, probability: 0.35, expectedReturn: 0.1025 },
    selected: true,
    dirty: true,
    disabled: false,
    onToggle() {},
  }));
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /saved-option-button selected dirty/);
  assert.match(html, /광주 FC 대 인천 유나이티드 무 선택 해제/);
});
