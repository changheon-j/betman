type SavedOptionButtonProps = {
  matchLabel: string;
  option: { label: string; odds: number; probability: number; expectedReturn: number };
  selected: boolean;
  dirty: boolean;
  disabled: boolean;
  onToggle: () => void;
};

export function SavedOptionButton({
  matchLabel,
  option,
  selected,
  dirty,
  disabled,
  onToggle,
}: SavedOptionButtonProps) {
  return <button
    type="button"
    className={`saved-option-button${selected ? " selected" : ""}${dirty ? " dirty" : ""}`}
    aria-pressed={selected}
    aria-label={`${matchLabel} ${option.label} 선택${selected ? " 해제" : ""}`}
    disabled={disabled}
    onClick={onToggle}
  ><span className="saved-option">
    <strong>{option.label}</strong>
    <span>배당 {option.odds.toFixed(2)}</span>
    <span>확률 {option.probability.toFixed(3)}</span>
    <b className={option.expectedReturn >= 0 ? "positive" : "negative"}>기대 {option.expectedReturn >= 0 ? "+" : ""}{option.expectedReturn.toFixed(3)}</b>
  </span></button>;
}
