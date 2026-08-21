import { ImageIcon } from "./icons";

interface ImagePreviewFallbackProps {
  isHeic: boolean;
  compact?: boolean;
}

export function ImagePreviewFallback({
  isHeic,
  compact = false,
}: ImagePreviewFallbackProps) {
  return (
    <div
      className={`preview-failed${compact ? " preview-failed-compact" : ""}`}
      role="status"
    >
      <ImageIcon />
      <strong>{isHeic ? "HEIC 相片已選擇" : "相片預覽暫時未能顯示"}</strong>
      <span>
        {isHeic
          ? "此瀏覽器暫時未能顯示預覽，但仍可進行分析。"
          : "預覽未能顯示，但仍可嘗試分析；如分析失敗再更換。"}
      </span>
    </div>
  );
}
