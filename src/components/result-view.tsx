"use client";

import { useMemo } from "react";
import { confidenceCopy, copy } from "@/content/zh-HK";
import {
  collectUncertaintyReasons,
} from "@/lib/domain/confidence";
import { mealShowsTotal } from "@/lib/nutrition/calculation";
import type { NutritionConfidence } from "@/lib/nutrition/types";
import type { FoodAnalysis, ObservedFood, PortionUnit } from "@/lib/domain/food-analysis";
import { createEditableFoodItems, type EditableFoodItem, type PortionPreset } from "@/lib/domain/editable-meal";
import { normalizeFoodName } from "@/lib/nutrition/canonical";
import {
  roundRange,
  type NutrientRange,
} from "@/lib/nutrition/calculation";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { NutritionService } from "@/lib/nutrition/service";
import { AlertIcon, CheckIcon, PlusIcon, RefreshIcon, ShieldIcon } from "./icons";
import { FoodEditor, type RecognitionBadge } from "./food-editor";
import { ImagePreviewFallback } from "./image-preview-fallback";
import { mealCalories, type MealCalorieCorrection } from "@/lib/meals/calories";

interface ResultViewProps {
  analysis: FoodAnalysis | null;
  items: EditableFoodItem[];
  mode: "live" | "demo" | "manual";
  nutritionPending?: boolean;
  calorieCorrection?: MealCalorieCorrection | null;
  previewUrl: string | null;
  previewFailed: boolean;
  isHeic: boolean;
  onNameChange: (id: string, name: string) => void;
  onPortionChange: (
    id: string,
    field: "portionMin" | "portionMax",
    value: number | null,
  ) => void;
  onUnitChange: (id: string, unit: PortionUnit) => void;
  onPreset: (id: string, preset: PortionPreset) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onReset: () => void;
}

interface FoodRecognition extends RecognitionBadge {
  originalFood?: ObservedFood;
}

function foodRecognition(
  item: EditableFoodItem,
  originalFood: ObservedFood | undefined,
  mode: ResultViewProps["mode"],
): FoodRecognition {
  if (mode === "manual" || item.id.startsWith("manual-")) return { label: "手動輸入" };
  if (mode === "demo") return { label: "示範資料" };
  if (!originalFood) return { label: "未有 AI 辨認資料" };
  if (
    normalizeFoodName(item.displayName) !== normalizeFoodName(originalFood.displayName) ||
    item.identityLevel !== originalFood.identityLevel
  ) return { label: "已手動修正" };

  // The model's self-reported score has not been calibrated against real photos.
  // Keep it in the original analysis, but do not present it as accuracy proof.
  return { label: `${copy.recognitionLabel}：請核對`, originalFood };
}

function displayRange(range: NutrientRange, increment = 1): string {
  const rounded = roundRange(range, increment);
  return `${rounded.min}–${rounded.max}`;
}

function weakestNutritionConfidence(
  meal: ReturnType<NutritionService["calculateMeal"]>,
): NutritionConfidence | "none" {
  const included = meal.foods
    .map((item) => item.match)
    .filter((match) => match?.includedInTotal);
  if (included.length === 0) return "none";
  if (included.some((match) => match?.confidence === "low")) return "low";
  if (included.some((match) => match?.confidence === "medium")) return "medium";
  return "high";
}

function nutritionSources(
  meal: ReturnType<NutritionService["calculateMeal"]>,
): string[] {
  const names = meal.foods
    .map((item) => item.profile?.source.sourceName)
    .filter((name): name is string => Boolean(name));
  return [...new Set(names)];
}

