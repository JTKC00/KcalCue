"use client";

import { useState } from "react";

import { confidenceCopy, copy, unitCopy } from "@/content/zh-HK";
import { confidenceLevel } from "@/lib/domain/confidence";
import {
  portionUnits,
  type PortionUnit,
} from "@/lib/domain/food-analysis";
import type { EditableFoodItem, PortionPreset } from "@/lib/domain/editable-meal";
import { roundRange, type CalculatedFood } from "@/lib/nutrition/calculation";
import { TrashIcon } from "./icons";

interface FoodEditorProps {
  item: EditableFoodItem;
  calculation: CalculatedFood;
  onNameChange: (name: string) => void;
  onPortionChange: (field: "portionMin" | "portionMax", value: number) => void;
  onUnitChange: (unit: PortionUnit) => void;
  onPreset: (preset: PortionPreset) => void;
  onDelete: () => void;
}

const presetLabels: Record<PortionPreset, string> = {
  small: "少",
  regular: "普通",
  large: "多",
};

function PortionInput({ id, value, onCommit }: { id: string; value: number; onCommit: (value: number) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState(false);
  return <><input id={id} type="number" inputMode="decimal" min="0.1" max="5000" step="any" required
    value={editing ?? value} aria-invalid={error || undefined} aria-describedby={error ? `${id}-error` : undefined}
    onChange={event => { setEditing(event.target.value); setError(false); }}
    onBlur={event => {
      const number = Number(event.target.value);
      if (!event.target.value || !Number.isFinite(number) || number < .1 || number > 5000) { setError(true); return; }
      onCommit(number); setEditing(null); setError(false);
    }} />{error && <small id={`${id}-error`} role="alert">請輸入 0.1 至 5000 的份量。</small>}</>;
}

function calorieRange(calculation: CalculatedFood): string {
  if (!calculation.ranges) return "暫未能計算";
  const calories = roundRange(calculation.ranges.calories, 5);
  return `約 ${calories.min}–${calories.max} kcal`;
}

export function FoodEditor({
  item,
  calculation,
  onNameChange,
  onPortionChange,
  onUnitChange,
  onPreset,
  onDelete,
}: FoodEditorProps) {
  const recognition = confidenceLevel(item.recognitionConfidence);
  const nutrition = calculation.match;
  const fieldId = `food-${item.id}`;

  return (
    <article className="food-card">
      <div className="food-card-heading">
        <div className="food-index" aria-hidden="true">
          {item.displayName.trim().slice(0, 1) || "＋"}
        </div>
        <div className="food-title-wrap">
          <label htmlFor={`${fieldId}-name`}>食物名稱</label>
          <input
            id={`${fieldId}-name`}
            className="food-name-input"
            list="supported-foods"
            value={item.displayName}
            placeholder="例如：白飯"
            autoComplete="off"
            required
            maxLength={80}
            onChange={(event) => onNameChange(event.currentTarget.value)}
          />
        </div>
        <button
          className="icon-button danger"
          type="button"
          aria-label={`刪除 ${item.displayName || "未命名食物"}`}
          title={copy.deleteFood}
          onClick={onDelete}
        >
          <TrashIcon />
        </button>
      </div>

      <div className="food-summary-line">
        <strong>{calorieRange(calculation)}</strong>
        <span className={`confidence-badge confidence-${recognition}`}>
          {copy.recognitionLabel}：{confidenceCopy[recognition]}
        </span>
        <span
          className={`confidence-badge confidence-${
            nutrition?.includedInTotal ? nutrition.confidence : "low"
          }`}
        >
          {copy.nutritionLabel}：
          {nutrition?.includedInTotal
            ? confidenceCopy[nutrition.confidence]
            : copy.nutritionUnavailable}
        </span>
      </div>

      <fieldset className="preset-fieldset">
        <legend>快速調整份量</legend>
        <div className="segment-control">
          {(Object.keys(presetLabels) as PortionPreset[]).map((preset) => (
            <button key={preset} type="button" onClick={() => onPreset(preset)}>
              {presetLabels[preset]}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="portion-fields">
        <div className="field-group">
          <label htmlFor={`${fieldId}-min`}>最少份量</label>
          <PortionInput
            id={`${fieldId}-min`}
            value={item.portionMin}
            onCommit={value => onPortionChange("portionMin", value)}
          />
        </div>
        <div className="range-divider" aria-hidden="true">
          至
        </div>
        <div className="field-group">
          <label htmlFor={`${fieldId}-max`}>最多份量</label>
          <PortionInput
            id={`${fieldId}-max`}
            value={item.portionMax}
            onCommit={value => onPortionChange("portionMax", value)}
          />
        </div>
        <div className="field-group unit-field">
          <label htmlFor={`${fieldId}-unit`}>單位</label>
          <select
            id={`${fieldId}-unit`}
            value={item.unit}
            onChange={(event) =>
              onUnitChange(event.currentTarget.value as PortionUnit)
            }
          >
            {portionUnits.map((unit) => (
              <option key={unit} value={unit}>
                {unitCopy[unit]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {calculation.unavailableReason ? (
        <p className="inline-warning">{calculation.unavailableReason}</p>
      ) : nutrition?.reasons[0] ? (
        <p className="food-uncertainty">
          <span>營養：</span>
          {nutrition.reasons[0]}
        </p>
      ) : null}

      {item.uncertaintyReasons.length > 0 ? (
        <p className="food-uncertainty">
          <span>留意：</span>
          {item.uncertaintyReasons[0]}
        </p>
      ) : null}
    </article>
  );
}
