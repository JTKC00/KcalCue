"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { copy, errorCopy } from "@/content/zh-HK";
import { foodAnalysisSchema, type FoodAnalysis, type PortionUnit } from "@/lib/domain/food-analysis";
import {
  applyPortionPreset,
  convertPortionUnit,
  createEditableFoodItems,
  type EditableFoodItem,
  type PortionPreset,
} from "@/lib/domain/editable-meal";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import {
  canReuseNutritionMatchForNameEdit,
  enrichUnresolvedMatches,
  resolveNutritionMatchWithFallback,
} from "@/lib/nutrition/client";
import { normalizeFoodName } from "@/lib/nutrition/canonical";
import type { NutritionMatch } from "@/lib/nutrition/types";
import {
  inferSupportedImageMimeType,
  isHeicFile,
  type FoodVisionProvider,
} from "@/lib/providers/food-vision/types";
import { ImageInput } from "./image-input";
import { ImagePreviewFallback } from "./image-preview-fallback";
import {
  AlertIcon,
  CameraIcon,
  CheckIcon,
  ImageIcon,
  ShieldIcon,
  SparklesIcon,
} from "./icons";
import { ResultView } from "./result-view";

type AppStage = "input" | "analyzing" | "result" | "unable" | "error";
type ProviderMode = FoodVisionProvider["mode"];
type AppMode = ProviderMode | "manual";

interface AppError {
  code: string;
  title: string;
  body: string;
}

interface AnalyzeResponse {
  analysis?: unknown;
  mode?: unknown;
  error?: { code?: unknown };
}

interface KcalCueAppProps {
  initialProviderMode: ProviderMode;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function getError(code: string): AppError {
  const message = errorCopy[code] ?? errorCopy.unknown;
  return { code, ...message };
}

function createManualItem(): EditableFoodItem {
  const id = `manual-${crypto.randomUUID()}`;
  return {
    id,
    displayName: "",
    normalizedName: "",
    identityLevel: "ingredient",
    portionMin: 100,
    portionMax: 150,
    originalPortionMin: 100,
    originalPortionMax: 150,
    unit: "g",
    recognitionConfidence: 0.5,
    portionConfidence: 0.5,
    uncertaintyReasons: ["手動輸入仍需要你確認實際份量。"],
    nutritionMatch: null,
  };
}

function normalizedNameForMatch(name: string, match: NutritionMatch | null): string {
  if (!match?.profile) return name;
  return match.profile.source.provider === "usda-fdc"
    ? name
    : match.profile.canonicalName;
}

function SiteHeader({ mode }: { mode: AppMode }) {
  const label = mode === "demo" ? "Demo Mode" : mode === "manual" ? "手動模式" : "AI Live";
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="brand" href="/" aria-label="KcalCue 首頁">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span>{copy.brand}</span>
        </Link>
        <div className="header-actions">
          <span className={`header-mode ${mode === "demo" ? "is-demo" : "is-live"}`}>
            <span />
            {label}
          </span>
          <a className="privacy-link" href="#privacy">
            <ShieldIcon />
            私隱
          </a>
        </div>
      </div>
    </header>
  );
}

function ModeBanner({ demoMode }: { demoMode: boolean }) {
  if (!demoMode) return null;
  return (
    <div className="mode-banner" role="status">
      <div className="mode-banner-icon">
        <SparklesIcon />
      </div>
      <div>
        <strong>{copy.demoTitle}</strong>
        <span>{copy.demoBody}</span>
      </div>
    </div>
  );
}

function HeroCopy() {
  return (
    <div className="hero-copy">
      <div className="principle-pill">
        <CheckIcon />
        {copy.rangePrinciple}
      </div>
      <h1>
        一張相，睇清一餐嘅<span>大概範圍。</span>
      </h1>
      <p>{copy.heroBody}</p>
      <div className="trust-row" aria-label="產品特點">
        <span>卡路里範圍</span>
        <span>主要營養素</span>
        <span>可隨時修正</span>
      </div>
    </div>
  );
}

