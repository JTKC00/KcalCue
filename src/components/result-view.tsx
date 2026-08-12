"use client";

import { useMemo } from "react";
import { confidenceCopy, copy } from "@/content/zh-HK";
import {
  collectUncertaintyReasons,
  mealConfidence,
} from "@/lib/domain/confidence";
import type { FoodAnalysis, PortionUnit } from "@/lib/domain/food-analysis";
import type { EditableFoodItem, PortionPreset } from "@/lib/domain/editable-meal";
import {
  roundRange,
  type NutrientRange,
} from "@/lib/nutrition/calculation";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { NutritionService } from "@/lib/nutrition/service";
import { AlertIcon, CheckIcon, PlusIcon, RefreshIcon, ShieldIcon } from "./icons";
import { FoodEditor } from "./food-editor";

interface ResultViewProps {
  analysis: FoodAnalysis | null;
  items: EditableFoodItem[];
  mode: "live" | "demo" | "manual";
  previewUrl: string | null;
  onNameChange: (id: string, name: string) => void;
  onPortionChange: (
    id: string,
    field: "portionMin" | "portionMax",
    value: number,
  ) => void;
  onUnitChange: (id: string, unit: PortionUnit) => void;
  onPreset: (id: string, preset: PortionPreset) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onReset: () => void;
}

function displayRange(range: NutrientRange, increment = 1): string {
  const rounded = roundRange(range, increment);
  return `${rounded.min}–${rounded.max}`;
}

export function ResultView({
  analysis,
  items,
  mode,
  previewUrl,
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
  const confidence = mealConfidence(items);
  const calories = roundRange(meal.totals.calories, 5);
  const midpoint = Math.round(meal.midpointCalories / 5) * 5;
  const uncertainties = analysis
    ? collectUncertaintyReasons({ ...analysis, foods: items })
    : ["手動輸入未能確認實際重量、隱藏材料及烹調用油。"];

  return (
    <main className="result-page" id="main-content">
      <section className="result-hero" aria-labelledby="result-title">
        <div className="result-hero-copy">
          <p className="eyebrow">{copy.resultEyebrow}</p>
          {meal.coverage === "none" ? (
            <h1 id="result-title" className="no-total">
              暫未能計算
            </h1>
          ) : (
            <h1 id="result-title">
              約 <span>{calories.min}–{calories.max}</span> kcal
            </h1>
          )}
          {meal.coverage !== "none" ? (
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
          {meal.coverage !== "none" ? (
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

          <section className={`confidence-panel confidence-panel-${confidence}`}>
            <div className="confidence-icon">
              {confidence === "low" ? <AlertIcon /> : <CheckIcon />}
            </div>
            <div>
              <span>整體可信程度</span>
              <strong>{confidenceCopy[confidence]}</strong>
              {confidence === "low" ? <p>{copy.coarseEstimate}</p> : null}
            </div>
          </section>

          {meal.coverage === "partial" ? (
            <p className="coverage-notice" role="status">
              <AlertIcon />
              {copy.partialNutrition}
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
                <summary>{copy.evidenceTitle}</summary>
                {analysis.visibleEvidence.length > 0 ? (
                  <div>
                    <strong>相片可見</strong>
                    <ul>
                      {analysis.visibleEvidence.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {analysis.estimatedInformation.length > 0 ? (
                  <div>
                    <strong>估算資料</strong>
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
          {previewUrl ? (
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
            <span>資料來源</span>
            <p>{copy.localNutritionNotice}</p>
          </div>
        </aside>
      </div>
    </main>
  );
}
