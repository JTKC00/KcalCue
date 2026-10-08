"use client";

import { useState } from "react";

import { confidenceCopy, copy, unitCopy } from "@/content/zh-HK";
import {
  portionUnits,
  type PortionUnit,
} from "@/lib/domain/food-analysis";
import type { EditableFoodItem, PortionPreset } from "@/lib/domain/editable-meal";
import { roundRange, type CalculatedFood } from "@/lib/nutrition/calculation";
import { templateRangeNeedsFollowUp } from "@/lib/nutrition/recipe-templates";
import { MERGED_DUPLICATE_MILK_NOTICE } from "@/lib/domain/milk-dedupe";
import { photoGenericMilkNeedsConfirmation } from "@/lib/nutrition/canonical";
import { PHOTO_MILK_CHOICES, type PhotoMilkChoiceId } from "@/lib/nutrition/photo-milk";
import { PHOTO_MILK_OTHER_REASON } from "@/lib/nutrition/negative-rules";
import { portionValueAfterProgrammaticFill } from "./portion-fill";
import { TrashIcon } from "./icons";

export interface RecognitionBadge {
  label: string;
}

interface FoodEditorProps {
  item: EditableFoodItem;
  calculation: CalculatedFood;
  recognition: RecognitionBadge;
  onNameChange: (name: string) => void;
  onPortionChange: (field: "portionMin" | "portionMax", value: number | null) => void;
  onUnitChange: (unit: PortionUnit) => void;
  onPreset: (preset: PortionPreset) => void;
  onDelete: () => void;
  onMilkChoice?: (choice: PhotoMilkChoiceId) => void;
}

const presetLabels: Record<PortionPreset, string> = {
  small: "少",
  regular: "普通",
  large: "多",
};

function selectPortion(input: HTMLInputElement) {
  input.select();
}

function PortionInput({ id, value, onCommit }: { id: string; value: number | null; onCommit: (value: number | null) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const shown = editing ?? (value == null ? "" : String(value));
  return <><input id={id} type="number" inputMode="decimal" min="0.1" max="5000" step="any"
    value={shown} placeholder="未知" aria-invalid={error || undefined} aria-describedby={error ? `${id}-error` : undefined}
    onFocus={event => {
      event.currentTarget.dataset.portionOnFocus = event.currentTarget.value;
      selectPortion(event.currentTarget);
    }}
    onClick={event => { selectPortion(event.currentTarget); }}
    // A click otherwise drops the caret at the end, so the next digit appends to 150.
    onMouseUp={event => { event.preventDefault(); }}
    onChange={event => {
      const input = event.currentTarget;
      const native = event.nativeEvent;
      const inserted = native instanceof InputEvent ? native.data : null;
      const inputType = native instanceof InputEvent ? native.inputType : "";
      const next = portionValueAfterProgrammaticFill(
        input.dataset.portionOnFocus ?? "",
        input.value,
        inserted,
        inputType,
      );
      input.dataset.portionOnFocus = next;
      setEditing(next);
      setError(false);
    }}
    onBlur={event => {
      const raw = event.currentTarget.value;
      const number = Number(raw);
      if (!raw) { onCommit(null); setEditing(null); setError(false); return; }
      if (!Number.isFinite(number) || number < .1 || number > 5000) { setError(true); return; }
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
  recognition,
  onNameChange,
  onPortionChange,
  onUnitChange,
  onPreset,
  onDelete,
  onMilkChoice,
}: FoodEditorProps) {
  const nutrition = calculation.match;
  const fieldId = `food-${item.id}`;
  const choseOther = item.userMilkTypeChoice === "other"
    || item.otherMilkNotice === PHOTO_MILK_OTHER_REASON
    || item.uncertaintyReasons.includes(PHOTO_MILK_OTHER_REASON);
  const confirmMilk = photoGenericMilkNeedsConfirmation(item) && !choseOther;
  const mergedMilk = item.duplicateMilkNotice === MERGED_DUPLICATE_MILK_NOTICE
    || item.uncertaintyReasons.includes(MERGED_DUPLICATE_MILK_NOTICE);
  const otherUncertainty = item.uncertaintyReasons.find((reason) =>
    reason !== MERGED_DUPLICATE_MILK_NOTICE && reason !== PHOTO_MILK_OTHER_REASON);

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
        <span className="confidence-badge">
          {recognition.label}
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

      {confirmMilk ? (
        <fieldset className="preset-fieldset">
          <legend>請選擇這杯飲品的種類</legend>
          <div className="milk-choice-control">
            {PHOTO_MILK_CHOICES.map((choice) => (
              <button key={choice.id} type="button" onClick={() => onMilkChoice?.(choice.id)}>
                {choice.label}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}

      <fieldset className="preset-fieldset">
        <legend>快速調整份量</legend>
        <div className="segment-control">
          {(Object.keys(presetLabels) as PortionPreset[]).map((preset) => (
            <button key={preset} type="button" disabled={item.portionMin === null} onClick={() => onPreset(preset)}>
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

      {item.portionMin === null ? (
        <p className="food-uncertainty" role="status">請核對食物名稱；現有資料不足以判斷你吃了多少。可填寫份量；留空儲存時，本餐 kcal 會標示為未知。</p>
      ) : null}

      {templateRangeNeedsFollowUp(calculation.match?.profile) && calculation.includedInTotal ? (
        <p className="inline-warning" role="status">{copy.nutritionRangeFollowUp}</p>
      ) : null}

      {calculation.unavailableReason ? (
        <p className="inline-warning">{calculation.unavailableReason}</p>
      ) : nutrition?.reasons[0] ? (
        <p className="food-uncertainty">
          <span>營養：</span>
          {nutrition.reasons[0]}
        </p>
      ) : null}

      {choseOther && nutrition?.reasons[0] !== PHOTO_MILK_OTHER_REASON ? (
        <p className="food-uncertainty" role="status">{item.otherMilkNotice ?? PHOTO_MILK_OTHER_REASON}</p>
      ) : null}

      {mergedMilk ? (
        <p className="food-uncertainty" role="status">{MERGED_DUPLICATE_MILK_NOTICE}</p>
      ) : null}

      {otherUncertainty ? (
        <p className="food-uncertainty">
          <span>留意：</span>
          {otherUncertainty}
        </p>
      ) : null}
    </article>
  );
}
