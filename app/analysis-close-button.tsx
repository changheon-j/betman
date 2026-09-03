export function AnalysisCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="analysis-close" aria-label="상세분석 닫기" onClick={onClose}>
      ×
    </button>
  );
}
