"use client";

import { useId } from "react";
import { MAX_MANUAL_KCAL, type MealCalorieCorrection } from "@/lib/meals/calories";

interface Props {
  correction?: MealCalorieCorrection | null;
  input?: string;
  disabled?: boolean;
  onChange: (value: {
    calorieCorrection: MealCalorieCorrection | null;
    calorieInput: string | undefined;
  }) => void;
}

export function CalorieCorrectionInput({ correction, input, disabled, onChange }: Props) {
  const id = useId();
  const active = input !== undefined || correction != null;
  const raw = input ?? (correction ? String(correction.kcal) : "");
  const kcal = Number(raw);
  const storedValid = correction == null || (typeof correction.kcal === "number" && correction.source === "user");
  const valid = storedValid && raw.trim() !== "" && Number.isInteger(kcal) && kcal >= 0 && kcal <= MAX_MANUAL_KCAL;

  return (
    <section className="journal-card calorie-control" aria-label="本餐卡路里修正">
      <h2>本餐卡路里</h2>
      <p>可填寫包裝標示或你確認的整餐數值；不會改寫原始分析或營養參考。</p>
      {active ? (
        <>
          <label htmlFor={id}>
            手動卡路里（整餐 kcal）
            <input
              id={id}
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_MANUAL_KCAL}
              step={1}
              required
              disabled={disabled}
              value={raw}
              ref={(field) => { field?.setCustomValidity(valid ? "" : "請重新填寫 0 至 20,000 的整數，或恢復參考估算。"); }}
              aria-invalid={!valid}
              aria-describedby={`${id}-help${valid ? "" : ` ${id}-error`}`}
              onChange={(event) => {
                const value = event.target.value;
                const number = Number(value);
                onChange({
                  calorieInput: value,
                  calorieCorrection: value.trim() !== "" && Number.isInteger(number) && number >= 0 && number <= MAX_MANUAL_KCAL
                    ? { kcal: number, source: "user" }
                    : null,
                });
              }}
            />
          </label>
          <p id={`${id}-help`}>填寫整餐總數，並非每 100 g。更改食物或份量後，請重新確認手動卡路里。</p>
          {!valid && <p id={`${id}-error`} role="alert">請輸入 0 至 20,000 的整數；空白不代表零。</p>}
          <button className="button button-secondary" type="button" disabled={disabled} onClick={() => onChange({ calorieCorrection: null, calorieInput: undefined })}>
            恢復參考估算
          </button>
        </>
      ) : (
        <button className="button button-secondary" type="button" disabled={disabled} onClick={() => onChange({ calorieCorrection: null, calorieInput: "" })}>
          自行填寫本餐卡路里
        </button>
      )}
    </section>
  );
}