export function ResultView({
  analysis,
  items,
  mode,
  nutritionPending = false,
  calorieCorrection,
  previewUrl,
  previewFailed,
  isHeic,
  onNameChange,
  onPortionChange,
  onUnitChange,
  onPreset,
  onDelete,
  onAdd,
  onReset,
}: ResultViewProps) {
  const provider = useMemo(() => new LocalNutritionProvider(), []);
  const service = useMemo(() => new NutritionService(provider), [provider]);
  const meal = useMemo(() => service.calculateMeal(items), [items, service]);
  const originalFoods = useMemo(
    () => new Map(createEditableFoodItems(analysis?.foods ?? []).map(food => [food.id, food])),
    [analysis],
  );
  const recognitionSources = items.map(item => foodRecognition(item, originalFoods.get(item.id), mode));
  const aiFoods = recognitionSources.flatMap(source => source.originalFood ? [source.originalFood] : []);
  const recognitionLabel = aiFoods.length === 0 ? "食物來源" : copy.recognitionLabel;
  const recognitionSummary = aiFoods.length > 0
    ? `請逐項核對${aiFoods.length < items.length ? `（${aiFoods.length} / ${items.length} 項為 AI 建議）` : ""}`
    : [...new Set(recognitionSources.map(source => source.label))].join("／") || "未有 AI 辨認資料";
  const nutritionConfidence = weakestNutritionConfidence(meal);
  const unknownPortion = items.some(item => item.portionMin === null || item.portionMax === null);
  const showTotal = !unknownPortion && mealShowsTotal(meal.coverage);
  const calories = roundRange(meal.totals.calories, 5);
  const finalCalories = mealCalories({ items, mode, calorieCorrection });
  const manualCalories = finalCalories.source === "user" ? finalCalories.range : null;
  const midpoint = Math.round(meal.midpointCalories / 5) * 5;
  const uncertainties = analysis
    ? collectUncertaintyReasons({ ...analysis, foods: items })
    : ["手動輸入未能確認實際重量、隱藏材料及烹調用油。"];

  return (
    <main className="result-page" id="main-content">
      <section className="result-hero" aria-labelledby="result-title">
        <div className="result-hero-copy">
          <p className="eyebrow">{manualCalories ? "本餐卡路里" : copy.resultEyebrow}</p>
          {manualCalories ? (
            <h1 id="result-title">手動記錄：<span>{manualCalories.min}</span> kcal</h1>
          ) : showTotal && !finalCalories.invalidCorrection ? (
            <h1 id="result-title">
              約 <span>{calories.min}–{calories.max}</span> kcal
            </h1>
          ) : (
            <h1 id="result-title" className="no-total">
              暫未能計算
            </h1>
          )}
          {manualCalories ? (
            <p className="midpoint">{showTotal ? `參考估算：約 ${calories.min}–${calories.max} kcal` : "營養參考不足；手動卡路里不代表營養素已確認。"}</p>
          ) : finalCalories.invalidCorrection ? (
            <p className="midpoint" role="alert">已存的手動卡路里無效，請重新填寫或恢復參考估算。</p>
          ) : showTotal ? (
            <p className="midpoint">中間估算：約 {midpoint} kcal</p>
          ) : null}
        </div>
        <div className={`mode-chip mode-${mode}`}>
          {mode === "demo"
            ? "示範結果"
            : mode === "manual"
              ? "手動輸入"
              : "AI 分析結果"}
        </div>
      </section>

      <div className="result-grid">
        <div className="result-main-column">
          {nutritionPending ? (
            <p className="coverage-notice" role="status">
              <RefreshIcon />
              AI 辨認已完成，正在補查營養參考；你可以先修正餐點。
            </p>
          ) : null}
          {showTotal ? (
            <section className="macro-grid" aria-label="主要營養素估算範圍" aria-live="polite">
              <div className="macro-card macro-protein">
                <span>Protein</span>
                <strong>{displayRange(meal.totals.protein)}g</strong>
                <small>蛋白質</small>
              </div>
              <div className="macro-card macro-carbs">
                <span>Carbs</span>
                <strong>{displayRange(meal.totals.carbs)}g</strong>
                <small>碳水化合物</small>
              </div>
              <div className="macro-card macro-fat">
                <span>Fat</span>
                <strong>{displayRange(meal.totals.fat)}g</strong>
                <small>脂肪</small>
              </div>
            </section>
          ) : null}

          <section
            className={`confidence-panel ${nutritionConfidence === "none" ? "confidence-panel-low" : ""}`}
          >
            <div className="confidence-icon">
              {aiFoods.length > 0 || nutritionConfidence === "none" ? (
                <AlertIcon />
              ) : (
                <CheckIcon />
              )}
            </div>
            <div className="confidence-split">
              <span>{recognitionLabel}</span>
              <strong>{recognitionSummary}</strong>
              <span>{copy.nutritionLabel}</span>
              <strong>
                {nutritionConfidence === "none"
                  ? copy.nutritionUnavailable
                  : meal.coverage === "complete"
                    ? confidenceCopy[nutritionConfidence]
                    : `${copy.nutritionIncomplete}（${meal.includedCount} / ${meal.totalCount}）`}
              </strong>
            </div>
          </section>

          {meal.coverage === "partial" ? (
            <p className="coverage-notice" role="status">
              <AlertIcon />
              {copy.partialNutrition} 營養參考只包括 {meal.includedCount} / {meal.totalCount} 項有可靠營養資料的食物。
            </p>
          ) : null}
          {meal.coverage === "insufficient" ? (
            <p className="coverage-notice" role="status">
              <AlertIcon />
              {copy.insufficientNutrition} 目前有 {meal.includedCount} / {meal.totalCount} 項可配對。
            </p>
          ) : null}
          {meal.coverage === "none" ? (
            <p className="coverage-notice" role="status">
              <AlertIcon />
              {copy.noNutrition}
            </p>
          ) : null}

          <section className="breakdown-section" aria-labelledby="breakdown-title">
            <div className="section-heading-row">
              <div>
                <p className="eyebrow">逐項修正</p>
                <h2 id="breakdown-title">{copy.foodBreakdown}</h2>
                <p>{copy.foodBreakdownBody}</p>
              </div>
              <span className="item-count">{items.length} 項</span>
            </div>

            <datalist id="supported-foods">
              {provider.listFoods().map((food) => (
                <option key={food.id} value={food.displayName} />
              ))}
            </datalist>

            <div className="food-list">
              {items.map((item, index) => (
                <FoodEditor
                  key={item.id}
                  item={item}
                  calculation={meal.foods[index]}
                  recognition={recognitionSources[index]}
                  onNameChange={(name) => onNameChange(item.id, name)}
                  onPortionChange={(field, value) =>
                    onPortionChange(item.id, field, value)
                  }
                  onUnitChange={(unit) => onUnitChange(item.id, unit)}
                  onPreset={(preset) => onPreset(item.id, preset)}
                  onDelete={() => onDelete(item.id)}
                />
              ))}
            </div>

            <button className="button add-food-button" type="button" onClick={onAdd}>
              <PlusIcon />
              {copy.addFood}
            </button>
          </section>

          <section className="uncertainty-section" aria-labelledby="uncertainty-title">
            <div className="section-heading-row compact">
              <div>
                <p className="eyebrow">範圍背後</p>
                <h2 id="uncertainty-title">{copy.uncertaintyTitle}</h2>
              </div>
            </div>
            <ul className="reason-list">
              {uncertainties.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <details className="explain-details">
              <summary>{copy.whyRange}</summary>
              <p>{copy.whyRangeBody}</p>
            </details>
            {analysis &&
            (analysis.visibleEvidence.length > 0 ||
              analysis.estimatedInformation.length > 0) ? (
              <details className="explain-details evidence-details">
                <summary>{mode === "demo" ? "示範資料說明" : copy.evidenceTitle}</summary>
                <p>{mode === "demo"
                  ? "以下是示範資料，並非所選相片的 AI 分析。"
                  : "以下是原始 AI 分析，可能與你修正後的食物或份量不同。"}</p>
                {analysis.visibleEvidence.length > 0 ? (
                  <div>
                    <strong>{mode === "demo" ? "示範內容" : "AI 原判為相片可見"}</strong>
                    <ul>
                      {analysis.visibleEvidence.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {analysis.estimatedInformation.length > 0 ? (
                  <div>
                    <strong>{mode === "demo" ? "示範估算" : "AI 原始估算"}</strong>
                    <ul>
                      {analysis.estimatedInformation.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </details>
            ) : null}
          </section>
        </div>

        <aside className="result-sidebar" aria-label="相片及資料說明">
          {previewFailed ? (
            <div className="sidebar-photo-card">
              <ImagePreviewFallback isHeic={isHeic} compact />
              <button className="button button-secondary" type="button" onClick={onReset}>
                <RefreshIcon />
                {copy.newMeal}
              </button>
            </div>
          ) : previewUrl ? (
            <div className="sidebar-photo-card">
              {/* A local object URL is the appropriate preview source here. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="今次分析的餐點相片" />
              <button className="button button-secondary" type="button" onClick={onReset}>
                <RefreshIcon />
                {copy.newMeal}
              </button>
            </div>
          ) : (
            <button className="button button-secondary" type="button" onClick={onReset}>
              <RefreshIcon />
              {copy.newMeal}
            </button>
          )}

          <div className={`sidebar-note ${mode === "demo" ? "demo-note" : ""}`}>
            <strong>
              {mode === "demo"
                ? copy.demoTitle
                : mode === "manual"
                  ? copy.manualTitle
                  : copy.liveTitle}
            </strong>
            <p>
              {mode === "demo"
                ? copy.demoBody
                : mode === "manual"
                  ? copy.manualBody
                  : copy.liveBody}
            </p>
          </div>

          <div className="sidebar-note">
            <ShieldIcon />
            <strong>相片私隱</strong>
            <p>{copy.privacyShort}</p>
          </div>

          <div className="data-notice">
            <span>{copy.nutritionSourceTitle}</span>
            <p>
              {nutritionSources(meal).length > 0
                ? nutritionSources(meal).join("；")
                : copy.localNutritionNotice}
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
