import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ImageInput } from "./image-input";

describe("ImageInput", () => {
  it("keeps HEIC analysis available when the browser cannot preview it", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "meal.heic", {
      type: "image/heic",
    });

    render(
      <ImageInput
        file={file}
        previewUrl="blob:meal"
        demoMode={false}
        previewFailed
        onFileSelected={vi.fn()}
        onPreviewError={vi.fn()}
        onAnalyze={vi.fn()}
      />,
    );

    expect(screen.getByText("HEIC 相片已選擇")).toBeInTheDocument();
    expect(
      screen.getByText("此瀏覽器暫時未能顯示預覽，但仍可進行分析。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /開始分析/ })).toBeEnabled();
    expect(screen.getByRole("heading", { name: file.name })).toBeInTheDocument();
  });

  it("advertises both MIME types and extensions to the file picker", () => {
    render(
      <ImageInput
        file={null}
        previewUrl={null}
        demoMode
        previewFailed={false}
        onFileSelected={vi.fn()}
        onPreviewError={vi.fn()}
        onAnalyze={vi.fn()}
      />,
    );

    const fileInputs = document.querySelectorAll<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(fileInputs).toHaveLength(2);
    expect(fileInputs[0]?.accept).toContain("image/heic");
    expect(fileInputs[0]?.accept).toContain(".heif");
  });
});
