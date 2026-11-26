"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { copy, errorCopy } from "@/content/zh-HK";
import { foodAnalysisSchema, type FoodAnalysis, type PortionUnit } from "@/lib/domain/food-analysis";
import {
  applyPortionPreset,
  assignEntrySource,
  convertPortionUnit,
  createEditableFoodItems,
  hasKnownPortion,
  renameFoodItem,
  type EditableFoodItem,
  type PortionPreset,
} from "@/lib/domain/editable-meal";
import { preparePhotoMilkAnalysis } from "@/lib/domain/photo-milk-analysis";
import { contradictoryDairyMilkLabel, mealPlantMilkContext, photoGenericMilkNeedsConfirmation, type MealPlantMilkContext } from "@/lib/nutrition/canonical";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { PHOTO_GENERIC_MILK_CONFIRMATION_REASON, PHOTO_MILK_OTHER_REASON, PLANT_MILK_CONTRADICTION_REASON } from "@/lib/nutrition/negative-rules";
import { PHOTO_MILK_CHOICES, type PhotoMilkChoiceId } from "@/lib/nutrition/photo-milk";
import {
  canReuseNutritionMatchForNameEdit,
  enrichUnresolvedMatches,
  needsServerCatalogCheck,
  resolveNutritionMatchWithFallback,
} from "@/lib/nutrition/client";
import { CATALOG_PROFILE_ID_PREFIX } from "@/lib/nutrition/catalog-entry";
import type { NutritionMatch } from "@/lib/nutrition/types";
import {
  DEMO_ANALYZE_DELAY_MS,
  analyzeAbortOutcome,
  loadingStepClass,
} from "@/lib/client/analyze-session";
import { DemoFoodVisionProvider } from "@/lib/providers/food-vision/demo";
import { OPENAI_HTTP_TIMEOUT_MS } from "@/lib/providers/food-vision/timeout";
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
import { authorizedFetch } from "@/lib/firebase/client";
import type { MealDraft } from "@/lib/meals/types";
import {
  readAnalysisProvenance,
  type AnalysisProvenance,
  type AnalysisProvenanceMetadata,
} from "@/lib/domain/analysis-provenance";

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
  analysisProvenance?: unknown;
  mode?: unknown;
  error?: { code?: unknown };
}

interface KcalCueAppProps {
  initialProviderMode: ProviderMode;
  initialDraft?: MealDraft;
  calorieCorrection?: MealDraft["calorieCorrection"];
  mealNote?: string | null;
  onDraftChange?: (change: Pick<MealDraft, "items" | "analysis" | "analysisProvenance" | "mode">, file: File | null) => void;
  onNutritionPendingChange?: (pending: boolean) => void;
  onExit?: () => void;
  onNewMeal?: () => void;
  manual?: boolean;
  onPhotoSelected?: (file: File | null) => void;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Give the server's 12-second partial-result deadline time to reach the client.
const NUTRITION_ENRICH_TIMEOUT_MS = 15_000;

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

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
    entrySource: "manual",
  };
}

function normalizedNameForMatch(name: string, match: NutritionMatch | null): string {
  if (!match?.profile) return name;
  return match.profile.source.provider === "usda-fdc" ||
    match.profile.id.startsWith(CATALOG_PROFILE_ID_PREFIX)
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
      <h1>
        一張相，睇清一餐嘅<span>大概範圍。</span>
      </h1>
      <p>{copy.heroBody}</p>
      <div className="principle-pill">
        <CheckIcon />
        {copy.rangePrinciple}
      </div>
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
        <h2 id="how-title">由相片去到可修正嘅估算</h2>
        <p className="subhead">簡單三步</p>
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
  onCancel,
}: {
  previewUrl: string | null;
  previewFailed: boolean;
  isHeic: boolean;
  demoMode: boolean;
  onCancel: () => void;
}) {
  const step = 0;

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
          <h1>{copy.loadingTitle}</h1>
          <p className="subhead">{demoMode ? "準備示範結果" : "AI 圖片分析"}</p>
          <p>{copy.loadingBody}</p>
          <p className={loadingStepClass(step, 0)}>等候 AI 圖片分析完成；營養資料會在結果頁繼續補查。</p>
          <div className="loading-actions">
            <button className="button button-secondary" type="button" onClick={onCancel}>
              {copy.cancelAnalyze}
            </button>
          </div>
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
          <h1>{title}</h1>
          <p className="subhead">{kind === "unable" ? "需要多少少資料" : "可以重新處理"}</p>
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

function reapplyPlantMilkGuard(
  items: EditableFoodItem[],
  context: MealPlantMilkContext,
  provider: LocalNutritionProvider,
): EditableFoodItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (!hasKnownPortion(item) || !item.displayName.trim()) return item;
    const guarded = contradictoryDairyMilkLabel(item, context);
    const wasGuarded = item.nutritionMatch?.reasons[0] === PLANT_MILK_CONTRADICTION_REASON;
    if (!guarded && !wasGuarded) return item;
    const match = provider.resolve(item, context);
    if (
      item.nutritionMatch?.includedInTotal === match.includedInTotal &&
      item.nutritionMatch?.profile?.id === match.profile?.id &&
      item.nutritionMatch?.reasons[0] === match.reasons[0]
    ) return item;
    changed = true;
    return { ...item, nutritionMatch: match };
  });
  return changed ? next : items;
}