function HowItWorks() {
  return (
    <section className="how-section" aria-labelledby="how-title">
      <div className="section-intro">
        <p className="eyebrow">簡單三步</p>
        <h2 id="how-title">由相片去到可修正嘅估算</h2>
      </div>
      <div className="step-grid">
        <article>
          <span className="step-number">01</span>
          <CameraIcon />
          <h3>影低餐點</h3>
          <p>由上而下影，盡量見到整個餐碟。</p>
        </article>
        <article>
          <span className="step-number">02</span>
          <SparklesIcon />
          <h3>辨認同估算</h3>
          <p>分開可見、估算同未知資料，唔會扮精準。</p>
        </article>
        <article>
          <span className="step-number">03</span>
          <CheckIcon />
          <h3>修正即時更新</h3>
          <p>改食物、份量或單位，無需再次呼叫 AI。</p>
        </article>
      </div>
    </section>
  );
}

function LoadingView({
  previewUrl,
  previewFailed,
  isHeic,
  demoMode,
}: {
  previewUrl: string | null;
  previewFailed: boolean;
  isHeic: boolean;
  demoMode: boolean;
}) {
  return (
    <main className="state-page" id="main-content">
      <section className="loading-card" aria-live="polite" aria-busy="true">
        <div className="loading-visual">
          {previewFailed ? (
            <ImagePreviewFallback isHeic={isHeic} />
          ) : previewUrl ? (
            // A local object URL is the appropriate preview source here.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt="正在分析的餐點相片" />
          ) : (
            <ImageIcon />
          )}
          <div className="scan-line" aria-hidden="true" />
        </div>
        <div className="loading-content">
          <div className="loading-orbit" aria-hidden="true">
            <SparklesIcon />
          </div>
          <p className="eyebrow">{demoMode ? "準備示範結果" : "AI 圖片分析"}</p>
          <h1>{copy.loadingTitle}</h1>
          <p>{copy.loadingBody}</p>
          <ol className="loading-steps">
            <li className="active"><span />辨認可見食物</li>
            <li><span />估算份量範圍</li>
            <li><span />配對營養參考資料</li>
          </ol>
        </div>
      </section>
    </main>
  );
}

interface RecoveryViewProps {
  kind: "unable" | "error";
  error: AppError | null;
  previewUrl: string | null;
  previewFailed: boolean;
  isHeic: boolean;
  onRetry: () => void;
  onReplace: () => void;
  onManual: () => void;
  onDemo: () => void;
  showDemoFallback: boolean;
}

