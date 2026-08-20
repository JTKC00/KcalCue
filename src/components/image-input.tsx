"use client";

import { useRef } from "react";
import { copy } from "@/content/zh-HK";
import {
  ArrowRightIcon,
  CameraIcon,
  ShieldIcon,
  UploadIcon,
} from "./icons";
import {
  imageMimeLabel,
  isHeicFile,
} from "@/lib/providers/food-vision/types";
import { ImagePreviewFallback } from "./image-preview-fallback";

interface ImageInputProps {
  file: File | null;
  previewUrl: string | null;
  demoMode: boolean;
  previewFailed: boolean;
  onFileSelected: (file: File | null) => void;
  onPreviewError: () => void;
  onAnalyze: () => void;
}

const ACCEPTED_IMAGES =
  "image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif";

export function ImageInput({
  file,
  previewUrl,
  demoMode,
  previewFailed,
  onFileSelected,
  onPreviewError,
  onAnalyze,
}: ImageInputProps) {
  const cameraInput = useRef<HTMLInputElement>(null);
  const libraryInput = useRef<HTMLInputElement>(null);

  const receiveFile = (input: HTMLInputElement) => {
    onFileSelected(input.files?.[0] ?? null);
    input.value = "";
  };

  return (
    <section className="upload-card" aria-labelledby="upload-title">
      <input
        ref={cameraInput}
        hidden
        type="file"
        accept={ACCEPTED_IMAGES}
        capture="environment"
        onChange={(event) => receiveFile(event.currentTarget)}
      />
      <input
        ref={libraryInput}
        hidden
        type="file"
        accept={ACCEPTED_IMAGES}
        onChange={(event) => receiveFile(event.currentTarget)}
      />

      {!file || !previewUrl ? (
        <>
          <div className="upload-illustration" aria-hidden="true">
            <span className="plate-ring" />
            <span className="plate-food plate-food-one" />
            <span className="plate-food plate-food-two" />
            <span className="plate-food plate-food-three" />
            <CameraIcon className="floating-camera" />
          </div>
          <div className="upload-copy">
            <p className="eyebrow">由一張清楚餐點相開始</p>
            <h2 id="upload-title">影相或者揀相</h2>
            <p>最好由上而下影，確保整個餐碟同食物份量都睇得清。</p>
          </div>
          <div className="upload-actions">
            <button
              className="button button-primary button-large"
              type="button"
              onClick={() => cameraInput.current?.click()}
            >
              <CameraIcon />
              {copy.takePhoto}
            </button>
            <button
              className="button button-secondary button-large"
              type="button"
              onClick={() => libraryInput.current?.click()}
            >
              <UploadIcon />
              {copy.choosePhoto}
            </button>
          </div>
          <div className="upload-footnote">
            <ShieldIcon />
            <span>{demoMode ? copy.demoPrivacy : copy.privacyShort}</span>
          </div>
        </>
      ) : (
        <>
          <div className="selected-image-frame">
            {!previewFailed ? (
              // A local object URL is the appropriate preview source here.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt="已選擇的餐點相片預覽"
                onError={onPreviewError}
              />
            ) : (
              <ImagePreviewFallback
                isHeic={isHeicFile(file.name, file.type)}
              />
            )}
            <div className="image-status-badge">
              <span className="status-dot" />
              {previewFailed
                ? "已選擇，可分析"
                : demoMode
                  ? "只作示範預覽"
                  : "準備分析"}
            </div>
          </div>
          <div className="selected-image-content">
            <div>
              <p className="eyebrow">{copy.selectedTitle}</p>
              <h2 id="upload-title">{file.name}</h2>
              <p>{copy.selectedBody}</p>
            </div>
            <div className="selected-meta">
              <span>{(file.size / 1024 / 1024).toFixed(1)} MB</span>
              <span>{imageMimeLabel(file.name, file.type)}</span>
            </div>
            <div className="selected-actions">
              <button
                className="button button-primary button-large"
                type="button"
                onClick={onAnalyze}
              >
                {copy.analyze}
                <ArrowRightIcon />
              </button>
              <button
                className="button button-secondary"
                type="button"
                onClick={() => libraryInput.current?.click()}
              >
                {copy.replacePhoto}
              </button>
              <button
                className="button button-ghost"
                type="button"
                onClick={() => onFileSelected(null)}
              >
                {copy.removePhoto}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