function reapplyPhotoMilkGuard(
  items: EditableFoodItem[],
  context: MealPlantMilkContext,
  provider: LocalNutritionProvider,
): EditableFoodItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (!hasKnownPortion(item) || !item.displayName.trim()) return item;
    const needs = photoGenericMilkNeedsConfirmation(item, context);
    const was = item.nutritionMatch?.reasons[0] === PHOTO_GENERIC_MILK_CONFIRMATION_REASON;
    if (!needs && !was) return item;
    const match = provider.resolve(item, context);
    if (
      item.nutritionMatch?.includedInTotal === match.includedInTotal &&
      item.nutritionMatch?.profile?.id === match.profile?.id &&
      item.nutritionMatch?.reasons[0] === match.reasons[0]
    ) return item;
    changed = true;
    return { ...item, nutritionMatch: match };
  });
  return changed ? next : items;
}

export function KcalCueApp({ initialProviderMode, initialDraft, calorieCorrection, mealNote, onDraftChange, onNutritionPendingChange, onExit, onNewMeal, manual, onPhotoSelected }: KcalCueAppProps) {
  const [stage, setStage] = useState<AppStage>(initialDraft?.items.length || manual ? "result" : "input");
  const [file, setFile] = useState<File | null>(() => initialDraft?.photo && !initialDraft.items.length ? new File([initialDraft.photo], "餐點.jpg", { type: "image/jpeg" }) : null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [analysis, setAnalysis] = useState<FoodAnalysis | null>(initialDraft?.analysis ?? null);
  const [analysisProvenance, setAnalysisProvenance] = useState<AnalysisProvenance | null>(() =>
    initialDraft?.analysis ? readAnalysisProvenance(initialDraft.analysisProvenance, initialDraft.mode) : null);
  const [items, setItems] = useState<EditableFoodItem[]>(() => assignEntrySource(
    initialDraft?.items.length ? initialDraft.items : manual ? [createManualItem()] : [],
    initialDraft?.analysis ?? null,
  ));
  const [activeMode, setActiveMode] = useState<AppMode>(
    initialDraft?.items.length ? initialDraft.mode : manual ? "manual" : initialProviderMode,
  );
  const [appError, setAppError] = useState<AppError | null>(null);
  const [nutritionPending, setNutritionPending] = useState(false);
  const [pendingEditLookups, setPendingEditLookups] = useState(0);
  const nutritionProvider = useMemo(() => new LocalNutritionProvider(), []);
  const originalFoods = useMemo(
    () => new Map(createEditableFoodItems(analysis?.foods ?? []).map(food => [food.id, food])),
    [analysis],
  );
  const nameEditTimers = useRef(new Map<string, number>());
  const nameEditRevisions = useRef(new Map<string, number>());
  const activeLookupKeysRef = useRef(new Set<string>());
  const noteLookupTimerRef = useRef<number | null>(null);
  const noteLookupRevisionRef = useRef(0);
  const prevMealNoteRef = useRef<string | null>(mealNote ?? null);
  const itemsRef = useRef<EditableFoodItem[]>(items);
  const analyzeAbortRef = useRef<AbortController | null>(null);
  const editAbortRef = useRef(new AbortController());
  const mealContextRef = useRef<MealPlantMilkContext>({});
  const plantMilkContext = useMemo(
    () => mealPlantMilkContext({ analysis, mealNote }),
    [analysis, mealNote],
  );
  const guardedItems = useMemo(
    () => stage === "result"
      ? reapplyPhotoMilkGuard(
        reapplyPlantMilkGuard(items, plantMilkContext, nutritionProvider),
        plantMilkContext,
        nutritionProvider,
      )
      : items,
    [stage, items, plantMilkContext, nutritionProvider],
  );
  const effectiveNutritionPending = nutritionPending || pendingEditLookups > 0;
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    mealContextRef.current = plantMilkContext;
  }, [plantMilkContext]);
  useEffect(() => {
    onNutritionPendingChange?.(effectiveNutritionPending);
  }, [effectiveNutritionPending, onNutritionPendingChange]);
  useEffect(() => {
    return () => {
      onNutritionPendingChange?.(false);
    };
  }, [onNutritionPendingChange]);
  useLayoutEffect(() => {
    if (stage === "result") onDraftChange?.({ items: guardedItems, analysis, analysisProvenance, mode: activeMode }, file);
  }, [stage, guardedItems, analysis, analysisProvenance, activeMode, file, onDraftChange]);
  useEffect(() => {
    if (!initialDraft?.photo) return;
    const url = URL.createObjectURL(initialDraft.photo);
    // Blob URLs must be created/revoked after hydration, never during server rendering.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [initialDraft?.photo]);

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
    const activeKeys = activeLookupKeysRef.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      if (noteLookupTimerRef.current !== null) {
        window.clearTimeout(noteLookupTimerRef.current);
        noteLookupTimerRef.current = null;
      }
      activeKeys.clear();
      analyzeAbortRef.current?.abort("unmount");
      editAbortRef.current.abort();
    };
  }, []);

  useEffect(() => {
    const nextNote = mealNote ?? null;
    if (nextNote === prevMealNoteRef.current) return;
    prevMealNoteRef.current = nextNote;

    if (noteLookupTimerRef.current !== null) {
      window.clearTimeout(noteLookupTimerRef.current);
      noteLookupTimerRef.current = null;
    }
    const revision = ++noteLookupRevisionRef.current;
    if (stage !== "result" || initialProviderMode !== "live" || activeMode === "demo") {
      if (activeLookupKeysRef.current.delete("__meal_note__")) {
        setPendingEditLookups(activeLookupKeysRef.current.size);
      }
      return;
    }

    const candidates = itemsRef.current.flatMap((item) => {
      if (!hasKnownPortion(item) || !item.displayName.trim()) return [];
      if (
        item.userMilkTypeChoice ||
        item.suspectedDuplicateMilk === true ||
        contradictoryDairyMilkLabel(item, plantMilkContext) ||
        photoGenericMilkNeedsConfirmation(item, plantMilkContext)
      ) {
        return [];
      }
      const freshLocal = nutritionProvider.resolve(item, plantMilkContext);
      const hadCatalog = Boolean(item.nutritionMatch?.profile?.id.startsWith(CATALOG_PROFILE_ID_PREFIX));
      if (!hadCatalog && !needsServerCatalogCheck(item, freshLocal, plantMilkContext)) return [];
      return [{ id: item.id, food: item, freshLocal }];
    });

    if (candidates.length === 0) {
      if (activeLookupKeysRef.current.delete("__meal_note__")) {
        setPendingEditLookups(activeLookupKeysRef.current.size);
      }
      return;
    }

    activeLookupKeysRef.current.add("__meal_note__");
    setPendingEditLookups(activeLookupKeysRef.current.size);
    noteLookupTimerRef.current = window.setTimeout(() => {
      noteLookupTimerRef.current = null;
      const signal = editAbortRef.current.signal;
      void enrichUnresolvedMatches(
        candidates.map((c) => c.food),
        candidates.map((c) => c.freshLocal),
        signal,
        plantMilkContext,
      )
        .then((resolvedMatches) => {
          if (signal.aborted || noteLookupRevisionRef.current !== revision) return;
          const byId = new Map(candidates.map((c, idx) => [c.id, { food: c.food, match: resolvedMatches[idx] ?? c.freshLocal }]));
          setItems((current) => current.map((item) => {
            const entry = byId.get(item.id);
            if (!entry) return item;
            if (item.displayName !== entry.food.displayName || item.unit !== entry.food.unit) return item;
            if (item.userMilkTypeChoice || item.suspectedDuplicateMilk === true) return item;
            if (contradictoryDairyMilkLabel(item, mealContextRef.current)) return item;
            if (photoGenericMilkNeedsConfirmation(item, mealContextRef.current)) return item;
            return {
              ...item,
              normalizedName: normalizedNameForMatch(item.displayName, entry.match),
              nutritionMatch: entry.match,
            };
          }));
        })
        .catch(() => {})
        .finally(() => {
          if (noteLookupRevisionRef.current === revision && activeLookupKeysRef.current.delete("__meal_note__")) {
            setPendingEditLookups(activeLookupKeysRef.current.size);
          }
        });
    }, 350);
  }, [mealNote, stage, initialProviderMode, activeMode, plantMilkContext, nutritionProvider]);

  const handleFileSelected = (nextFile: File | null) => {
    analyzeAbortRef.current?.abort("superseded");
    analyzeAbortRef.current = null;
    editAbortRef.current.abort();
    editAbortRef.current = new AbortController();
    for (const timer of nameEditTimers.current.values()) {
      window.clearTimeout(timer);
    }
    nameEditTimers.current.clear();
    if (noteLookupTimerRef.current !== null) {
      window.clearTimeout(noteLookupTimerRef.current);
      noteLookupTimerRef.current = null;
    }
    activeLookupKeysRef.current.clear();
    setPendingEditLookups(0);
    setAppError(null);
    setNutritionPending(false);
    setPreviewFailed(false);
    setAnalysis(null);
    setAnalysisProvenance(null);
    setItems([]);

    if (!nextFile) {
      onPhotoSelected?.(null);
      setFile(null);
      setPreviewUrl(null);
      setStage("input");
      return;
    }
    if (nextFile.size === 0 || !inferSupportedImageMimeType(nextFile.name, nextFile.type)) {
      onPhotoSelected?.(null);
      setFile(null);
      setPreviewUrl(null);
      setAppError(getError("invalid_file"));
      setStage("input");
      return;
    }
    if (nextFile.size > MAX_IMAGE_BYTES) {
      onPhotoSelected?.(null);
      setFile(null);
      setPreviewUrl(null);
      setAppError(getError("file_too_large"));
      setStage("input");
      return;
    }

    try {
      setPreviewUrl(URL.createObjectURL(nextFile));
    } catch {
      onPhotoSelected?.(null);
      setFile(null);
      setPreviewUrl(null);
      setPreviewFailed(true);
      setAppError(getError("image_read_failed"));
      setStage("input");
      return;
    }

    setFile(nextFile);
    onPhotoSelected?.(nextFile);
    setStage("input");
  };

  const cancelAnalyze = () => {
    analyzeAbortRef.current?.abort("cancelled");
    analyzeAbortRef.current = null;
    setStage("input");
    setAppError(null);
  };

  const analyze = async (forceDemo = false) => {
    if (analyzeAbortRef.current) return;
    if (!file) {
      setAppError(getError("missing_image"));
      setStage("input");
      return;
    }

    const controller = new AbortController();
    analyzeAbortRef.current = controller;

    const demoRequest = initialProviderMode === "demo" || forceDemo;
    setActiveMode(demoRequest ? "demo" : "live");
    setStage("analyzing");
    setAppError(null);
    setNutritionPending(false);

    const timeoutId = window.setTimeout(
      () => controller.abort("timeout"),
      OPENAI_HTTP_TIMEOUT_MS,
    );

    try {
      let body: AnalyzeResponse;
      if (demoRequest) {
        let demoProvenance: AnalysisProvenanceMetadata | null = null;
        await delay(DEMO_ANALYZE_DELAY_MS, controller.signal);
        const demoAnalysis = await new DemoFoodVisionProvider().analyzeImage(
          { data: "", mimeType: "image/jpeg" },
          {
            signal: controller.signal,
            onMetadata: (metadata) => {
              demoProvenance = metadata;
            },
          },
        );
        controller.signal.throwIfAborted();
        if (analyzeAbortRef.current !== controller) return;
        body = {
          analysis: preparePhotoMilkAnalysis(demoAnalysis),
          analysisProvenance: demoProvenance,
          mode: "demo",
        };
      } else {
        const formData = new FormData();
        formData.set("image", file);
        // One ID per explicit analysis action. Transport replays of this POST
        // must not reserve or invoke the paid provider a second time.
        formData.set("attemptId", crypto.randomUUID());
        if (new URLSearchParams(window.location.search).get("qaSuspectedMilk") === "1") {
          formData.set("qaSuspectedMilk", "1");
        }

        const response = await authorizedFetch("/api/analyze", {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
        body = (await response.json()) as AnalyzeResponse;
        controller.signal.throwIfAborted();
        if (analyzeAbortRef.current !== controller) return;

        if (!response.ok) {
          const code = typeof body.error?.code === "string" ? body.error.code : "unknown";
          throw getError(code);
        }
      }

      const parsed = foodAnalysisSchema.safeParse(body.analysis);
      if (!parsed.success) throw getError("invalid_response");
      const recognized = preparePhotoMilkAnalysis(parsed.data);

      const responseMode = body.mode === "live" ? "live" : "demo";
      setActiveMode(responseMode);
      setAnalysis(recognized);
      setAnalysisProvenance(readAnalysisProvenance(body.analysisProvenance, responseMode));

      if (recognized.analysisStatus === "unable_to_identify") {
        setItems([]);
        setStage("unable");
      } else {
        const photoContext = mealPlantMilkContext({ analysis: recognized, mealNote: mealContextRef.current.mealNote });
        const photoFoods = recognized.foods.map((food) => ({ ...food, entrySource: "photo" as const }));
        const localMatches = photoFoods.map((food) =>
          hasKnownPortion(food) ? nutritionProvider.resolve(food, photoContext) : null,
        );
        const initialItems = createEditableFoodItems(recognized.foods, localMatches)
          .map((item) => ({ ...item, entrySource: "photo" as const }));
        setItems(initialItems);
        setStage("result");
        const knownFoods = photoFoods.flatMap((food, index) =>
          hasKnownPortion(food) && localMatches[index] && !photoGenericMilkNeedsConfirmation(food, photoContext)
            && food.suspectedDuplicateMilk !== true
            ? [{ index, food, match: localMatches[index]! }] : [],
        );
        if (
          responseMode === "live" &&
          knownFoods.some((entry) => needsServerCatalogCheck(entry.food, entry.match, photoContext))
        ) {
          setNutritionPending(true);
          const unchangedFood = (item: EditableFoodItem, index: number) => {
            const original = initialItems[index];
            return Boolean(
              original && item.id === original.id &&
              item.displayName === original.displayName &&
              item.normalizedName === original.normalizedName &&
              item.unit === original.unit &&
              item.nutritionMatch === localMatches[index]
            );
          };
          const editSignal = editAbortRef.current.signal;
          const nutritionController = new AbortController();
          const nutritionSignal = AbortSignal.any([editSignal, nutritionController.signal]);
          const nutritionTimeoutId = window.setTimeout(
            () => {
              nutritionController.abort("timeout");
              if (editSignal.aborted) return;
              setItems((current) => current.map((item, index) => {
                const match = localMatches[index];
                const food = photoFoods[index];
                if (!match || match.includedInTotal || !unchangedFood(item, index)) return item;
                if (food?.suspectedDuplicateMilk === true) return item;
                if (food && photoGenericMilkNeedsConfirmation(food, photoContext)) return item;
                return {
                  ...item,
                  nutritionMatch: {
                    ...match,
                    reasons: [copy.nutritionLookupFailed,
                      ...match.reasons.filter((reason) => reason !== copy.nutritionLookupFailed)],
                  },
                };
              }));
              setNutritionPending(false);
            },
            NUTRITION_ENRICH_TIMEOUT_MS,
          );
          void enrichUnresolvedMatches(
            knownFoods.map(entry => entry.food),
            knownFoods.map(entry => entry.match),
            nutritionSignal,
            photoContext,
          )
            .then((matches) => {
              if (nutritionSignal.aborted) return;
              setItems((current) => current.map((item, index) => {
                const knownIndex = knownFoods.findIndex(entry => entry.index === index);
                if (knownIndex < 0 || !unchangedFood(item, index) ||
                    matches[knownIndex] === localMatches[index]) return item;
                if (item.userMilkTypeChoice) return item;
                if (item.suspectedDuplicateMilk === true) return item;
                if (contradictoryDairyMilkLabel(item, mealContextRef.current)) return item;
                if (photoGenericMilkNeedsConfirmation(item, mealContextRef.current)) return item;
                return { ...item, nutritionMatch: matches[knownIndex] };
              }));
            })
            .catch(() => {})
            .finally(() => {
              window.clearTimeout(nutritionTimeoutId);
              if (!editSignal.aborted) setNutritionPending(false);
            });
        }
      }
    } catch (error) {
      if (analyzeAbortRef.current !== controller) return;
      if (controller.signal.aborted) {
        if (analyzeAbortOutcome(controller.signal.reason) === "timeout") {
          setAppError(getError("network_timeout"));
          setStage("error");
        }
        return;
      }

      const safeError =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? getError(error.code)
          : getError("unknown");
      setAppError(safeError);
      setStage("error");
    } finally {
      window.clearTimeout(timeoutId);
      if (analyzeAbortRef.current === controller) {
        analyzeAbortRef.current = null;
      }
    }
  };

  const reset = () => {
    if (onExit) { onExit(); return; }
    editAbortRef.current.abort();
    editAbortRef.current = new AbortController();
    analyzeAbortRef.current?.abort("cancelled");
    analyzeAbortRef.current = null;
    for (const timer of nameEditTimers.current.values()) {
      window.clearTimeout(timer);
    }
    nameEditTimers.current.clear();
    if (noteLookupTimerRef.current !== null) {
      window.clearTimeout(noteLookupTimerRef.current);
      noteLookupTimerRef.current = null;
    }
    activeLookupKeysRef.current.clear();
    setPendingEditLookups(0);
    setStage("input");
    setFile(null);
    setPreviewUrl(null);
    setPreviewFailed(false);
    setAnalysis(null);
    setAnalysisProvenance(null);
    setItems([]);
    setAppError(null);
    setNutritionPending(false);
    setActiveMode(initialProviderMode);
  };

  const startManual = () => {
    setAnalysis(null);
    setAnalysisProvenance(null);
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

  const invalidateNameLookup = (id: string) => {
    const timer = nameEditTimers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      nameEditTimers.current.delete(id);
    }
    if (activeLookupKeysRef.current.delete(id)) {
      setPendingEditLookups(activeLookupKeysRef.current.size);
    }
    const revision = (nameEditRevisions.current.get(id) ?? 0) + 1;
    nameEditRevisions.current.set(id, revision);
    return revision;
  };

  const scheduleItemServerLookup = (
    id: string,
    targetFood: EditableFoodItem & { portionMin: number; portionMax: number },
    localMatch: NutritionMatch,
    revision: number,
    debounceMs: number,
  ) => {
    activeLookupKeysRef.current.add(id);
    setPendingEditLookups(activeLookupKeysRef.current.size);

    const run = () => {
      nameEditTimers.current.delete(id);
      const signal = editAbortRef.current.signal;
      void resolveNutritionMatchWithFallback(targetFood, localMatch, signal, mealContextRef.current)
        .then((resolvedMatch) => {
          if (signal.aborted || nameEditRevisions.current.get(id) !== revision) return;
          updateItem(id, (item) => {
            if (item.displayName !== targetFood.displayName || item.unit !== targetFood.unit) return item;
            if (item.userMilkTypeChoice) return item;
            if (item.suspectedDuplicateMilk === true) return item;
            if (contradictoryDairyMilkLabel(item, mealContextRef.current)) return item;
            return {
              ...item,
              normalizedName: normalizedNameForMatch(item.displayName, resolvedMatch),
              nutritionMatch: resolvedMatch,
            };
          });
        })
        .catch(() => {})
        .finally(() => {
          if (nameEditRevisions.current.get(id) === revision && activeLookupKeysRef.current.delete(id)) {
            setPendingEditLookups(activeLookupKeysRef.current.size);
          }
        });
    };

    if (debounceMs > 0) {
      const timer = window.setTimeout(run, debounceMs);
      nameEditTimers.current.set(id, timer);
    } else {
      run();
    }
  };

  const handleNameChange = (id: string, name: string, milkChoice?: Exclude<PhotoMilkChoiceId, "other">) => {
    const revision = invalidateNameLookup(id);
    const currentItem = items.find((item) => item.id === id);
    if (!currentItem) return;
    const seeded = milkChoice
      ? { ...currentItem, userMilkTypeChoice: milkChoice, otherMilkNotice: undefined }
      : { ...currentItem, userMilkTypeChoice: undefined, otherMilkNotice: undefined };
    const renamed = renameFoodItem(seeded, name, originalFoods.get(id) ?? initialDraft?.originalItems.find(food => food.id === id));
    const nextFood = {
      ...renamed,
      uncertaintyReasons: renamed.uncertaintyReasons.filter((reason) => reason !== PHOTO_MILK_OTHER_REASON),
    };
    const cachedMatch = hasKnownPortion(currentItem) && hasKnownPortion(nextFood) && canReuseNutritionMatchForNameEdit(
      currentItem,
      nextFood,
      currentItem.nutritionMatch,
    )
      ? currentItem.nutritionMatch
      : null;
    const localMatch = name.trim() && hasKnownPortion(nextFood)
      ? nutritionProvider.resolve(nextFood, mealContextRef.current)
      : null;
    const match = cachedMatch ?? localMatch;

    updateItem(id, () => ({
      ...nextFood,
      normalizedName: normalizedNameForMatch(name, match),
      nutritionMatch: match,
    }));

    if (
      initialProviderMode !== "live" ||
      activeMode === "demo" ||
      !localMatch ||
      cachedMatch ||
      !hasKnownPortion(nextFood) ||
      !needsServerCatalogCheck(nextFood, localMatch, mealContextRef.current)
    ) {
      return;
    }

    scheduleItemServerLookup(id, nextFood, localMatch, revision, 350);
  };

  const handleMilkChoice = (id: string, choiceId: PhotoMilkChoiceId) => {
    const choice = PHOTO_MILK_CHOICES.find((item) => item.id === choiceId);
    if (!choice) return;
    if (choice.id === "other") {
      updateItem(id, (item) => {
        const next = {
          ...item,
          userMilkTypeChoice: "other" as const,
          otherMilkNotice: PHOTO_MILK_OTHER_REASON,
          uncertaintyReasons: item.uncertaintyReasons.filter((reason) => reason !== PHOTO_MILK_OTHER_REASON),
        };
        return {
          ...next,
          nutritionMatch: hasKnownPortion(next)
            ? nutritionProvider.resolve(next, mealContextRef.current)
            : item.nutritionMatch,
        };
      });
      return;
    }
    handleNameChange(id, choice.displayName, choice.id);
  };

  const handleConfirmSeparateMilk = (id: string) => {
    updateItem(id, (item) => {
      if (item.suspectedDuplicateMilk !== true) return item;
      const next: EditableFoodItem = { ...item };
      delete next.suspectedDuplicateMilk;
      return {
        ...next,
        nutritionMatch: hasKnownPortion(next)
          ? nutritionProvider.resolve(next, mealContextRef.current)
          : null,
      };
    });
  };

  const handlePortionChange = (
    id: string,
    field: "portionMin" | "portionMax",
    value: number | null,
  ) => {
    if (value !== null && (!Number.isFinite(value) || value <= 0)) return;
    const currentItem = items.find((item) => item.id === id);
    if (!currentItem) return;
    if (value === null) {
      invalidateNameLookup(id);
      updateItem(id, (item) => ({
        ...item,
        portionMin: null,
        portionMax: null,
        originalPortionMin: null,
        originalPortionMax: null,
        nutritionMatch: null,
      }));
      return;
    }

    const hadPendingLookup = nameEditTimers.current.has(id) || activeLookupKeysRef.current.has(id);
    const hadKnownPortion = hasKnownPortion(currentItem);
    const portionMin = field === "portionMin" ? value : Math.min(value, currentItem.portionMin ?? value);
    const portionMax = field === "portionMin" ? Math.max(value, currentItem.portionMax ?? value) : value;
    const piecePackBoundaryCrossed =
      currentItem.unit === "piece" &&
      Boolean(currentItem.nutritionMatch?.profile?.id.startsWith(CATALOG_PROFILE_ID_PREFIX)) &&
      currentItem.portionMax !== null &&
      (currentItem.portionMax > 1) !== (portionMax > 1);

    const nextFood = {
      ...currentItem,
      portionMin,
      portionMax,
      originalPortionMin: portionMin,
      originalPortionMax: portionMax,
    };
    const shouldRecomputeMatch =
      !currentItem.nutritionMatch || !hadKnownPortion || piecePackBoundaryCrossed || hadPendingLookup;
    const localMatch = nextFood.displayName.trim()
      ? nutritionProvider.resolve(nextFood, mealContextRef.current)
      : null;
    const nextMatch = shouldRecomputeMatch ? localMatch : currentItem.nutritionMatch;

    updateItem(id, () => ({
      ...nextFood,
      nutritionMatch: nextMatch,
    }));

    if (
      !shouldRecomputeMatch ||
      initialProviderMode !== "live" ||
      activeMode === "demo" ||
      !localMatch ||
      !needsServerCatalogCheck(nextFood, localMatch, mealContextRef.current)
    ) {
      if (hadPendingLookup) invalidateNameLookup(id);
      return;
    }

    const revision = invalidateNameLookup(id);
    scheduleItemServerLookup(id, nextFood, localMatch, revision, 250);
  };

  const handleUnitChange = (id: string, unit: PortionUnit) => {
    const revision = invalidateNameLookup(id);
    const currentItem = items.find((item) => item.id === id);
    if (!currentItem) return;
    const profile =
      currentItem.nutritionMatch?.profile ??
      nutritionProvider.findByName(currentItem.normalizedName) ??
      nutritionProvider.findByName(currentItem.displayName);
    const converted = convertPortionUnit(currentItem, unit, profile);
    const keepsExistingProfile = Boolean(
      currentItem.nutritionMatch?.includedInTotal &&
      currentItem.nutritionMatch.profile?.gramsPerUnit[unit],
    );
    const localMatch = keepsExistingProfile
      ? currentItem.nutritionMatch
      : converted.displayName.trim() && hasKnownPortion(converted)
        ? nutritionProvider.resolve(converted, mealContextRef.current)
        : null;

    updateItem(id, () => ({
      ...converted,
      nutritionMatch: localMatch,
    }));

    if (
      keepsExistingProfile ||
      initialProviderMode !== "live" ||
      activeMode === "demo" ||
      !localMatch ||
      !hasKnownPortion(converted) ||
      !needsServerCatalogCheck(converted, localMatch, mealContextRef.current)
    ) {
      return;
    }

    scheduleItemServerLookup(id, converted, localMatch, revision, 0);
  };

  const handlePreset = (id: string, preset: PortionPreset) => {
    const currentItem = items.find((item) => item.id === id);
    if (!currentItem) return;
    const hadPendingLookup = nameEditTimers.current.has(id) || activeLookupKeysRef.current.has(id);
    const hadKnownPortion = hasKnownPortion(currentItem);
    const nextFood = applyPortionPreset(currentItem, preset);
    const piecePackBoundaryCrossed =
      nextFood.unit === "piece" &&
      Boolean(currentItem.nutritionMatch?.profile?.id.startsWith(CATALOG_PROFILE_ID_PREFIX)) &&
      currentItem.portionMax !== null &&
      nextFood.portionMax !== null &&
      (currentItem.portionMax > 1) !== (nextFood.portionMax > 1);

    const shouldRecomputeMatch =
      !currentItem.nutritionMatch || !hadKnownPortion || piecePackBoundaryCrossed || hadPendingLookup;
    const localMatch = nextFood.displayName.trim() && hasKnownPortion(nextFood)
      ? nutritionProvider.resolve(nextFood, mealContextRef.current)
      : null;

    updateItem(id, () => ({
      ...nextFood,
      nutritionMatch: shouldRecomputeMatch ? localMatch : currentItem.nutritionMatch,
    }));

    if (
      !shouldRecomputeMatch ||
      initialProviderMode !== "live" ||
      activeMode === "demo" ||
      !localMatch ||
      !hasKnownPortion(nextFood) ||
      !needsServerCatalogCheck(nextFood, localMatch, mealContextRef.current)
    ) {
      if (hadPendingLookup) invalidateNameLookup(id);
      return;
    }

    const revision = invalidateNameLookup(id);
    scheduleItemServerLookup(id, nextFood, localMatch, revision, 250);
  };

  return (
    <div className="app-shell">
      {!onExit && <SiteHeader mode={activeMode} />}
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
            <HeroCopy />
          </section>
          <HowItWorks />
          <button className="button button-secondary" type="button" onClick={startManual}>手動加入食物</button>
        </main>
      ) : null}

      {stage === "analyzing" ? (
        <LoadingView
          previewUrl={previewUrl}
          previewFailed={previewFailed}
          isHeic={isHeicFile(file?.name ?? "", file?.type)}
          demoMode={activeMode === "demo"}
          onCancel={cancelAnalyze}
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
          items={guardedItems}
          mode={activeMode}
          nutritionPending={effectiveNutritionPending}
          calorieCorrection={calorieCorrection}
          previewUrl={previewUrl}
          previewFailed={previewFailed}
          isHeic={isHeicFile(file?.name ?? "", file?.type)}
          onNameChange={handleNameChange}
          onPortionChange={handlePortionChange}
          onUnitChange={handleUnitChange}
          onPreset={handlePreset}
          onDelete={(id) => {
            invalidateNameLookup(id);
            setItems((current) => current.filter((item) => item.id !== id));
          }}
          onMilkChoice={handleMilkChoice}
          onConfirmSeparateMilk={handleConfirmSeparateMilk}
          onAdd={() => setItems((current) => [...current, createManualItem()])}
          onReset={onNewMeal ?? reset}
        />
      ) : null}

      {!onExit && <SiteFooter />}
    </div>
  );
}