function RecoveryView({
  kind,
  error,
  previewUrl,
  previewFailed,
  isHeic,
  onRetry,
  onReplace,
  onManual,
  onDemo,
  showDemoFallback,
}: RecoveryViewProps) {
  const title = kind === "unable" ? copy.unableTitle : error?.title ?? errorCopy.unknown.title;
  const body = kind === "unable" ? copy.unableBody : error?.body ?? errorCopy.unknown.body;

  return (
    <main className="state-page" id="main-content">
      <section className="recovery-card" role={kind === "error" ? "alert" : "status"}>
        {previewFailed ? (
          <ImagePreviewFallback isHeic={isHeic} />
        ) : previewUrl ? (
          <div className="recovery-photo">
            {/* A local object URL is the appropriate preview source here. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="未能完成分析的餐點相片" />
          </div>
        ) : null}
        <div className="recovery-content">
          <div className="recovery-icon">
            <AlertIcon />
          </div>
          <p className="eyebrow">{kind === "unable" ? "需要多少少資料" : "可以重新處理"}</p>
          <h1>{title}</h1>
          <p>{body}</p>
          <div className="recovery-actions">
            <button className="button button-primary" type="button" onClick={onRetry}>
              {copy.retry}
            </button>
            <button className="button button-secondary" type="button" onClick={onReplace}>
              {copy.replacePhoto}
            </button>
            <button className="button button-secondary" type="button" onClick={onManual}>
              {copy.manualInput}
            </button>
            {showDemoFallback ? (
              <button className="button button-ghost" type="button" onClick={onDemo}>
                {copy.useDemo}
              </button>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer" id="privacy">
      <div>
        <Link className="brand footer-brand" href="/">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          {copy.brand}
        </Link>
        <p>精準呈現不確定性，而唔係假裝精準。</p>
      </div>
      <div className="footer-note">
        <ShieldIcon />
        <p>{copy.privacyShort} 結果只供一般參考，並非醫療建議。</p>
      </div>
    </footer>
  );
}

export function KcalCueApp({ initialProviderMode }: KcalCueAppProps) {
  const [stage, setStage] = useState<AppStage>("input");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [analysis, setAnalysis] = useState<FoodAnalysis | null>(null);
  const [items, setItems] = useState<EditableFoodItem[]>([]);
  const [activeMode, setActiveMode] = useState<AppMode>(
    initialProviderMode,
  );
  const [appError, setAppError] = useState<AppError | null>(null);
  const nutritionProvider = useMemo(() => new LocalNutritionProvider(), []);
  const nameEditTimers = useRef(new Map<string, number>());

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [stage]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    const timers = nameEditTimers.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  const handleFileSelected = (nextFile: File | null) => {
    setAppError(null);
    setPreviewFailed(false);
    setAnalysis(null);
    setItems([]);

    if (!nextFile) {
      setFile(null);
      setPreviewUrl(null);
      setStage("input");
      return;
    }
    if (nextFile.size === 0 || !inferSupportedImageMimeType(nextFile.name, nextFile.type)) {
      setFile(null);
      setPreviewUrl(null);
      setAppError(getError("invalid_file"));
      setStage("input");
      return;
    }
    if (nextFile.size > MAX_IMAGE_BYTES) {
      setFile(null);
      setPreviewUrl(null);
      setAppError(getError("file_too_large"));
      setStage("input");
      return;
    }

    try {
      setPreviewUrl(URL.createObjectURL(nextFile));
    } catch {
      setFile(null);
      setPreviewUrl(null);
      setPreviewFailed(true);
      setAppError(getError("image_read_failed"));
      setStage("input");
      return;
    }

    setFile(nextFile);
    setStage("input");
  };

  const analyze = async (forceDemo = false) => {
    if (!file) {
      setAppError(getError("missing_image"));
      setStage("input");
      return;
    }

    const demoRequest = initialProviderMode === "demo" || forceDemo;
    setActiveMode(demoRequest ? "demo" : "live");
    setStage("analyzing");
    setAppError(null);

    try {
      const formData = new FormData();
      if (demoRequest) {
        formData.set("mode", "demo");
      } else {
        formData.set("image", file);
      }

      const request = fetch("/api/analyze", {
        method: "POST",
        body: formData,
      });
      const [response] = await Promise.all([
        request,
        demoRequest
          ? new Promise<void>((resolve) => window.setTimeout(resolve, 650))
          : Promise.resolve(),
      ]);
      const body = (await response.json()) as AnalyzeResponse;

      if (!response.ok) {
        const code = typeof body.error?.code === "string" ? body.error.code : "unknown";
        throw getError(code);
      }

      const parsed = foodAnalysisSchema.safeParse(body.analysis);
      if (!parsed.success) throw getError("invalid_response");

      const responseMode = body.mode === "live" ? "live" : "demo";
      setActiveMode(responseMode);
      setAnalysis(parsed.data);

      if (parsed.data.analysisStatus === "unable_to_identify") {
        setItems([]);
        setStage("unable");
      } else {
        const localMatches = parsed.data.foods.map((food) =>
          nutritionProvider.resolve(food),
        );
        const matches =
          responseMode === "live"
            ? await enrichUnresolvedMatches(parsed.data.foods, localMatches)
            : localMatches;
        setItems(createEditableFoodItems(parsed.data.foods, matches));
        setStage("result");
      }
    } catch (error) {
      const safeError =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? getError(error.code)
          : getError("unknown");
      setAppError(safeError);
      setStage("error");
    }
  };

  const reset = () => {
    for (const timer of nameEditTimers.current.values()) {
      window.clearTimeout(timer);
    }
    nameEditTimers.current.clear();
    setStage("input");
    setFile(null);
    setPreviewUrl(null);
    setPreviewFailed(false);
    setAnalysis(null);
    setItems([]);
    setAppError(null);
    setActiveMode(initialProviderMode);
  };

  const startManual = () => {
    setAnalysis(null);
    setItems([createManualItem()]);
    setActiveMode("manual");
    setStage("result");
  };

  const updateItem = (
    id: string,
    update: (item: EditableFoodItem) => EditableFoodItem,
  ) => {
    setItems((current) => current.map((item) => (item.id === id ? update(item) : item)));
  };

  const handleNameChange = (id: string, name: string) => {
    const previousTimer = nameEditTimers.current.get(id);
    if (previousTimer !== undefined) {
      window.clearTimeout(previousTimer);
      nameEditTimers.current.delete(id);
    }

    const currentItem = items.find((item) => item.id === id);
    if (!currentItem) return;

    const nextFood = {
      ...currentItem,
      displayName: name,
      normalizedName:
        normalizeFoodName(currentItem.displayName) === normalizeFoodName(name)
          ? currentItem.normalizedName
          : name,
    };
    const cachedMatch = canReuseNutritionMatchForNameEdit(
      currentItem,
      nextFood,
      currentItem.nutritionMatch,
    )
      ? currentItem.nutritionMatch
      : null;
    const localMatch = name.trim() ? nutritionProvider.resolve(nextFood) : null;
    const match = cachedMatch ?? localMatch;

    updateItem(id, () => ({
      ...nextFood,
      normalizedName: normalizedNameForMatch(name, match),
      nutritionMatch: match,
    }));

    if (
      activeMode !== "live" ||
      !localMatch ||
      localMatch.includedInTotal ||
      cachedMatch
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      void resolveNutritionMatchWithFallback(nextFood, localMatch).then(
        (resolvedMatch) => {
          updateItem(id, (item) => {
            if (item.displayName !== name) return item;
            return {
              ...item,
              normalizedName: normalizedNameForMatch(name, resolvedMatch),
              nutritionMatch: resolvedMatch,
            };
          });
        },
      );
      nameEditTimers.current.delete(id);
    }, 350);
    nameEditTimers.current.set(id, timer);
  };

  const handlePortionChange = (
    id: string,
    field: "portionMin" | "portionMax",
    value: number,
  ) => {
    if (!Number.isFinite(value) || value <= 0) return;
    updateItem(id, (item) => {
      if (field === "portionMin") {
        const portionMax = Math.max(value, item.portionMax);
        return {
          ...item,
          portionMin: value,
          portionMax,
          originalPortionMin: value,
          originalPortionMax: portionMax,
        };
      }
      const portionMin = Math.min(value, item.portionMin);
      return {
        ...item,
        portionMin,
        portionMax: value,
        originalPortionMin: portionMin,
        originalPortionMax: value,
      };
    });
  };

  const handleUnitChange = (id: string, unit: PortionUnit) => {
    updateItem(id, (item) => {
      const profile =
        item.nutritionMatch?.profile ??
        nutritionProvider.findByName(item.normalizedName) ??
        nutritionProvider.findByName(item.displayName);
      return convertPortionUnit(item, unit, profile);
    });
  };

  const handlePreset = (id: string, preset: PortionPreset) => {
    updateItem(id, (item) => applyPortionPreset(item, preset));
  };

  return (
    <div className="app-shell">
      <SiteHeader mode={activeMode} />
      <ModeBanner demoMode={activeMode === "demo" && stage !== "result"} />

      {stage === "input" ? (
        <main className="home-page" id="main-content">
          {appError ? (
            <div className="global-alert" role="alert">
              <AlertIcon />
              <div><strong>{appError.title}</strong><span>{appError.body}</span></div>
            </div>
          ) : null}
          <section className="hero-section">
            <HeroCopy />
            <ImageInput
              file={file}
              previewUrl={previewUrl}
              demoMode={activeMode === "demo"}
              previewFailed={previewFailed}
              onFileSelected={handleFileSelected}
              onPreviewError={() => {
                setPreviewFailed(true);
              }}
              onAnalyze={() => void analyze()}
            />
          </section>
          <HowItWorks />
        </main>
      ) : null}

      {stage === "analyzing" ? (
        <LoadingView
          previewUrl={previewUrl}
          previewFailed={previewFailed}
          isHeic={isHeicFile(file?.name ?? "", file?.type)}
          demoMode={activeMode === "demo"}
        />
      ) : null}

      {stage === "unable" || stage === "error" ? (
        <RecoveryView
          kind={stage}
          error={appError}
          previewUrl={previewUrl}
          previewFailed={previewFailed}
          isHeic={isHeicFile(file?.name ?? "", file?.type)}
          onRetry={() => void analyze()}
          onReplace={reset}
          onManual={startManual}
          onDemo={() => void analyze(true)}
          showDemoFallback={initialProviderMode === "live"}
        />
      ) : null}

      {stage === "result" ? (
        <ResultView
          analysis={analysis}
          items={items}
          mode={activeMode}
          previewUrl={previewUrl}
          previewFailed={previewFailed}
          isHeic={isHeicFile(file?.name ?? "", file?.type)}
          onNameChange={handleNameChange}
          onPortionChange={handlePortionChange}
          onUnitChange={handleUnitChange}
          onPreset={handlePreset}
          onDelete={(id) => setItems((current) => current.filter((item) => item.id !== id))}
          onAdd={() => setItems((current) => [...current, createManualItem()])}
          onReset={reset}
        />
      ) : null}

      <SiteFooter />
    </div>
  );
}
